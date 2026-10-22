import type { CandidateOutcome } from '@repo/shared';
import { Types } from 'mongoose';

import { getModels } from '../db/models.js';
import type { SourceArticleDoc } from '../db/models/source-article.js';
import type { StoryDoc } from '../db/models/story.js';
import type { LlmClient } from '../llm/client.js';
import { LlmError, type RetryPolicy } from '../llm/types.js';
import { UsageLimitError } from '../ops/budget.js';
import { completeTask, ensureTask, failTask, startTaskAttempt } from '../tasks/service.js';
import { fairOrder } from './intake.js';
import type { DiscoveryDeps } from './pipeline/context.js';
import { evaluateStory } from './pipeline/evaluate.js';
import { rerankCompletedRun, type FinalizeResult } from './pipeline/finalize.js';
import { triageArticles, type TriageCounts } from './pipeline/triage.js';

/**
 * Targeted recovery of one completed run's assessments after a failure that wasn't the stories'
 * own, such as a request the provider refused (ADR-046). It reuses the pipeline: the corrected
 * triage for articles left "Triage unavailable", `evaluateStory` for the assessment, gates and
 * score, and the run's own ranking rules. Nothing is searched. Eligibility comes from stored
 * state and is checked again just before each write; editors' decisions, completed assessments
 * and other runs' stories are never touched. Safe to resume: finished work is skipped.
 */
export interface RecoveryTarget {
  runKey: string;
  /** Written on the run and on each task attempt it makes, for traceability. */
  id: string;
  reason: string;
  /** Recognises a stored assessment failure this recovery is for. */
  failure: RegExp;
}

/** Where a story stands for this recovery. The first two are eligible; the rest are left alone. */
export type RecoveryGroup =
  | 'incident_failed'
  | 'pending'
  | 'assessed'
  | 'rejected'
  | 'editor_skipped'
  | 'protected'
  | 'missing_content'
  | 'other_failure'
  | 'other_run'
  | 'not_candidate';

export const ELIGIBLE_GROUPS: ReadonlySet<RecoveryGroup> = new Set(['incident_failed', 'pending']);

/**
 * Stories whose "Triage unavailable" articles are triaged: eligible ones, and ones assessed since.
 * A placeholder is not a decision, and replacing it writes only the article, never the story.
 */
const RETRIAGE_GROUPS: ReadonlySet<RecoveryGroup> = new Set([
  ...ELIGIBLE_GROUPS,
  'assessed',
  'rejected',
]);

const REJECTING: ReadonlySet<string> = new Set<CandidateOutcome>([
  'gate_reject',
  'below_threshold',
]);

export interface RecoveryManifestEntry {
  storyId: string;
  group: RecoveryGroup;
  evaluationStatus: string | null;
  outcome: string | null;
  articles: number;
  /** Of its articles, those still "Triage unavailable" (model `none`). */
  untriagedArticles: number;
}

export interface RecoveryPlan {
  runKey: string;
  runStatus: string | null;
  recoveryStatus: string | null;
  stories: RecoveryManifestEntry[];
  counts: Record<RecoveryGroup, number>;
  eligible: string[];
  /** "Triage unavailable" articles of eligible stories, to triage first. */
  retriage: string[];
  articles: { triaged: number; outOfScope: number; unavailable: number; notYetTriaged: number };
  /** Anthropic requests: at least one per triage batch and assessment; the worst case adds repairs. */
  estimate: { expected: number; worstCase: number };
}

/** Recovery runs one attempt per request: a transient failure leaves the story for a later run. */
const NO_RETRY: RetryPolicy = { attempts: 1, initialDelayMs: 0, maxDelayMs: 0 };
/** Requests one model call can make here: the answer and its one repair round. */
const PER_CALL = 2;
/** A stale `running` claim (a recovery process that died) may be taken over after this. */
const STALE_CLAIM_MS = 10 * 60_000;
/** Triage tries per article here: in its batch, then alone (each with at most two requests). */
const RECOVERY_TRIAGE_ATTEMPTS = 2;
/** Consecutive transient failures before recovery stops and leaves the rest for later. */
const MAX_TRANSIENT_IN_A_ROW = 3;

function hasText(article: Pick<SourceArticleDoc, 'content' | 'snippet'>): boolean {
  return Boolean((article.content || article.snippet || '').trim());
}

function classify(
  story: StoryDoc,
  articles: readonly SourceArticleDoc[],
  target: RecoveryTarget,
): RecoveryGroup {
  if (story.editorialState === 'skipped') return 'editor_skipped';
  if (story.editorialState !== 'none' || (story.decisions?.length ?? 0) > 0) return 'protected';
  const evaluation = story.evaluation;
  if (evaluation?.status === 'evaluated')
    return REJECTING.has(evaluation.outcome ?? '') ? 'rejected' : 'assessed';
  // Recommended by some run, so assessed even if its record says otherwise: never reassessed.
  if ((story.recommendations?.length ?? 0) > 0) return 'protected';
  if (story.lastCandidateRunKey !== target.runKey) return 'other_run';
  const readable = articles.some(hasText);
  if (evaluation?.status === 'failed') {
    if (evaluation.runKey !== target.runKey || !target.failure.test(evaluation.error ?? ''))
      return 'other_failure';
    return readable ? 'incident_failed' : 'missing_content';
  }
  if (evaluation?.status === 'pending') return readable ? 'pending' : 'missing_content';
  return 'not_candidate';
}

/**
 * The guard a recovered assessment is written under: the story is exactly as it was read, so a
 * decision, an assessment or any other change made since makes the write a no-op.
 */
function guardFor(story: StoryDoc): Record<string, unknown> {
  return {
    lastCandidateRunKey: story.lastCandidateRunKey,
    editorialState: 'none',
    'decisions.0': { $exists: false },
    'recommendations.0': { $exists: false },
    'evaluation.status': story.evaluation?.status,
    updatedAt: story.updatedAt,
  };
}

async function loadCandidates(target: RecoveryTarget) {
  const { Story, SourceArticle, WorkflowRun } = await getModels();
  const run = await WorkflowRun.findOne({ runKey: target.runKey }).lean();
  const ids = new Set((run?.outcomes ?? []).map((o) => String(o.storyId)));
  const stories = await Story.find({
    $or: [
      { lastCandidateRunKey: target.runKey },
      { _id: { $in: [...ids].map((id) => new Types.ObjectId(id)) } },
    ],
  }).lean();
  const articleIds = stories.flatMap((s) => s.sourceArticleIds);
  const articles = await SourceArticle.find({ _id: { $in: articleIds } }).lean();
  return { run, stories, articles: new Map(articles.map((a) => [String(a._id), a])) };
}

/** Read-only: what a recovery of this run would do, from stored state alone. */
export async function planRecovery(target: RecoveryTarget): Promise<RecoveryPlan> {
  const { SourceArticle } = await getModels();
  const { run, stories, articles } = await loadCandidates(target);
  const counts = Object.fromEntries(
    (
      [
        'incident_failed',
        'pending',
        'assessed',
        'rejected',
        'editor_skipped',
        'protected',
        'missing_content',
        'other_failure',
        'other_run',
        'not_candidate',
      ] as const
    ).map((g) => [g, 0]),
  ) as Record<RecoveryGroup, number>;
  const entries: RecoveryManifestEntry[] = [];
  const retriage = new Set<string>();
  for (const story of stories) {
    const own = story.sourceArticleIds.flatMap((id) => articles.get(String(id)) ?? []);
    const group = classify(story, own, target);
    counts[group] += 1;
    const unavailable = own.filter((a) => a.triage?.model === 'none');
    if (RETRIAGE_GROUPS.has(group)) for (const a of unavailable) retriage.add(String(a._id));
    entries.push({
      storyId: String(story._id),
      group,
      evaluationStatus: story.evaluation?.status ?? null,
      outcome: story.evaluation?.outcome ?? null,
      articles: own.length,
      untriagedArticles: unavailable.length,
    });
  }
  const runArticles = await SourceArticle.find(
    { $or: [{ intakeRunKey: target.runKey }, { firstRunKey: target.runKey }] },
    { triage: 1 },
  ).lean();
  const eligible = sortEligible(stories, entries, articles);
  const batches = Math.ceil(retriage.size / 6);
  return {
    runKey: target.runKey,
    runStatus: run?.status ?? null,
    recoveryStatus: run?.recovery?.status ?? null,
    stories: entries,
    counts,
    eligible,
    retriage: [...retriage],
    articles: {
      triaged: runArticles.filter((a) => a.triage && a.triage.model !== 'none' && a.triage.inScope)
        .length,
      outOfScope: runArticles.filter((a) => a.triage && !a.triage.inScope).length,
      unavailable: runArticles.filter((a) => a.triage?.model === 'none').length,
      notYetTriaged: runArticles.filter((a) => !a.triage).length,
    },
    estimate: {
      expected: batches + eligible.length,
      // Each batch, then each article alone with a repair; each assessment with a repair, and the
      // run's remaining escalations with theirs.
      worstCase:
        batches +
        PER_CALL * retriage.size +
        PER_CALL * eligible.length +
        PER_CALL *
          Math.max(
            0,
            ((run?.config as { maxEscalations?: number } | null)?.maxEscalations ?? 0) -
              (run?.escalationsUsed ?? 0),
          ),
    },
  };
}

/** The failed ones first (the run's own order), then pending ones in the pipeline's fair order. */
function sortEligible(
  stories: readonly StoryDoc[],
  entries: readonly RecoveryManifestEntry[],
  articles: ReadonlyMap<string, SourceArticleDoc>,
): string[] {
  const group = new Map(entries.map((e) => [e.storyId, e.group]));
  const failed = stories.filter((s) => group.get(String(s._id)) === 'incident_failed');
  const pending = fairOrder(
    stories
      .filter((s) => group.get(String(s._id)) === 'pending')
      .map((story) => {
        const lead = articles.get(String(story.sourceArticleIds[0]));
        return {
          batch: story.firstSeenRunKey,
          foundAt: new Date(story.createdAt),
          lane: lead?.searchQuery ?? null,
          laneTier: lead?.searchTier ?? null,
          score: lead?.searchScore ?? 0,
          id: String(story._id),
        };
      }),
  );
  return [...failed.map((s) => String(s._id)), ...pending.map((p) => p.id)];
}

/**
 * Records a story's own assessment failure under its guard, replacing the incident's error so the
 * stored reason is the real one. A story that was pending counts its first failed run.
 */
async function recordFailure(target: RecoveryTarget, story: StoryDoc, message: string) {
  const { Story } = await getModels();
  await Story.updateOne(
    { _id: story._id, ...guardFor(story) },
    {
      $set: {
        'evaluation.status': 'failed',
        'evaluation.runKey': target.runKey,
        'evaluation.outcome': 'evaluation_failed',
        'evaluation.error': message.slice(0, 1_000),
      },
      ...(story.evaluation?.status === 'pending' ? { $inc: { 'evaluation.failedRuns': 1 } } : {}),
    },
  );
}

/** Anthropic requests actually sent so far (counted below the SDK), against a hard ceiling. */
export interface RequestBudget {
  ceiling: number;
  used: () => number;
}

class BudgetReached extends Error {}

/**
 * The client recovery uses: the production client, with no SDK retries (one request per attempt,
 * so a call is at most its answer and one repair) and a check before every call that its worst
 * case still fits the ceiling.
 */
function boundedLlm(inner: LlmClient, budget: RequestBudget): LlmClient {
  const check = (repair: boolean | undefined) => {
    if (budget.used() + (repair === false ? 1 : PER_CALL) > budget.ceiling)
      throw new BudgetReached(`The recovery's ceiling of ${budget.ceiling} requests was reached.`);
  };
  return {
    provider: inner.provider,
    modelFor: (tier) => inner.modelFor(tier),
    generateObject: (request) => {
      check(request.repair);
      return inner.generateObject({ ...request, retry: NO_RETRY });
    },
    streamObject: (request) => {
      check(request.repair);
      return inner.streamObject({ ...request, retry: NO_RETRY });
    },
    generateText: (request) => {
      check(false);
      return inner.generateText({ ...request, retry: NO_RETRY });
    },
  };
}

export interface RecoveryStoryResult {
  storyId: string;
  result: 'assessed' | 'failed' | 'skipped' | 'conflict' | 'left';
  outcome?: CandidateOutcome;
  total?: number | null;
  escalated?: boolean;
  detail?: string;
}

export interface RecoveryReport {
  runKey: string;
  id: string;
  claimed: boolean;
  status: 'completed' | 'incomplete' | 'not_started';
  stoppedBy: string | null;
  triage: (TriageCounts & { requested: number }) | null;
  stories: RecoveryStoryResult[];
  ranked: FinalizeResult | null;
  remainingEligible: number;
}

/**
 * Claims the run for this recovery: a first claim records the run's outcomes before recovery; a
 * resumed one continues an incomplete recovery or takes over one whose process stopped.
 */
async function claim(target: RecoveryTarget, now: Date): Promise<boolean> {
  const { WorkflowRun } = await getModels();
  const run = await WorkflowRun.findOne({ runKey: target.runKey }).lean();
  if (run?.status !== 'completed') return false;
  const before: Record<string, number> = {};
  for (const o of run.outcomes ?? []) {
    const outcome = String(o.outcome);
    before[outcome] = (before[outcome] ?? 0) + 1;
  }
  const fresh = await WorkflowRun.updateOne(
    { runKey: target.runKey, status: 'completed', recovery: null },
    {
      $set: {
        recovery: {
          id: target.id,
          status: 'running',
          reason: target.reason,
          startedAt: now,
          updatedAt: now,
          completedAt: null,
          before: { outcomes: before, shortlisted: run.shortlist?.length ?? 0 },
          counts: null,
          note: null,
        },
      },
    },
  );
  if (fresh.modifiedCount === 1) return true;
  const resumed = await WorkflowRun.updateOne(
    {
      runKey: target.runKey,
      status: 'completed',
      'recovery.id': target.id,
      $or: [
        // Reopened only while work is left (the caller checked): never a finished one for nothing.
        { 'recovery.status': { $in: ['incomplete', 'completed'] } },
        {
          'recovery.status': 'running',
          'recovery.updatedAt': { $lt: new Date(now.getTime() - STALE_CLAIM_MS) },
        },
      ],
    },
    { $set: { 'recovery.status': 'running', 'recovery.updatedAt': now, 'recovery.note': null } },
  );
  return resumed.modifiedCount === 1;
}

async function heartbeat(target: RecoveryTarget, counts: Record<string, unknown>, now: Date) {
  const { WorkflowRun } = await getModels();
  await WorkflowRun.updateOne(
    { runKey: target.runKey, 'recovery.id': target.id },
    { $set: { 'recovery.updatedAt': now, 'recovery.counts': counts } },
  );
}

function stopReason(error: unknown): string | null {
  if (error instanceof BudgetReached) return error.message;
  if (error instanceof UsageLimitError) return error.message;
  if (
    error instanceof LlmError &&
    ['schema_rejected', 'invalid_request', 'auth'].includes(error.kind)
  )
    return `A permanent request error (${error.kind}): ${error.message}`;
  return null;
}

/**
 * Runs the recovery: triage of the eligible stories' "Triage unavailable" articles, then each
 * eligible story's assessment, one at a time, then the run's ranking. Stops before the request
 * ceiling, on a permanent request error, or after repeated transient failures, leaving whatever
 * is left eligible for a resumed run.
 */
export async function applyRecovery(input: {
  target: RecoveryTarget;
  deps: DiscoveryDeps;
  budget: RequestBudget;
  /** Most of the ceiling triage may use, so assessments keep the rest. */
  triageCeiling?: number;
  /** Assess at most this many stories in this run (a canary); the rest stay for a resumed run. */
  maxStories?: number;
  /** Waits after a transient failure (tests pass a no-op). */
  pause?: (ms: number) => Promise<void>;
  onEvent?: (message: string) => void;
}): Promise<RecoveryReport> {
  const { target, budget } = input;
  const log = input.onEvent ?? (() => {});
  const pause = input.pause ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deps: DiscoveryDeps = { ...input.deps, llm: boundedLlm(input.deps.llm, budget) };
  const report: RecoveryReport = {
    runKey: target.runKey,
    id: target.id,
    claimed: false,
    status: 'not_started',
    stoppedBy: null,
    triage: null,
    stories: [],
    ranked: null,
    remainingEligible: 0,
  };
  const plan = await planRecovery(target);
  if (plan.eligible.length === 0 && plan.retriage.length === 0) {
    report.status = plan.recoveryStatus === 'completed' ? 'completed' : 'not_started';
    report.stoppedBy = 'Nothing left to recover.';
    return report;
  }
  if (!(await claim(target, deps.now()))) {
    report.stoppedBy = 'Not claimed: the run is not completed, or another recovery is running.';
    return report;
  }
  report.claimed = true;
  const { Story, SourceArticle, WorkflowRun } = await getModels();
  const counts = () => ({
    eligibleAtStart: plan.eligible.length,
    assessed: report.stories.filter((s) => s.result === 'assessed').length,
    failed: report.stories.filter((s) => s.result === 'failed').length,
    skipped: report.stories.filter((s) => s.result === 'skipped' || s.result === 'conflict').length,
    triaged: report.triage?.triaged ?? 0,
    requests: budget.used(),
  });

  // 1. Triage the articles the incident left unscreened, so assessment sees their signals.
  if (plan.retriage.length > 0) {
    const articles = await SourceArticle.find({
      _id: { $in: plan.retriage.map((id) => new Types.ObjectId(id)) },
      'triage.model': 'none',
    }).lean();
    const start = budget.used();
    const ceiling = Math.min(budget.ceiling, start + (input.triageCeiling ?? budget.ceiling));
    try {
      const stats = await triageArticles(articles, target.runKey, deps, {
        replace: 'fallback',
        attempts: RECOVERY_TRIAGE_ATTEMPTS,
        shouldContinue: () => budget.used() + PER_CALL <= ceiling,
      });
      report.triage = { ...stats, requested: articles.length };
      log(`triage: ${stats.triaged - stats.fallbacks} of ${articles.length} triaged`);
    } catch (error) {
      report.triage = {
        requested: articles.length,
        triaged: 0,
        inScope: 0,
        outOfScope: 0,
        batches: 0,
        fallbacks: 0,
        splits: 0,
        shortenedReasons: 0,
        deferred: articles.length,
      };
      // Assessments use triage's signals, so none starts before triage has finished: a resumed
      // run does the triage first.
      report.stoppedBy =
        stopReason(error) ??
        `Triage stopped on a transient error before finishing; resume to complete it first: ${String(error).slice(0, 300)}`;
      log(`triage stopped: ${String(error)}`);
      return finish();
    }
  }

  // 2. Assess each eligible story, rechecking it just before.
  let transientInARow = 0;
  let ownFailuresInARow = 0;
  let attempted = 0;
  for (const storyId of plan.eligible) {
    if (!report.stoppedBy && input.maxStories !== undefined && attempted >= input.maxStories)
      report.stoppedBy = `Stopped after ${input.maxStories} stories, as asked; the rest are left for a resumed run.`;
    if (report.stoppedBy) {
      report.stories.push({ storyId, result: 'left', detail: report.stoppedBy });
      continue;
    }
    const story = await Story.findById(storyId).lean();
    const own = story
      ? await SourceArticle.find({ _id: { $in: story.sourceArticleIds } }).lean()
      : [];
    const group = story ? classify(story, own, target) : 'not_candidate';
    if (!story || !ELIGIBLE_GROUPS.has(group)) {
      report.stories.push({ storyId, result: 'skipped', detail: `no longer eligible (${group})` });
      continue;
    }
    // Worst case: the assessment and its repair, then an escalation and its repair.
    const run = await WorkflowRun.findOne(
      { runKey: target.runKey },
      { escalationsUsed: 1, config: 1 },
    ).lean();
    const escalationLeft = (run?.escalationsUsed ?? 0) < deps.config.maxEscalations;
    if (budget.used() + PER_CALL * (escalationLeft ? 2 : 1) > budget.ceiling) {
      report.stoppedBy = `Stopped before the ceiling of ${budget.ceiling} requests (${budget.used()} sent).`;
      report.stories.push({ storyId, result: 'left', detail: report.stoppedBy });
      continue;
    }
    attempted += 1;
    const key = `discovery.evaluate:${target.runKey}:${storyId}`;
    const task = await ensureTask({
      key,
      kind: 'discovery.evaluate',
      runKey: target.runKey,
      storyId: story._id,
    });
    await startTaskAttempt(key, (task.attempts ?? 0) + 1, `recovery:${target.id}`);
    try {
      const result = await evaluateStory({
        runKey: target.runKey,
        storyId,
        deps,
        recovery: { guard: guardFor(story) },
      });
      transientInARow = 0;
      ownFailuresInARow = 0;
      if (result.conflict) {
        await failTask(
          key,
          'Recovery: the story changed before its assessment was saved; nothing was written.',
          true,
        );
        report.stories.push({ storyId, result: 'conflict', detail: 'changed during recovery' });
      } else {
        await completeTask(key, result.skipped ? 'skipped' : 'succeeded');
        report.stories.push({
          storyId,
          result: result.skipped ? 'skipped' : 'assessed',
          outcome: result.outcome,
          total: result.total,
          escalated: result.escalated,
        });
        log(`assessed ${storyId}: ${result.outcome} (${result.total ?? '–'})`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stop = stopReason(error);
      const transient = error instanceof LlmError && error.retryable;
      await failTask(
        key,
        `Recovery ${target.id}: ${transient || stop ? 'left for a later recovery run' : 'assessment failed'}: ${message}`,
        true,
      );
      if (stop) {
        report.stoppedBy = stop;
        report.stories.push({ storyId, result: 'left', detail: message });
      } else if (transient) {
        transientInARow += 1;
        report.stories.push({ storyId, result: 'left', detail: message });
        if (transientInARow >= MAX_TRANSIENT_IN_A_ROW)
          report.stoppedBy = `${transientInARow} transient failures in a row: ${message}`;
        else await pause(15_000);
      } else {
        // The story's own failure (an answer still invalid after its repair, a refusal): recorded
        // as an explicit failed assessment, which the pipeline retries once in a later run. Two in
        // a row point to the request rather than the stories, so recovery stops there.
        transientInARow = 0;
        ownFailuresInARow += 1;
        await recordFailure(target, story, message);
        report.stories.push({ storyId, result: 'failed', detail: message });
        if (ownFailuresInARow >= 2)
          report.stoppedBy = `${ownFailuresInARow} assessments in a row failed on their answers: ${message.slice(0, 300)}`;
      }
      log(`not assessed ${storyId}: ${message.slice(0, 160)}`);
    }
    await heartbeat(target, counts(), deps.now());
  }
  return finish();

  async function finish(): Promise<RecoveryReport> {
    if (report.stories.some((s) => s.result === 'assessed' || s.result === 'failed'))
      report.ranked = await rerankCompletedRun({ runKey: target.runKey, deps });
    const after = await planRecovery(target);
    report.remainingEligible = after.eligible.length;
    // Complete only when no story is left to assess and no placeholder triage is left to replace.
    report.status =
      after.eligible.length === 0 && after.retriage.length === 0 ? 'completed' : 'incomplete';
    const now = deps.now();
    await WorkflowRun.updateOne(
      { runKey: target.runKey, 'recovery.id': target.id },
      {
        $set: {
          'recovery.status': report.status,
          'recovery.updatedAt': now,
          'recovery.completedAt': report.status === 'completed' ? now : null,
          'recovery.counts': { ...counts(), remainingEligible: after.eligible.length },
          'recovery.note': report.stoppedBy,
        },
      },
    );
    return report;
  }
}
