import type { Role } from '@repo/shared';

import { invitationEmail, isEmailConfigured, sendEmail } from '../email/index.js';
import { createInvitation, type InvitationSummary } from './invitations.js';

/**
 * Invites a member: creates the invitation and emails the link when email is configured. The
 * link is always returned so the owner can share it directly; a failed email never loses the
 * invitation.
 */
export async function inviteMember(input: {
  email: string;
  role: Role;
  invitedBy: string;
  appUrl: string;
}): Promise<{
  invitation: InvitationSummary;
  link: string;
  emailed: boolean;
  emailError: string | null;
}> {
  const { invitation, token } = await createInvitation(input);
  const link = `${input.appUrl.replace(/\/$/, '')}/invite/${token}`;
  if (!isEmailConfigured()) return { invitation, link, emailed: false, emailError: null };

  const result = await sendEmail(
    invitationEmail({
      to: invitation.email,
      role: invitation.role,
      link,
      expiresAt: invitation.expiresAt,
    }),
  );
  return {
    invitation,
    link,
    emailed: result.sent,
    emailError: result.sent ? null : (result.error ?? result.reason),
  };
}
