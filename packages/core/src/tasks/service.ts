import type { Types } from 'mongoose';

import { getModels } from '../db/models.js';
import type { TaskDoc } from '../db/models/task.js';

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
        ...(triggerRunId ? { triggerRunId } : {}),
      },
      $max: { attempts: attempt },
    },
  );
}

export async function updateTaskProgress(
  key: string,
  progress: { step: string; message: string; pct?: number | null },
): Promise<void> {
  const { Task } = await getModels();
  await Task.updateOne(
    { key },
    {
      $set: {
        progress: { step: progress.step, message: progress.message, pct: progress.pct ?? null },
      },
    },
  );
}

export async function completeTask(key: string, status: 'succeeded' | 'skipped' = 'succeeded') {
  const { Task } = await getModels();
  await Task.updateOne(
    { key },
    { $set: { status, finishedAt: new Date(), lastError: null }, $unset: { activeLock: '' } },
  );
}

/**
 * Records a failed attempt. A retryable failure leaves the task `queued` for the next attempt; a
 * final one marks it `failed` and releases any lock so the work can be requested again.
 */
export async function failTask(key: string, message: string, final: boolean): Promise<void> {
  const { Task } = await getModels();
  await Task.updateOne(
    { key },
    final
      ? {
          $set: { status: 'failed', finishedAt: new Date(), lastError: message.slice(0, 2_000) },
          $unset: { activeLock: '' },
        }
      : { $set: { status: 'queued', lastError: message.slice(0, 2_000) } },
  );
}
