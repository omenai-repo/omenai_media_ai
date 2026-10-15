import { healthResponseSchema } from '@repo/shared';
import { describe, expect, it, vi } from 'vitest';

// `connection()` only works inside a Next.js request scope.
vi.mock('next/server', () => ({ connection: () => Promise.resolve() }));

import { GET } from './route';

describe('GET /api/health', () => {
  it('reports the service status as JSON', async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toMatch(/^application\/json/);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(healthResponseSchema.parse(await response.json()).status).toBe('ok');
  });
});
