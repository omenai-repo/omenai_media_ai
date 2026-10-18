import { revokeInvitation } from '@repo/core';

import { apiHandler } from '@/lib/api';
import { requireOwner } from '@/lib/session';

/** Owner-only: revoke an open invitation so its link stops working. */
export const DELETE = apiHandler<RouteContext<'/api/team/invitations/[id]'>>(
  async (_request, { params }) => {
    await requireOwner();
    const { id } = await params;
    await revokeInvitation(id);
    return new Response(null, { status: 204 });
  },
);
