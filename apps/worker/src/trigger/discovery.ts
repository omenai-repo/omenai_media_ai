import { chicagoDateKey, dailyRunKey } from '@repo/shared';
import {
  claimRun,
  completeTask,
  countRunEvaluations,
  discoveryEvaluatePayloadSchema,
  discoveryRunPayloadSchema,
  ensureTask,
  evaluateStory,
  failRun,
  failTask,
  finalizeRun,
  getLlmClient,
  getRun,
  getSearchClient,
  LlmError,
  markEvaluationFailed,
  objectId,
  prepareRun,
  readDiscoveryConfig,
  renewLease,
  SearchError,
  shouldCloseCandidateSet,
  startRun,
  startTaskAttempt,
  TASK_IDS,
  ConfigError,
  type DiscoveryConfig,
  type DiscoveryDeps,
} from '@repo/core';
import {
  AbortTaskRunError,
  idempotencyKeys,
  logger,
  schedules,
  task,
  wait,
} from '@trigger.dev/sdk';

const EVALUATE_MAX_ATTEMPTS = 5;
const POLL_SECONDS = 60;

function createDeps(): DiscoveryDeps {
  return {
    llm: getLlmClient(),
    search: getSearchClient(),
    config: readDiscoveryConfig(),
    now: () => new Date(),
  };
}

function leaseConfig(config: DiscoveryConfig) {
  return {
    leaseMs: config.leaseMinutes * 60_000,
    softDeadlineMinutes: config.softDeadlineMinutes,
    extensionDeadlineMinutes: config.extensionDeadlineMinutes,
    hardDeadlineMinutes: config.hardDeadlineMinutes,
  };
}

/** Errors no retry can fix: bad configuration or credentials, invalid requests, refusals. */
function isPermanent(error: unknown): boolean {
  if (error instanceof ConfigError) return true;
  if (error instanceof LlmError || error instanceof SearchError) return !error.retryable;
  return false;
}

/**
 * Evaluates one candidate story. Transient failures (rate limits, outages) are retried with
 * increasing delays, up to five attempts; permanent ones stop immediately. When attempts run out
 * the story is recorded as `evaluation_failed`, so the run accounts for it, and the other
 * candidates are unaffected.
 */
export const discoveryEvaluate = task({
  id: TASK_IDS.discoveryEvaluate,
  // Gentle on provider rate limits (especially free tiers).
  concurrency: { total: 3 },
  retry: {
    maxAttempts: EVALUATE_MAX_ATTEMPTS,
    factor: 2,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 120_000,
    randomize: true,
  },
  run: async (rawPayload: unknown, { ctx }) => {
    const { runKey, storyId } = discoveryEvaluatePayloadSchema.parse(rawPayload);
    const key = `discovery.evaluate:${runKey}:${storyId}`;
    await ensureTask({ key, kind: 'discovery.evaluate', runKey, storyId: objectId(storyId) });
    await startTaskAttempt(key, ctx.attempt.number, ctx.run.id);
    try {
      const result = await evaluateStory({ runKey, storyId, deps: createDeps() });
      await completeTask(key, result.skipped ? 'skipped' : 'succeeded');
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const final = isPermanent(error) || ctx.attempt.number >= EVALUATE_MAX_ATTEMPTS;
      await failTask(key, message, final);
      if (final) {
        await markEvaluationFailed(runKey, storyId, message);
        throw new AbortTaskRunError(message);
      }
      throw error;
    }
  },
});

/**
 * One discovery run: claim the lease, prepare candidates, fan out evaluations, wait (polling the
 * database, not holding compute) until done or a deadline closes the candidate set, then rank.
 * A retried or duplicate trigger for a completed run, or one held by another live worker, exits.
 */
export const discoveryRun = task({
  id: TASK_IDS.discoveryRun,
  concurrency: { total: 1 },
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 30_000, maxTimeoutInMs: 300_000 },
  run: async (rawPayload: unknown, { ctx }) => {
    const { runKey } = discoveryRunPayloadSchema.parse(rawPayload);
    const deps = createDeps();
    const owner = ctx.run.id;
    const run = await claimRun({
      runKey,
      owner,
      now: deps.now(),
      config: leaseConfig(deps.config),
    });
    if (!run) {
      logger.info('Run not claimable (completed, exhausted or held by another worker)', { runKey });
      return { runKey, status: 'skipped' as const };
    }

    try {
      const queryDate = runKey.startsWith('daily-discovery:')
        ? runKey.slice('daily-discovery:'.length)
        : chicagoDateKey(deps.now());
      const { candidateStoryIds, overCap } = await prepareRun({ runKey, owner, queryDate, deps });
      logger.info('Candidates prepared', { runKey, candidates: candidateStoryIds.length, overCap });

      if (candidateStoryIds.length > 0) {
        await discoveryEvaluate.batchTrigger(
          await Promise.all(
            candidateStoryIds.map(async (storyId) => ({
              payload: { runKey, storyId },
              options: {
                idempotencyKey: await idempotencyKeys.create(`${runKey}:${storyId}`, {
                  scope: 'global',
                }),
              },
            })),
          ),
        );
      }

      const ids = candidateStoryIds.map(objectId);
      const deadlines = (await getRun(runKey))?.deadlines;
      for (;;) {
        const now = deps.now();
        const { evaluated, pending } = await countRunEvaluations(runKey, ids);
        const decision = shouldCloseCandidateSet({
          now,
          deadlines: {
            soft: deadlines?.soft ?? now,
            extension: deadlines?.extension ?? now,
            hard: deadlines?.hard ?? now,
          },
          evaluated,
          pending,
          minCandidates: deps.config.minCandidates,
        });
        if (decision.close) {
          logger.info('Closing candidate set', {
            runKey,
            reason: decision.reason,
            evaluated,
            pending,
          });
          break;
        }
        if (
          !(await renewLease({ runKey, owner, now, leaseMs: deps.config.leaseMinutes * 60_000 }))
        ) {
          throw new Error('Lost the run lease to another worker');
        }
        await wait.for({ seconds: POLL_SECONDS });
      }

      const result = await finalizeRun({ runKey, owner, deps });
      return { runKey, status: 'completed' as const, shortlisted: result.shortlist.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await failRun({ runKey, owner, stage: 'run', message });
      if (isPermanent(error)) throw new AbortTaskRunError(message);
      throw error;
    }
  },
});

/**
 * Midnight in Chicago, every day. The run key comes from the *scheduled* time, so a delayed or
 * retried firing maps to the same day. Production only: development never spends API budget on a
 * schedule (trigger runs manually instead).
 */
export const dailyDiscovery = schedules.task({
  id: TASK_IDS.dailyDiscovery,
  cron: { pattern: '0 0 * * *', timezone: 'America/Chicago', environments: ['PRODUCTION'] },
  run: async (payload) => {
    const runKey = dailyRunKey(payload.timestamp);
    await startRun({ runKey, trigger: 'schedule' });
    const handle = await discoveryRun.trigger(
      { runKey },
      { idempotencyKey: await idempotencyKeys.create(runKey, { scope: 'global' }) },
    );
    logger.info('Daily discovery triggered', { runKey, run: handle.id });
    return { runKey };
  },
});
