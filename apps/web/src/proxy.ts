import { getSessionCookie } from 'better-auth/cookies';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Optimistic redirect only: checks that a session cookie *exists* so signed-out visitors go
 * straight to /login. It does not validate the session. Every page and route handler performs
 * the real check (`requirePageUser` / `requireUser`) against the database.
 */
export function proxy(request: NextRequest) {
  if (!getSessionCookie(request)) {
    const loginUrl = new URL('/login', request.url);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}

export const config = {
  // Everything except public pages, API routes (which answer 401 themselves) and static assets.
  matcher: [
    '/((?!login|invite|api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|webp|ico)$).*)',
  ],
};
