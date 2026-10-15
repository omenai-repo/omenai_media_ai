import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./vitest.global-setup.ts'],
    // DB-backed suites start an in-memory replica set.
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
