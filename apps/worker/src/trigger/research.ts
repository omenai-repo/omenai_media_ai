import {
  failTask,
  getLlmClient,
  getSearchClient,
  isPermanentError,
  runResearch,
  startTaskAttempt,
  storyTaskPayloadSchema,
  TASK_IDS,
  TASK_MAX_ATTEMPTS,
  type ResearchDeps,
} from '@repo/core';
import { AbortTaskRunError, task } from '@trigger.dev/sdk';

import { assertSameEnvironment } from './guard.js';

// The operations view reads the same table. Chat replies no longer run here: they stream from
// the web app (ADR-035).
const MAX_ATTEMPTS = TASK_MAX_ATTEMPTS.research;

/**
 * A malformed payload fails the same way every time: abort instead of retrying it. Then the
 * worker must be the environment and database the request came from.
 */
function parseTaskKey(rawPayload: unknown, environment: string): string {
  const payload = storyTaskPayloadSchema.safeParse(rawPayload);
  if (!payload.success) throw new AbortTaskRunError('Invalid task payload.');
  assertSameEnvironment(environment, payload.data.database);
  return payload.data.taskKey;
}

function createDeps(): ResearchDeps {
  return { llm: getLlmClient(), search: getSearchClient(), now: () => new Date() };
}

/**
 * Runs one research task record. The record (created by the web app, holding the story's lock)
 * is the source of truth for status and progress; Trigger.dev only executes and retries.
 * When attempts run out, or the error can't be fixed by retrying, the task is marked failed and
 * the lock released so the editor can try again.
 */
async function execute(
  taskKey: string,
  attempt: number,
  runId: string,
  work: (deps: ResearchDeps) => Promise<unknown>,
) {
  await startTaskAttempt(taskKey, attempt, runId);
  try {
    // The work completes the task itself, with its final steps, when its result is saved.
    return await work(createDeps());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const final = isPermanentError(error) || attempt >= MAX_ATTEMPTS;
    await failTask(taskKey, message, final);
    if (final) throw new AbortTaskRunError(message);
    throw error;
  }
}

export const researchStory = task({
  id: TASK_IDS.researchStory,
  maxDuration: 900,
  retry: { maxAttempts: MAX_ATTEMPTS, factor: 2, minTimeoutInMs: 10_000, maxTimeoutInMs: 120_000 },
  run: async (rawPayload: unknown, { ctx }) => {
    const taskKey = parseTaskKey(rawPayload, ctx.environment.type);
    return execute(taskKey, ctx.attempt.number, ctx.run.id, (deps) =>
      runResearch({ taskKey, deps }),
    );
  },
});
