import {
  createAuthOptions,
  ensureDatabaseConnection,
  getDatabase,
  getMongoClient,
  passwordResetEmail,
  requireEnv,
  sendEmail,
} from '@repo/core';
import { betterAuth } from 'better-auth';
import { nextCookies } from 'better-auth/next-js';

function createAuth() {
  return betterAuth(
    createAuthOptions({
      client: getMongoClient(),
      db: getDatabase(),
      secret: requireEnv('BETTER_AUTH_SECRET'),
      baseURL: requireEnv('BETTER_AUTH_URL'),
      sendPasswordResetEmail: async (message) => {
        const result = await sendEmail(passwordResetEmail(message));
        if (!result.sent) throw new Error(`Password reset email not sent (${result.reason}).`);
      },
      // Must stay last: applies cookies set during server actions.
      plugins: [nextCookies()],
    }),
  );
}

let auth: ReturnType<typeof createAuth> | undefined;

/**
 * The Better Auth instance, created on first use rather than at import time so `next build`
 * doesn't need production secrets, and a missing variable surfaces as a clear ConfigError.
 */
export function getAuth(): ReturnType<typeof createAuth> {
  auth ??= createAuth();
  return auth;
}

/**
 * The auth instance, with the shared database client checked first. Better Auth's adapter uses
 * the client without connecting it, so after one failed connect it would fail every request on
 * this instance with "Topology is closed" (production, 2026-10-21); this repairs that.
 */
export async function getReadyAuth(): Promise<ReturnType<typeof createAuth>> {
  await ensureDatabaseConnection();
  return getAuth();
}
