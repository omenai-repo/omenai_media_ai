import { getResearchView, requestResearch } from '@repo/core';
import * as z from 'zod';

import { apiHandler, readJson } from '@/lib/api';
import { requireUser } from '@/lib/session';
import { assertCanEnqueue, enqueueStoryTask } from '@/lib/story-tasks';

const NO_STORE = { 'Cache-Control': 'no-store' };

/** The research workspace's state (briefs, conversation, running task). Polled while work runs. */
export const GET = apiHandler<RouteContext<'/api/stories/[id]/research'>>(
  async (_request, { params }) => {
    await requireUser('stories:read');
    const { id } = await params;
    return Response.json(await getResearchView(id), { headers: NO_STORE });
  },
);

const bodySchema = z.object({
  depth: z.enum(['standard', 'in_depth']).default('standard'),
  /** Omenai's own first briefing, started when the workspace opens (refused once one exists). */
  auto: z.boolean().default(false),
  /** Follow up a lead from an assistant reply; the focus is read from that record, not sent. */
  fromMessageId: z
    .string()
    .regex(/^[a-f0-9]{24}$/)
    .optional(),
});

/**
 * Requests research. Records a task that holds the story's lock (409 if research or a reply is
 * already running), then hands it to the background worker. Nothing runs inline.
 */
export const POST = apiHandler<RouteContext<'/api/stories/[id]/research'>>(
  async (request, { params }) => {
    const user = await requireUser('research:request');
    assertCanEnqueue();
    const { id } = await params;
    const { depth, auto, fromMessageId } = await readJson(request, bodySchema);
    const { taskKey } = await requestResearch({
      storyId: id,
      userId: user.id,
      depth,
      kind: auto ? 'auto' : 'manual',
      fromMessageId,
    });
    await enqueueStoryTask('research', taskKey);
    return Response.json({ taskKey }, { status: 202, headers: NO_STORE });
  },
);
