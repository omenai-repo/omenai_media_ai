'use client';

import { createAuthClient } from 'better-auth/react';

/** Browser-side Better Auth client; talks to /api/auth on the same origin. */
export const authClient = createAuthClient();
