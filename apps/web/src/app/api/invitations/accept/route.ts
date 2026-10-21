import { AppError, INVITE_COOKIE_NAME, inspectInvitationToken } from '@repo/core';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@repo/shared';
import * as z from 'zod';

import { apiHandler, readJson } from '@/lib/api';
import { getReadyAuth } from '@/lib/auth';

const bodySchema = z.object({
  token: z.string().min(16).max(256),
  name: z.string().trim().min(1).max(80),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
});

const UNUSABLE = {
  invalid: ['INVITATION_INVALID', 'This invitation link is not valid.'],
  expired: [
    'INVITATION_EXPIRED',
    'This invitation has expired. Ask a workspace owner for a new one.',
  ],
  revoked: ['INVITATION_REVOKED', 'This invitation has been revoked.'],
  accepted: ['INVITATION_ACCEPTED', 'This invitation has already been used. Sign in instead.'],
} as const;

/**
 * Accepts an invitation: creates the account with the invitee's chosen password and signs them
 * in. The email always comes from the invitation, never from the request.
 *
 * The token is passed to Better Auth as the invite cookie on this server-side call. Better
 * Auth's sign-up gate and user-creation hook check it again and atomically claim the
 * invitation, so this route grants nothing the hooks wouldn't.
 */
export const POST = apiHandler(async (request) => {
  const { token, name, password } = await readJson(request, bodySchema);
  const { state, invitation } = await inspectInvitationToken(token);
  if (state !== 'valid' || !invitation) {
    const [code, message] = UNUSABLE[state === 'valid' ? 'invalid' : state];
    throw new AppError(code, message, 410);
  }

  // The nextCookies plugin copies the new session cookie onto this response.
  await (
    await getReadyAuth()
  ).api.signUpEmail({
    body: { email: invitation.email, password, name },
    headers: new Headers({ cookie: `${INVITE_COOKIE_NAME}=${token}` }),
  });

  return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
});
