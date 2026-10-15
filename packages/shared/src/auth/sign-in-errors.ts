/**
 * User-facing copy for authentication failures, keyed by the stable error codes our auth layer
 * returns. Only these fixed messages are shown; raw server text is never echoed.
 */
const AUTH_ERRORS: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: 'That email and password don’t match. Check both and try again.',
  ACCOUNT_DEACTIVATED: 'This account has been deactivated. Contact a workspace owner.',
  TOO_MANY_REQUESTS: 'Too many attempts. Wait a minute, then try again.',
  INVITATION_REQUIRED:
    'Access to the newsroom is by invitation. Open the invitation link you were sent.',
  INVITATION_INVALID: 'That invitation link is not valid. Ask a workspace owner for a new one.',
  INVITATION_EXPIRED: 'That invitation has expired. Ask a workspace owner for a new one.',
  INVITATION_REVOKED:
    'That invitation has been revoked. Ask a workspace owner if this is a mistake.',
  INVITATION_ACCEPTED: 'That invitation has already been used. Sign in instead.',
  PASSWORD_TOO_SHORT: 'That password is too short. Use at least 12 characters.',
  PASSWORD_TOO_LONG: 'That password is too long. Use at most 128 characters.',
};

const GENERIC_AUTH_ERROR = 'Something went wrong. Please try again.';

export function authErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return AUTH_ERRORS[code] ?? GENERIC_AUTH_ERROR;
}
