import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Honor the `@/*` path alias from tsconfig.json.
    tsconfigPaths: true,
  },
  test: {
    // Automated tests run in their own runtime (an in-memory database). A test that exercises a
    // fixture path opts in explicitly with OMENAI_RUNTIME=fixtures and a *_fixtures name.
    env: { OMENAI_RUNTIME: 'test' },
    globalSetup: ['./vitest.global-setup.ts'],
    // DB-backed suites start an in-memory replica set.
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
