import { mongodbAdapter } from '@better-auth/mongo-adapter';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, ROLES, USER_STATUSES } from '@repo/shared';
import type { BetterAuthOptions } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import type { Db, MongoClient } from 'mongodb';

import { ConfigError } from '../config/env.js';
import { AppError } from '../errors.js';
import {
  claimInvitation,
  completeInvitation,
  hasClaimableInvitation,
  InvitationRejectedError,
} from './invitations.js';
import { findUserById } from './users.js';

/**
 * The cookie name under which the invitation token reaches Better Auth's user-creation hook.
 * Our accept route sends it as a request header on its server-side sign-up call; the hook
 * rejects any sign-up that doesn't present a valid token for the same email.
 */
export const INVITE_COOKIE_NAME = 'omenai_invite';

/** Converts our domain errors into Better Auth errors with a precise, stable code. */
function toApiError(error: unknown): unknown {
  if (error instanceof InvitationRejectedError) {
    return new APIError('FORBIDDEN', { code: error.reason, message: error.message });
  }
  if (error instanceof AppError) {
    return new APIError('FORBIDDEN', { code: error.code, message: error.message });
  }
  return error;
}

export interface AuthConfig {
  client: MongoClient;
  db: Db;
  secret: string;
  baseURL: string;
  /** Sends the password-reset link. Absent until email delivery is configured. */
  sendPasswordResetEmail?: (input: { to: string; name: string; url: string }) => Promise<void>;
  /** Defaults to on in production (Better Auth's default), off elsewhere. */
  rateLimit?: boolean;
  plugins?: BetterAuthOptions['plugins'];
}

/**
 * Better Auth configuration for the newsroom: email + password, invitation-only sign-up, and two
 * app-owned user fields (`role`, `status`) that clients can never set.
 */
export function createAuthOptions(config: AuthConfig) {
  return {
    secret: config.secret,
    baseURL: config.baseURL,
    database: mongodbAdapter(config.db, { client: config.client }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      // The invitee is signed in straight after setting their password.
      autoSignIn: true,
      // The invitation link was delivered to this address, which proves control of it.
      requireEmailVerification: false,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 60,
      sendResetPassword: async ({ user, url }) => {
        if (!config.sendPasswordResetEmail) {
          throw new ConfigError('RESEND_API_KEY', 'password reset emails are not configured');
        }
        await config.sendPasswordResetEmail({ to: user.email, name: user.name, url });
      },
    },
    user: {
      additionalFields: {
        role: { type: [...ROLES], required: false, defaultValue: 'editor', input: false },
        status: { type: [...USER_STATUSES], required: false, defaultValue: 'active', input: false },
      },
    },
    account: { accountLinking: { enabled: false } },
    rateLimit: {
      enabled: config.rateLimit ?? process.env.NODE_ENV === 'production',
      // Shared across serverless instances; in-memory limits would reset per instance.
      storage: 'database',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
        '/sign-up/email': { window: 300, max: 5 },
        '/request-password-reset': { window: 300, max: 3 },
        '/reset-password': { window: 300, max: 5 },
      },
    },
    hooks: {
      /**
       * Gate the public sign-up endpoint before Better Auth checks whether the email exists:
       * without this, "user already exists" (422) vs "invitation required" (403) would reveal
       * which emails have accounts. Every rejection here looks identical.
       */
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-up/email') return;
        const email = (ctx.body as { email?: unknown } | undefined)?.email;
        const allowed =
          typeof email === 'string' &&
          (await hasClaimableInvitation(ctx.getCookie(INVITE_COOKIE_NAME), email));
        if (!allowed) {
          throw new APIError('FORBIDDEN', {
            code: 'INVITATION_REQUIRED',
            message:
              'Access is by invitation only. Open the invitation link you were sent to join.',
          });
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          // The only way a user record can be created, whichever endpoint is called.
          before: async (user, context) => {
            try {
              const { role } = await claimInvitation({
                token: context?.getCookie(INVITE_COOKIE_NAME),
                email: user.email,
              });
              return { data: { ...user, role, status: 'active', emailVerified: true } };
            } catch (error) {
              throw toApiError(error);
            }
          },
          // Runs only after the user is committed.
          after: async (user) => {
            await completeInvitation({ email: user.email, userId: user.id });
          },
        },
      },
      session: {
        create: {
          before: async (session, context) => {
            // During sign-up the user and its first session are created in one transaction, so
            // read through Better Auth's transaction-aware adapter when a request is in flight.
            const user = context
              ? ((await context.context.internalAdapter.findUserById(session.userId)) as {
                  status?: string;
                } | null)
              : await findUserById(session.userId);
            if (!user || user.status !== 'active') {
              throw new APIError('FORBIDDEN', {
                code: 'ACCOUNT_DEACTIVATED',
                message: 'This account has been deactivated. Contact a workspace owner.',
              });
            }
          },
        },
      },
    },
    plugins: config.plugins ?? [],
  } satisfies BetterAuthOptions;
}
