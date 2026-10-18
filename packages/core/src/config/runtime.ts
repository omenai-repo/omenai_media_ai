import { ConfigError, optionalEnv, requireEnv } from './env.js';

/**
 * Which kind of environment this process is, stated explicitly (`OMENAI_RUNTIME`), never inferred
 * from what happens to be configured:
 *
 * - `live-dev`: local development against real services (Atlas `*_dev` database, Gemini, Tavily,
 *   the Trigger.dev development worker), within hard daily usage limits.
 * - `fixtures`: development fixtures (a `*_fixtures` database, scripted model and fake search,
 *   work run in-process). The only runtime in which any mocked path may run.
 * - `production`: the deployed app.
 * - `test`: automated tests (an in-memory database). Accepted only under Vitest.
 *
 * The database name must agree with the runtime, so fixture data can't be served as live, live
 * work can't land in a fixtures database, and production can't point at either. A missing or
 * contradictory setting stops the process with a ConfigError naming the variable.
 */
export const RUNTIMES = ['live-dev', 'fixtures', 'production', 'test'] as const;
export type Runtime = (typeof RUNTIMES)[number];

export function readRuntime(): Runtime {
  const value = requireEnv('OMENAI_RUNTIME');
  if (!(RUNTIMES as readonly string[]).includes(value))
    throw new ConfigError('OMENAI_RUNTIME', `expected one of ${RUNTIMES.join(', ')}`);
  if (value === 'test' && !process.env.VITEST)
    throw new ConfigError('OMENAI_RUNTIME', '"test" is only for automated tests');
  return value as Runtime;
}

/** Throws unless `dbName` is the kind of database this runtime may use. */
export function assertDatabaseForRuntime(runtime: Runtime, dbName: string): void {
  const fixtures = dbName.endsWith('_fixtures');
  const dev = dbName.endsWith('_dev');
  const test = dbName.endsWith('_test');
  const fail = (rule: string) => {
    throw new ConfigError('MONGODB_DB_NAME', `"${dbName}" ${rule} (OMENAI_RUNTIME=${runtime})`);
  };
  switch (runtime) {
    case 'fixtures':
      if (!fixtures) fail('must end in _fixtures for development fixtures');
      return;
    case 'live-dev':
      if (!dev) fail('must be a development database ending in _dev');
      return;
    case 'production':
      if (fixtures || dev || test) fail('is a development or test database');
      return;
    case 'test':
      return;
  }
}

/** The configured database name, required and checked against the runtime. */
export function configuredDatabaseName(): string {
  const runtime = readRuntime();
  const dbName = requireEnv('MONGODB_DB_NAME');
  assertDatabaseForRuntime(runtime, dbName);
  return dbName;
}

/**
 * True only in the fixtures runtime with a fixtures database: the single gate for every mocked
 * path (scripted model, fake search, in-process execution, simulated email). Never true in any
 * other runtime, whatever the database is called.
 */
export function isFixtureRuntime(): boolean {
  if (readRuntime() !== 'fixtures') return false;
  configuredDatabaseName();
  return true;
}

/** The Trigger.dev environment a runtime must dispatch to and run in. */
export function expectedTriggerEnvironment(runtime: Runtime): 'DEVELOPMENT' | 'PRODUCTION' | null {
  if (runtime === 'live-dev' || runtime === 'fixtures') return 'DEVELOPMENT';
  if (runtime === 'production') return 'PRODUCTION';
  return null;
}

/**
 * Before anything is handed to Trigger.dev: the secret key must belong to the runtime's
 * environment (by its prefix; the key itself is never shown), so live development can never
 * trigger production work and production never triggers development work.
 */
export function assertTriggerKeyForRuntime(): void {
  const runtime = readRuntime();
  const key = requireEnv('TRIGGER_SECRET_KEY');
  const expected =
    runtime === 'production' ? 'tr_prod_' : runtime === 'live-dev' ? 'tr_dev_' : null;
  if (expected && !key.startsWith(expected))
    throw new ConfigError(
      'TRIGGER_SECRET_KEY',
      `expected a ${expected}… key for OMENAI_RUNTIME=${runtime}`,
    );
}

/** Hard daily limits for live development; optional elsewhere. */
export function usageLimits(): { aiCalls: number | null; searchCredits: number | null } {
  const runtime = readRuntime();
  const read = (name: string) => {
    const raw = runtime === 'live-dev' ? requireEnv(name) : optionalEnv(name);
    if (raw === undefined) return null;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1)
      throw new ConfigError(name, 'expected a whole number ≥ 1');
    return value;
  };
  return { aiCalls: read('AI_DAILY_CALL_LIMIT'), searchCredits: read('SEARCH_DAILY_CREDIT_LIMIT') };
}
