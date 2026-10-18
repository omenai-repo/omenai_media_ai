import {
  deactivateUser,
  findUserById,
  NotFoundError,
  reactivateUser,
  setUserRole,
} from '@repo/core';
import { ROLES } from '@repo/shared';
import * as z from 'zod';

import { apiHandler, readJson } from '@/lib/api';
import { requireOwner } from '@/lib/session';

const bodySchema = z
  .object({ role: z.enum(ROLES).optional(), status: z.enum(['active', 'deactivated']).optional() })
  .refine(
    (body) => body.role !== undefined || body.status !== undefined,
    'Provide a role or a status.',
  );

/**
 * Owner-only: change a member's role or access. The workspace always keeps an active owner, and
 * owners can't deactivate themselves; deactivation ends the member's sessions immediately.
 */
export const PATCH = apiHandler<RouteContext<'/api/team/users/[id]'>>(
  async (request, { params }) => {
    const owner = await requireOwner();
    const { id } = await params;
    const { role, status } = await readJson(request, bodySchema);
    if (role) await setUserRole({ userId: id, role });
    if (status === 'deactivated') await deactivateUser({ actorId: owner.id, userId: id });
    if (status === 'active') await reactivateUser(id);
    const user = await findUserById(id);
    if (!user) throw new NotFoundError('User not found.');
    return Response.json(user, { headers: { 'Cache-Control': 'no-store' } });
  },
);
