import {
  abandonTask,
  assertTriggerKeyForRuntime,
  attachTriggerRun,
  getDatabaseName,
  isFixtureRuntime,
  TASK_IDS,
  WORKER_UNAVAILABLE,
  type DiscoveryRunPayload,
  type StoryTaskPayload,
} from '@repo/core';
import { tasks } from '@trigger.dev/sdk';
import { after } from 'next/server';

/**
 * Fails fast, before any task is recorded, when the background worker can't be reached, or when
 * the Trigger.dev key belongs to another environment (live development must use a dev key).
 */
export function assertCanEnqueue(): void {
  if (!isFixtureRuntime()) assertTriggerKeyForRuntime();
}

const STORY_TASK_IDS = {
  research: TASK_IDS.researchStory,
  draft: TASK_IDS.generateDraft,
} as const;

/**
 * Hands a research or draft task to the background worker (Trigger.dev), naming this app's
 * database so the worker can refuse work from any other. Only in the fixtures runtime does it run
 * in-process after the response instead, with the scripted assistant and fake search: real
 * workers use real services, so they must never pick up fixture tasks.
 */
export async function enqueueStoryTask(
  kind: keyof typeof STORY_TASK_IDS,
  taskKey: string,
): Promise<void> {
  if (isFixtureRuntime()) {
    after(async () => {
      const { runFixtureStoryTask } = await import('@repo/core/fixtures');
      await runFixtureStoryTask(taskKey);
    });
    return;
  }
  const payload: StoryTaskPayload = { taskKey, database: getDatabaseName() };
  try {
    await tasks.trigger(STORY_TASK_IDS[kind], payload, {
      idempotencyKey: taskKey,
    });
  } catch (error) {
    console.error(`Could not trigger ${kind}`, error);
    await abandonTask(taskKey, 'The background worker couldn’t be reached.');
    throw WORKER_UNAVAILABLE();
  }
}

/**
 * Starts a recorded discovery run in the background worker. Only in the fixtures runtime does it
 * run the real pipeline in-process instead, with the scripted search and model, so "Find today’s
 * stories" can be tried there without searching the web or spending credits.
 */
export async function enqueueDiscoveryRun(runKey: string): Promise<string | null> {
  if (isFixtureRuntime()) {
    after(async () => {
      const { runFixtureDiscovery } = await import('@repo/core/fixtures');
      await runFixtureDiscovery(runKey).catch((error: unknown) => {
        console.error('Fixture discovery failed', error);
      });
    });
    return null;
  }
  const payload: DiscoveryRunPayload = { runKey, database: getDatabaseName() };
  const handle = await tasks.trigger(TASK_IDS.discoveryRun, payload, { idempotencyKey: runKey });
  await attachTriggerRun(runKey, handle.id);
  return handle.id;
}
