import { createAuthOptions, getDatabase, getMongoClient, requireEnv } from '@repo/core';
import { betterAuth } from 'better-auth';
import { nextCookies } from 'better-auth/next-js';

function createAuth() {
  return betterAuth(
    createAuthOptions({
      client: getMongoClient(),
      db: getDatabase(),
      secret: requireEnv('BETTER_AUTH_SECRET'),
      baseURL: requireEnv('BETTER_AUTH_URL'),
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
