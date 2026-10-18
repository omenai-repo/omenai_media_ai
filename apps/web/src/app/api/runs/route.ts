import { ConflictError, hasActiveRun, startRun } from '@repo/core';
import { manualRunKey } from '@repo/shared';

import { apiHandler } from '@/lib/api';
import { requireUser } from '@/lib/session';
import { assertCanEnqueue, enqueueDiscoveryRun } from '@/lib/story-tasks';

/**
 * Owner-only: start a discovery run now instead of waiting for midnight. The run itself executes
 * in Trigger.dev (in-process, scripted, against a fixtures database); this request only records
 * and enqueues it. Overlapping runs are refused.
 */
export const POST = apiHandler(async () => {
  const user = await requireUser('runs:trigger');
  assertCanEnqueue();
  const now = new Date();
  if (await hasActiveRun(now)) {
    throw new ConflictError(
      'RUN_IN_PROGRESS',
      'A search for stories is already running. The new edition appears when it finishes.',
    );
  }

  const runKey = manualRunKey(now);
  await startRun({ runKey, trigger: 'manual', requestedBy: user.id });
  const triggerRunId = await enqueueDiscoveryRun(runKey);
  return Response.json({ runKey, triggerRunId }, { status: 202 });
});
