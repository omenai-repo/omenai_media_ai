import {
  failTask,
  getLlmClient,
  isFixtureRuntime,
  isPermanentError,
  runDraftGeneration,
  startTaskAttempt,
  storyTaskPayloadSchema,
  TASK_IDS,
  TASK_MAX_ATTEMPTS,
  type LlmClient,
} from '@repo/core';
import { AbortTaskRunError, task } from '@trigger.dev/sdk';

import { assertSameEnvironment } from './guard.js';

const MAX_ATTEMPTS = TASK_MAX_ATTEMPTS.generate;

/**
 * The model that writes the draft. Only in the fixtures runtime (OMENAI_RUNTIME=fixtures with a
 * `*_fixtures` database, outside production) does the scripted writer stand in, so the real
 * engine can be exercised without any AI call (ADR-031). Every other runtime uses the provider.
 */
async function draftModel(
  taskKey: string,
  context: { attempt: number; environment: string },
): Promise<LlmClient> {
  if (isFixtureRuntime() && context.environment !== 'PRODUCTION') {
    const { createFixtureWorkerLlm } = await import('@repo/core/fixtures');
    return createFixtureWorkerLlm({ taskKey, attempt: context.attempt });
  }
  return getLlmClient();
}

/**
 * Writes one draft version for a task record the web app created (holding the story-and-format
 * lock). The record is the source of truth for status; Trigger.dev only executes and retries.
 * Drafts need the model only, never search. When attempts run out, or the error can't be fixed
 * by retrying, the task is marked failed and the lock released so the editor can ask again.
 */
export const generateDraft = task({
  id: TASK_IDS.generateDraft,
  maxDuration: 600,
  retry: { maxAttempts: MAX_ATTEMPTS, factor: 2, minTimeoutInMs: 10_000, maxTimeoutInMs: 120_000 },
  run: async (rawPayload: unknown, { ctx }) => {
    const payload = storyTaskPayloadSchema.safeParse(rawPayload);
    // A malformed payload fails the same way every time: don't retry it.
    if (!payload.success) throw new AbortTaskRunError('Invalid draft task payload.');
    const { taskKey, database } = payload.data;
    assertSameEnvironment(ctx.environment.type, database);
    await startTaskAttempt(taskKey, ctx.attempt.number, ctx.run.id);
    try {
      const llm = await draftModel(taskKey, {
        attempt: ctx.attempt.number,
        environment: ctx.environment.type,
      });
      // Completes the task itself, with its final steps, when the version is saved.
      return await runDraftGeneration({ taskKey, deps: { llm, now: () => new Date() } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const final = isPermanentError(error) || ctx.attempt.number >= MAX_ATTEMPTS;
      await failTask(taskKey, message, final);
      if (final) throw new AbortTaskRunError(message);
      throw error;
    }
  },
});
