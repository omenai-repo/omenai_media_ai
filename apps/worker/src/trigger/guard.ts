import { expectedTriggerEnvironment, getDatabaseName, readRuntime } from '@repo/core';
import { AbortTaskRunError } from '@trigger.dev/sdk';

/**
 * Before any work: this worker must be running in the Trigger.dev environment its runtime
 * belongs to (live development and fixtures in DEVELOPMENT, production in PRODUCTION), and, when
 * a request names its database, use that same database. A mismatch aborts without touching
 * anything: retrying a configuration problem would never help.
 */
export function assertSameEnvironment(environment: string, requestedDatabase?: string): void {
  try {
    const runtime = readRuntime();
    const expected = expectedTriggerEnvironment(runtime);
    if (expected && environment !== expected)
      throw new Error(
        `This worker is configured for OMENAI_RUNTIME=${runtime} but runs in the ${environment} Trigger.dev environment.`,
      );
    const own = getDatabaseName();
    if (requestedDatabase !== undefined && requestedDatabase !== own)
      throw new Error(
        `Database mismatch: the request came from "${requestedDatabase}", but this worker uses "${own}". Nothing was done.`,
      );
  } catch (error) {
    throw new AbortTaskRunError(error instanceof Error ? error.message : String(error));
  }
}
