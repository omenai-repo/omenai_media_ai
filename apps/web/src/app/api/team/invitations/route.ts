import { inviteMember, requireEnv } from '@repo/core';
import { ROLES } from '@repo/shared';
import * as z from 'zod';

import { apiHandler, readJson } from '@/lib/api';
import { requireOwner } from '@/lib/session';

const bodySchema = z.object({
  email: z.email().max(254),
  role: z.enum(ROLES),
});

/** Owner-only: invite a member by email with a role. Returns the one-time link for sharing. */
export const POST = apiHandler(async (request) => {
  const owner = await requireOwner();
  const { email, role } = await readJson(request, bodySchema);
  const result = await inviteMember({
    email,
    role,
    invitedBy: owner.id,
    appUrl: requireEnv('BETTER_AUTH_URL'),
  });
  return Response.json(result, { status: 201, headers: { 'Cache-Control': 'no-store' } });
});
