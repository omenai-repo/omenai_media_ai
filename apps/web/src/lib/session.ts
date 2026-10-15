import { can, type Action } from '@repo/shared';
import { findUserById, ForbiddenError, UnauthenticatedError, type AppUser } from '@repo/core';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

import { getAuth } from './auth';

/**
 * Resolves the signed-in user from the Better Auth session *and* our user record, so role
 * changes and deactivation take effect on the very next request.
 */
export async function getCurrentUser(): Promise<AppUser | null> {
  // Read the request first: during prerendering this is where rendering stops, so the database
  // and auth configuration are never touched at build time.
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  if (!session) return null;
  const user = await findUserById(session.user.id);
  return user?.status === 'active' ? user : null;
}

/** For route handlers: throws 401/403 errors that `apiHandler` turns into JSON responses. */
export async function requireUser(action: Action = 'stories:read'): Promise<AppUser> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthenticatedError();
  if (!can(user.role, action)) throw new ForbiddenError();
  return user;
}

export function requireOwner(): Promise<AppUser> {
  return requireUser('team:manage');
}

/** For pages: redirects to sign-in, and hides owner-only pages from editors. */
export async function requirePageUser(action: Action = 'stories:read'): Promise<AppUser> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (!can(user.role, action)) notFound();
  return user;
}
