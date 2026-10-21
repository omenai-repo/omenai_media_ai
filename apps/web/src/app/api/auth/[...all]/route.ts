import { toNextJsHandler } from 'better-auth/next-js';

import { getReadyAuth } from '@/lib/auth';

// Resolved per request so the auth instance (and its secrets) is created lazily.
export async function GET(request: Request) {
  return toNextJsHandler(await getReadyAuth()).GET(request);
}

export async function POST(request: Request) {
  return toNextJsHandler(await getReadyAuth()).POST(request);
}
