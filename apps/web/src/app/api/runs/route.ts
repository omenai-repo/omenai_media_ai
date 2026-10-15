import {
  attachTriggerRun,
  ConflictError,
  hasActiveRun,
  requireEnv,
  startRun,
  TASK_IDS,
  type DiscoveryRunPayload,
} from '@repo/core';
import { manualRunKey } from '@repo/shared';
import { tasks } from '@trigger.dev/sdk';

import { apiHandler } from '@/lib/api';
import { requireUser } from '@/lib/session';

/**
 * Owner-only: start a discovery run now instead of waiting for midnight. The run itself executes
 * in Trigger.dev; this request only records and enqueues it. Overlapping runs are refused.
 */
export const POST = apiHandler(async () => {
  const user = await requireUser('runs:trigger');
  requireEnv('TRIGGER_SECRET_KEY');
  const now = new Date();
  if (await hasActiveRun(now)) {
    throw new ConflictError('RUN_IN_PROGRESS', 'A discovery run is already in progress.');
  }

  const runKey = manualRunKey(now);
  await startRun({ runKey, trigger: 'manual', requestedBy: user.id });
  const payload: DiscoveryRunPayload = { runKey };
  const handle = await tasks.trigger(TASK_IDS.discoveryRun, payload, { idempotencyKey: runKey });
  await attachTriggerRun(runKey, handle.id);
  return Response.json({ runKey, triggerRunId: handle.id }, { status: 202 });
});
