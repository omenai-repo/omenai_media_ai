import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigError } from './env.js';
import {
  assertDatabaseForRuntime,
  assertTriggerKeyForRuntime,
  configuredDatabaseName,
  isFixtureRuntime,
  readRuntime,
  usageLimits,
} from './runtime.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('runtime: stated explicitly, never inferred', () => {
  it('requires OMENAI_RUNTIME and accepts "test" only under Vitest', () => {
    vi.stubEnv('OMENAI_RUNTIME', '');
    expect(() => readRuntime()).toThrow(ConfigError);
    vi.stubEnv('OMENAI_RUNTIME', 'staging');
    expect(() => readRuntime()).toThrow(/OMENAI_RUNTIME/);
    vi.stubEnv('OMENAI_RUNTIME', 'test');
    expect(readRuntime()).toBe('test');
    vi.stubEnv('VITEST', '');
    expect(() => readRuntime()).toThrow(/only for automated tests/);
  });

  it('never assumes a database: a missing name stops the process', () => {
    vi.stubEnv('OMENAI_RUNTIME', 'live-dev');
    vi.stubEnv('MONGODB_DB_NAME', '');
    expect(() => configuredDatabaseName()).toThrow(/MONGODB_DB_NAME/);
  });

  it('keeps each runtime to its own kind of database', () => {
    expect(() => assertDatabaseForRuntime('live-dev', 'omenai_live_dev')).not.toThrow();
    for (const name of ['omenai', 'omenai_fixtures', 'omenai_test'])
      expect(() => assertDatabaseForRuntime('live-dev', name)).toThrow(ConfigError);
    expect(() => assertDatabaseForRuntime('fixtures', 'omenai_fixtures')).not.toThrow();
    for (const name of ['omenai', 'omenai_live_dev'])
      expect(() => assertDatabaseForRuntime('fixtures', name)).toThrow(ConfigError);
    expect(() => assertDatabaseForRuntime('production', 'omenai')).not.toThrow();
    for (const name of ['omenai_live_dev', 'omenai_fixtures', 'omenai_test'])
      expect(() => assertDatabaseForRuntime('production', name)).toThrow(ConfigError);
  });

  it('allows mocked paths only in the fixtures runtime with a fixtures database', () => {
    vi.stubEnv('MONGODB_DB_NAME', 'omenai_fixtures');
    for (const runtime of ['test', 'live-dev', 'production']) {
      vi.stubEnv('OMENAI_RUNTIME', runtime);
      expect(isFixtureRuntime()).toBe(false);
    }
    vi.stubEnv('OMENAI_RUNTIME', 'fixtures');
    expect(isFixtureRuntime()).toBe(true);
    // Contradictory: the fixtures runtime pointed at a real database is refused, not ignored.
    vi.stubEnv('MONGODB_DB_NAME', 'omenai_live_dev');
    expect(() => isFixtureRuntime()).toThrow(ConfigError);
  });

  it('only dispatches to the Trigger.dev environment that matches the runtime', () => {
    vi.stubEnv('OMENAI_RUNTIME', 'live-dev');
    vi.stubEnv('TRIGGER_SECRET_KEY', 'tr_prod_example');
    expect(() => assertTriggerKeyForRuntime()).toThrow(/tr_dev_/);
    vi.stubEnv('TRIGGER_SECRET_KEY', 'tr_dev_example');
    expect(() => assertTriggerKeyForRuntime()).not.toThrow();
    vi.stubEnv('OMENAI_RUNTIME', 'production');
    expect(() => assertTriggerKeyForRuntime()).toThrow(/tr_prod_/);
    // The key itself never appears in the message.
    try {
      assertTriggerKeyForRuntime();
    } catch (error) {
      expect((error as Error).message).not.toContain('tr_dev_example');
    }
  });

  it('requires daily usage limits in live development', () => {
    vi.stubEnv('OMENAI_RUNTIME', 'live-dev');
    vi.stubEnv('AI_DAILY_CALL_LIMIT', '');
    vi.stubEnv('SEARCH_DAILY_CREDIT_LIMIT', '20');
    expect(() => usageLimits()).toThrow(/AI_DAILY_CALL_LIMIT/);
    vi.stubEnv('AI_DAILY_CALL_LIMIT', '0');
    expect(() => usageLimits()).toThrow(/whole number/);
    vi.stubEnv('AI_DAILY_CALL_LIMIT', '60');
    expect(usageLimits()).toEqual({ aiCalls: 60, searchCredits: 20 });
    vi.stubEnv('OMENAI_RUNTIME', 'test');
    vi.stubEnv('AI_DAILY_CALL_LIMIT', '');
    vi.stubEnv('SEARCH_DAILY_CREDIT_LIMIT', '');
    expect(usageLimits()).toEqual({ aiCalls: null, searchCredits: null });
  });
});
