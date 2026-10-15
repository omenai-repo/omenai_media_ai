import { getConnection } from '@repo/core';
import { task } from '@trigger.dev/sdk';

/**
 * Operational check: proves the worker can reach MongoDB with its deployed configuration.
 * Trigger it from the Trigger.dev dashboard after setting environment variables.
 */
export const opsDatabasePing = task({
  id: 'ops-database-ping',
  retry: { maxAttempts: 1 },
  run: async () => {
    const connection = await getConnection();
    const started = Date.now();
    await connection.db!.admin().ping();
    return { ok: true, database: connection.name, latencyMs: Date.now() - started };
  },
});
