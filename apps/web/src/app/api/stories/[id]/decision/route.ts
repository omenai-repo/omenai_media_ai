import { decideStory, STORY_DECISIONS } from '@repo/core';
import * as z from 'zod';

import { apiHandler, readJson } from '@/lib/api';
import { requireUser } from '@/lib/session';

const bodySchema = z.object({
  decision: z.enum(STORY_DECISIONS),
  reason: z.string().trim().max(500).optional(),
});

/** Save, unsave, skip or unskip a story. Workspace-wide, with an audit trail. */
export const POST = apiHandler<RouteContext<'/api/stories/[id]/decision'>>(
  async (request, { params }) => {
    const user = await requireUser('stories:decide');
    const { id } = await params;
    const { decision, reason } = await readJson(request, bodySchema);
    const result = await decideStory({ storyId: id, userId: user.id, decision, reason });
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  },
);
