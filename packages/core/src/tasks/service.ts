import type { StepCounts, StepNotice, WorkStep } from '@repo/shared';
import type { Types } from 'mongoose';

import { getModels } from '../db/models.js';
import type { TaskDoc } from '../db/models/task.js';
import { ConflictError } from '../errors.js';

/**
 * Stage-task records: one per unit of background work, keyed deterministically so that retries
 * and duplicate triggers update the same record. Status here is what the UI and the operations
 * view read; Trigger.dev is only the executor.
 */
export async function ensureTask(input: {
  key: string;
  kind: TaskDoc['kind'];
  runKey?: string | null;
  storyId?: Types.ObjectId | null;
  requestedBy?: string | null;
}): Promise<TaskDoc> {
  const { Task } = await getModels();
  try {
    return await Task.findOneAndUpdate(
      { key: input.key },
      {
        $setOnInsert: {
          key: input.key,
          kind: input.kind,
          runKey: input.runKey ?? null,
          storyId: input.storyId ?? null,
          requestedBy: input.requestedBy ?? null,
          status: 'queued',
        },
      },
      { upsert: true, returnDocument: 'after' },
    ).lean();
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    return (await Task.findOne({ key: input.key }).lean())!;
  }
}

/** Each attempt reports its own steps from the start; a retry doesn't inherit the last one's. */
const FRESH_PROGRESS = {
  step: null,
  message: null,
  pct: null,
  startedAt: null,
  steps: [],
  notice: null,
};

export async function startTaskAttempt(
  key: string,
  attempt: number,
  triggerRunId?: string | null,
): Promise<void> {
  const { Task } = await getModels();
  await Task.updateOne(
    { key },
    {
      $set: {
        status: 'running',
        startedAt: new Date(),
        progress: FRESH_PROGRESS,
        ...(triggerRunId ? { triggerRunId } : {}),
      },
      $max: { attempts: attempt },
    },
  );
}

export interface ProgressRecorder {
  /** Starts a step (the previous one ends); counts describe what it works from, if known. */
  step(step: WorkStep, counts?: StepCounts): void;
  /** Adds what the current step found, once known. */
  count(counts: StepCounts): void;
  /** A passing condition of the current step, or null when it has passed. */
  notice(notice: StepNotice | null): void;
  /** Drafts: the text written so far. */
  preview(preview: { title: string; body: string }): void;
  /** Resolves once the latest state has been written (or the write given up). */
  flush(): Promise<void>;
  /**
   * Stops recording and returns the final steps, for `completeTask` to write with the outcome in
   * one update (so the record of what ran is complete without an extra round trip).
   */
  final(): ProgressFields;
}

/** Progress fields as written to the task (`$set` paths). */
export type ProgressFields = Record<`progress.${string}`, unknown>;

/**
 * Records a running task's progress for the interface: the steps it reaches, what they found, a
 * passing notice and (drafts) the text so far. Writing never holds the work up: changes are
 * written in the background, in order, and while one write is in flight later changes collapse
 * into the next. Writes apply only while the task is running, so a late one can't touch a
 * finished task, and a failed one is ignored: progress describes the work and is never part of
 * it.
 */
export function progressRecorder(
  key: string,
  now: () => Date = () => new Date(),
): ProgressRecorder {
  const state: {
    step: WorkStep | null;
    startedAt: Date | null;
    steps: Array<{ step: WorkStep; startedAt: Date; counts: StepCounts | null }>;
    notice: StepNotice | null;
    preview: { title: string; body: string } | null;
  } = { step: null, startedAt: null, steps: [], notice: null, preview: null };
  let pending = false;
  let closed = false;
  let writing: Promise<void> | null = null;

  const stepFields = (): ProgressFields => ({
    'progress.step': state.step,
    'progress.startedAt': state.startedAt,
    'progress.steps': state.steps.map((s) => ({ ...s, counts: s.counts && { ...s.counts } })),
    'progress.notice': state.notice,
  });

  async function drain(): Promise<void> {
    const { Task } = await getModels();
    while (pending && !closed) {
      pending = false;
      const fields = stepFields();
      if (state.preview) fields['progress.preview'] = { ...state.preview };
      try {
        await Task.updateOne({ key, status: 'running' }, { $set: fields });
      } catch {
        // Progress is only a view of the work; the next change writes the whole state again.
      }
    }
    writing = null;
  }

  function changed() {
    if (closed) return;
    pending = true;
    writing ??= drain();
  }

  return {
    step(step, counts) {
      const at = now();
      state.step = step;
      state.startedAt = at;
      state.notice = null;
      state.steps.push({ step, startedAt: at, counts: counts ? { ...counts } : null });
      changed();
    },
    count(counts) {
      const current = state.steps.at(-1);
      if (!current) return;
      current.counts = { ...current.counts, ...counts };
      changed();
    },
    notice(notice) {
      if (state.notice === notice) return;
      state.notice = notice;
      changed();
    },
    preview(preview) {
      state.preview = { title: preview.title, body: preview.body };
      changed();
    },
    flush: () => writing ?? Promise.resolve(),
    final() {
      closed = true;
      return { ...stepFields(), 'progress.notice': null };
    },
  };
}

export async function completeTask(
  key: string,
  status: 'succeeded' | 'skipped' = 'succeeded',
  /** The final steps (`ProgressRecorder.final()`), written with the outcome. */
  progress: ProgressFields = {},
) {
  const { Task } = await getModels();
  await Task.updateOne(
    { key },
    {
      $set: {
        ...progress,
        status,
        finishedAt: new Date(),
        lastError: null,
        'progress.notice': null,
      },
      // The preview was never the result: the saved version is.
      $unset: { activeLock: '', 'progress.preview': '' },
    },
  );
}

/**
 * Records a failed attempt. A retryable failure leaves the task `queued` for the next attempt; a
 * final one marks it `failed` and releases any lock so the work can be requested again. Either
 * way the text written so far is dropped: nothing partial outlives the attempt that wrote it.
 */
export async function failTask(key: string, message: string, final: boolean): Promise<void> {
  const { Task } = await getModels();
  await Task.updateOne(
    { key },
    final
      ? {
          $set: {
            status: 'failed',
            finishedAt: new Date(),
            lastError: message.slice(0, 2_000),
            'progress.notice': null,
          },
          $unset: { activeLock: '', 'progress.preview': '' },
        }
      : {
          $set: { status: 'queued', lastError: message.slice(0, 2_000), 'progress.notice': null },
          $unset: { 'progress.preview': '' },
        },
  );
}

/** A locked task that hasn't updated for this long is treated as abandoned and its lock freed. */
export const STALE_LOCK_MS = 45 * 60_000;
/**
 * Chat replies run inside the web request, which the platform ends after 90 s (the route's
 * `maxDuration`), so a chat lock quiet for 2 minutes belongs to a reply that can't finish.
 */
export const CHAT_STALE_MS = 2 * 60_000;

/** How long a task of this kind may go without progress before it counts as abandoned. */
export function staleAfterMs(kind: string | null | undefined): number {
  return kind === 'chat' ? CHAT_STALE_MS : STALE_LOCK_MS;
}

/** What a chat reply records when the editor stops it (not a failure to report). */
export const CHAT_STOPPED_MESSAGE = 'Stopped by the editor.';

/** What an abandoned task records, in the words the workspace and Operations recognise. */
export function abandonedMessage(kind: string | null | undefined): string {
  return `Abandoned: no progress for ${kind === 'chat' ? '2' : '45'} minutes.`;
}

/**
 * Creates a queued task holding `lock` (a sparse-unique field, so only one task can hold it), or
 * explains what is already running. A lock abandoned for its kind's stale window (45 minutes, or
 * 2 for a chat reply) is released and taken over.
 */
export async function createLockedTask(input: {
  key: string;
  kind: TaskDoc['kind'];
  storyId: Types.ObjectId;
  requestedBy: string;
  now: Date;
  lock: string;
  /** The conflict to raise while another task holds the lock. */
  busy: (holder: TaskDoc | null) => ConflictError;
  extra?: Partial<
    Pick<
      TaskDoc,
      'requestKind' | 'focus' | 'fromMessageId' | 'format' | 'instructions' | 'fromVersion'
    >
  >;
}): Promise<TaskDoc> {
  const { Task } = await getModels();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const doc = await Task.create({
        key: input.key,
        kind: input.kind,
        storyId: input.storyId,
        requestedBy: input.requestedBy,
        status: 'queued',
        activeLock: input.lock,
        ...input.extra,
      });
      return doc.toObject();
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      const holder = await Task.findOne({ activeLock: input.lock }).lean();
      if (holder && holder.updatedAt < new Date(input.now.getTime() - staleAfterMs(holder.kind))) {
        await Task.updateOne(
          { _id: holder._id, activeLock: input.lock },
          {
            $set: { status: 'failed', lastError: abandonedMessage(holder.kind) },
            $unset: { activeLock: '' },
          },
        );
        continue;
      }
      throw input.busy(holder);
    }
  }
  throw input.busy(null);
}
