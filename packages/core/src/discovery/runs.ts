import { emptyFunnel, type RunFunnel, type ShortfallReason } from '@repo/shared';
import type { Types } from 'mongoose';

import { getModels } from '../db/models.js';
import type { WorkflowRunDoc } from '../db/models/workflow-run.js';

/** A run that failed this many times is left for manual inspection instead of being re-claimed. */
export const MAX_RUN_ATTEMPTS = 3;

export type RunTrigger = 'schedule' | 'manual';

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;
}

/**
 * Creates the run record for `runKey` if it doesn't exist. Safe to call any number of times and
 * concurrently: the unique index on `runKey` guarantees one record, and `created` is true for
 * exactly one caller.
 */
export async function startRun(input: {
  runKey: string;
  trigger: RunTrigger;
  requestedBy?: string | null;
}): Promise<{ run: WorkflowRunDoc; created: boolean }> {
  const { WorkflowRun } = await getModels();
  let created = false;
  try {
    const result = await WorkflowRun.updateOne(
      { runKey: input.runKey },
      {
        $setOnInsert: {
          runKey: input.runKey,
          trigger: input.trigger,
          requestedBy: input.requestedBy ?? null,
          status: 'queued',
          funnel: emptyFunnel(),
        },
      },
      { upsert: true },
    );
    created = result.upsertedCount === 1;
  } catch (error) {
    // Two concurrent upserts can race on the unique index; the loser reads the winner's record.
    if (!isDuplicateKey(error)) throw error;
  }
  const run = await WorkflowRun.findOne({ runKey: input.runKey }).lean();
  if (!run) throw new Error(`Run ${input.runKey} was not created.`);
  return { run, created };
}

export interface RunDeadlineConfig {
  leaseMs: number;
  softDeadlineMinutes: number;
  extensionDeadlineMinutes: number;
  hardDeadlineMinutes: number;
}

/**
 * Atomically takes the lease on a run. Succeeds for a queued run, a failed run with attempts
 * left, or a running run whose lease has expired (its worker died). Returns null if another
 * worker holds a live lease, the run is completed, or it has exhausted its attempts.
 */
export async function claimRun(input: {
  runKey: string;
  owner: string;
  now: Date;
  config: RunDeadlineConfig;
}): Promise<WorkflowRunDoc | null> {
  const { WorkflowRun } = await getModels();
  const { now, config } = input;
  const claimed = await WorkflowRun.findOneAndUpdate(
    {
      runKey: input.runKey,
      attempts: { $lt: MAX_RUN_ATTEMPTS },
      $or: [
        { status: { $in: ['queued', 'failed'] } },
        { status: 'running', leaseExpiresAt: { $lt: now } },
      ],
    },
    {
      $set: {
        status: 'running',
        leaseOwner: input.owner,
        leaseExpiresAt: new Date(now.getTime() + config.leaseMs),
      },
      $inc: { attempts: 1 },
    },
    { returnDocument: 'after' },
  ).lean();
  if (!claimed) return null;

  // Deadlines are fixed at the first start and never move on resume.
  if (!claimed.startedAt) {
    const minutes = (m: number) => new Date(now.getTime() + m * 60_000);
    const started = await WorkflowRun.findOneAndUpdate(
      { runKey: input.runKey, startedAt: null },
      {
        $set: {
          startedAt: now,
          'deadlines.soft': minutes(config.softDeadlineMinutes),
          'deadlines.extension': minutes(config.extensionDeadlineMinutes),
          'deadlines.hard': minutes(config.hardDeadlineMinutes),
        },
      },
      { returnDocument: 'after' },
    ).lean();
    return started ?? (await WorkflowRun.findOne({ runKey: input.runKey }).lean());
  }
  return claimed;
}

/** Extends the lease while the owner is still working. False means the lease was lost. */
export async function renewLease(input: {
  runKey: string;
  owner: string;
  now: Date;
  leaseMs: number;
}): Promise<boolean> {
  const { WorkflowRun } = await getModels();
  const result = await WorkflowRun.updateOne(
    { runKey: input.runKey, leaseOwner: input.owner, status: 'running' },
    { $set: { leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs) } },
  );
  return result.matchedCount === 1;
}

export async function setRunStage(
  runKey: string,
  owner: string,
  stage: WorkflowRunDoc['stage'],
  patch: Record<string, unknown> = {},
): Promise<void> {
  const { WorkflowRun } = await getModels();
  await WorkflowRun.updateOne({ runKey, leaseOwner: owner }, { $set: { stage, ...patch } });
}

export async function recordRunError(
  runKey: string,
  stage: string,
  message: string,
): Promise<void> {
  const { WorkflowRun } = await getModels();
  await WorkflowRun.updateOne(
    { runKey },
    {
      $push: {
        runErrors: {
          $each: [{ stage, message: message.slice(0, 2_000), at: new Date() }],
          $slice: -50,
        },
      },
    },
  );
}

/**
 * Closes the candidate set: the first caller's time wins and later calls return it unchanged.
 * Evaluations finishing after this are recorded as deferred to the next run.
 */
export async function closeCandidateSet(runKey: string, now: Date): Promise<Date> {
  const { WorkflowRun } = await getModels();
  await WorkflowRun.updateOne(
    { runKey, candidateSetClosedAt: null },
    { $set: { candidateSetClosedAt: now } },
  );
  const run = await WorkflowRun.findOne({ runKey }, { candidateSetClosedAt: 1 }).lean();
  return run?.candidateSetClosedAt ?? now;
}

/** Atomically spends one escalation from the run's budget. */
export async function tryUseEscalation(runKey: string, cap: number): Promise<boolean> {
  const { WorkflowRun } = await getModels();
  const result = await WorkflowRun.updateOne(
    { runKey, escalationsUsed: { $lt: cap } },
    { $inc: { escalationsUsed: 1 } },
  );
  return result.modifiedCount === 1;
}

export async function completeRun(input: {
  runKey: string;
  owner: string;
  now: Date;
  funnel: RunFunnel;
  shortlist: Array<{ storyId: Types.ObjectId; rank: number; score: number; isUpdate: boolean }>;
  outcomes: Array<{ storyId: Types.ObjectId; outcome: string; detail: string }>;
  shortfallReasons: ShortfallReason[];
}): Promise<boolean> {
  const { WorkflowRun } = await getModels();
  const result = await WorkflowRun.updateOne(
    { runKey: input.runKey, leaseOwner: input.owner, status: 'running' },
    {
      $set: {
        status: 'completed',
        stage: 'done',
        completedAt: input.now,
        leaseExpiresAt: null,
        funnel: input.funnel,
        shortlist: input.shortlist,
        outcomes: input.outcomes,
        shortfallReasons: input.shortfallReasons,
      },
    },
  );
  return result.matchedCount === 1;
}

export async function failRun(input: {
  runKey: string;
  owner: string;
  stage: string;
  message: string;
}) {
  const { WorkflowRun } = await getModels();
  await WorkflowRun.updateOne(
    { runKey: input.runKey, leaseOwner: input.owner },
    {
      $set: { status: 'failed', leaseExpiresAt: null },
      $push: {
        runErrors: { stage: input.stage, message: input.message.slice(0, 2_000), at: new Date() },
      },
    },
  );
}

/**
 * Records a failed attempt that will be retried: the run goes back to `queued` (so it can be
 * claimed again) instead of reading as failed while its next attempt is still due.
 */
export async function deferRun(input: {
  runKey: string;
  owner: string;
  stage: string;
  message: string;
}) {
  const { WorkflowRun } = await getModels();
  await WorkflowRun.updateOne(
    { runKey: input.runKey, leaseOwner: input.owner },
    {
      $set: { status: 'queued', leaseExpiresAt: null },
      $push: {
        runErrors: { stage: input.stage, message: input.message.slice(0, 2_000), at: new Date() },
      },
    },
  );
}

/**
 * Runs that failed recently (within `days`). The next run adopts their unfinished articles
 * (extracted but not triaged, in scope but in no story) so work already paid for isn't lost when
 * a run fails partway, for example during a provider outage.
 */
export async function failedRunKeys(now: Date, days: number): Promise<string[]> {
  const { WorkflowRun } = await getModels();
  const runs = await WorkflowRun.find(
    { status: 'failed', createdAt: { $gte: new Date(now.getTime() - days * 86_400_000) } },
    { runKey: 1 },
  ).lean();
  return runs.map((run) => run.runKey);
}

/** A queued run quiet for this long is no longer going to start or resume on its own. */
export const RUN_QUIET_AFTER_MS = 45 * 60_000;

export async function getRun(runKey: string): Promise<WorkflowRunDoc | null> {
  const { WorkflowRun } = await getModels();
  return WorkflowRun.findOne({ runKey }).lean();
}

/** How many of a run's candidates have finished evaluation (evaluated or permanently failed). */
export async function countRunEvaluations(
  runKey: string,
  storyIds: readonly Types.ObjectId[],
): Promise<{ finished: number; evaluated: number; pending: number }> {
  const { Story } = await getModels();
  const [evaluated, failed] = await Promise.all([
    Story.countDocuments({
      _id: { $in: storyIds },
      'evaluation.runKey': runKey,
      'evaluation.status': 'evaluated',
    }),
    Story.countDocuments({
      _id: { $in: storyIds },
      'evaluation.runKey': runKey,
      'evaluation.status': 'failed',
    }),
  ]);
  const finished = evaluated + failed;
  return { finished, evaluated, pending: storyIds.length - finished };
}

/**
 * True when a run is executing under a live lease, or is waiting to start or to retry and still
 * expected to (recent activity, attempts left). Used to refuse overlapping manual runs, so a
 * retry in progress can't be doubled by a second search.
 */
export async function hasActiveRun(now: Date): Promise<boolean> {
  const { WorkflowRun } = await getModels();
  return (
    (await WorkflowRun.exists({
      $or: [
        { status: 'running', leaseExpiresAt: { $gt: now } },
        {
          status: 'queued',
          attempts: { $lt: MAX_RUN_ATTEMPTS },
          updatedAt: { $gt: new Date(now.getTime() - RUN_QUIET_AFTER_MS) },
        },
      ],
    })) !== null
  );
}

export async function attachTriggerRun(runKey: string, triggerRunId: string): Promise<void> {
  const { WorkflowRun } = await getModels();
  await WorkflowRun.updateOne({ runKey }, { $set: { triggerRunId } });
}
