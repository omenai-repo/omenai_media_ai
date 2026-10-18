import { RUN_KEY_PATTERN } from '@repo/shared';
import * as z from 'zod';

import type { TASK_KINDS } from '../db/models/task.js';

/**
 * Background task identifiers and payloads, shared by the worker (which defines the tasks) and
 * the web app (which triggers them) without the web app importing worker code.
 */
export const TASK_IDS = {
  dailyDiscovery: 'daily-discovery',
  discoveryRun: 'discovery-run',
  discoveryEvaluate: 'discovery-evaluate',
  researchStory: 'research-story',
  generateDraft: 'generate-draft',
} as const;

/**
 * How many attempts the worker makes at each kind of task before giving up (Trigger.dev
 * `retry.maxAttempts`). The worker configures its tasks from this table and the operations view
 * reads it, so "attempt 2 of 5" and "gave up after 5 attempts" always match what actually runs.
 */
export const TASK_MAX_ATTEMPTS = {
  'discovery.prepare': 1,
  'discovery.evaluate': 5,
  'discovery.finalize': 1,
  research: 3,
  // Chat replies stream inside the web request (ADR-035): one attempt, and a failure is shown at
  // once with "Ask again" instead of being retried in the background.
  chat: 1,
  generate: 3,
} as const satisfies Record<(typeof TASK_KINDS)[number], number>;

/**
 * The database the request was made against. The worker refuses work from any other database,
 * so the web app and the worker can never silently use different data.
 */
const database = z.string().min(1).max(64);

export const discoveryRunPayloadSchema = z.object({
  runKey: z.string().regex(RUN_KEY_PATTERN),
  database,
});
export type DiscoveryRunPayload = z.output<typeof discoveryRunPayloadSchema>;

export const discoveryEvaluatePayloadSchema = z.object({
  runKey: z.string().regex(RUN_KEY_PATTERN),
  storyId: z.string().regex(/^[a-f0-9]{24}$/),
});
export type DiscoveryEvaluatePayload = z.output<typeof discoveryEvaluatePayloadSchema>;

/** Research and draft tasks carry only the key of the task record the web app created. */
export const storyTaskPayloadSchema = z.object({
  database,
  taskKey: z
    .string()
    .regex(/^(research:(standard|in_depth)|generate:[a-z_]{3,40}):[a-f0-9]{24}(:[a-f0-9]{24})+$/),
});
export type StoryTaskPayload = z.output<typeof storyTaskPayloadSchema>;
