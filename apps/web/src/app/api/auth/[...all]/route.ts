import { toNextJsHandler } from 'better-auth/next-js';

import { getAuth } from '@/lib/auth';

// Resolved per request so the auth instance (and its secrets) is created lazily.
export function GET(request: Request) {
  return toNextJsHandler(getAuth()).GET(request);
}

export function POST(request: Request) {
  return toNextJsHandler(getAuth()).POST(request);
}
