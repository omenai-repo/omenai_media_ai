import { getDraftProgress } from '@repo/core';

import { apiHandler } from '@/lib/api';
import { requireUser } from '@/lib/session';

/**
 * The drafts being written for a story: their steps and the text so far. One small query, polled
 * every second by the studio while a draft is written; the full view is read once it finishes.
 */
export const GET = apiHandler<RouteContext<'/api/stories/[id]/drafts/progress'>>(
  async (_request, { params }) => {
    await requireUser('stories:read');
    const { id } = await params;
    return Response.json(await getDraftProgress(id), { headers: { 'Cache-Control': 'no-store' } });
  },
);
