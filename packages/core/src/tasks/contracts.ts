import { RUN_KEY_PATTERN } from '@repo/shared';
import * as z from 'zod';

/**
 * Background task identifiers and payloads, shared by the worker (which defines the tasks) and
 * the web app (which triggers them) without the web app importing worker code.
 */
export const TASK_IDS = {
  dailyDiscovery: 'daily-discovery',
  discoveryRun: 'discovery-run',
  discoveryEvaluate: 'discovery-evaluate',
} as const;

export const discoveryRunPayloadSchema = z.object({ runKey: z.string().regex(RUN_KEY_PATTERN) });
export type DiscoveryRunPayload = z.output<typeof discoveryRunPayloadSchema>;

export const discoveryEvaluatePayloadSchema = z.object({
  runKey: z.string().regex(RUN_KEY_PATTERN),
  storyId: z.string().regex(/^[a-f0-9]{24}$/),
});
export type DiscoveryEvaluatePayload = z.output<typeof discoveryEvaluatePayloadSchema>;
