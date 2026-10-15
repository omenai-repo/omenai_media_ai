import type { HealthResponse } from '@repo/shared';

/** Current service status, shared by `GET /api/health` and the homepage. */
export function getHealth(): HealthResponse {
  return {
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  };
}
