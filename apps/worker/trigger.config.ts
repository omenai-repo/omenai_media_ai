import { defineConfig } from '@trigger.dev/sdk';

export default defineConfig({
  // Not a secret: identifies the Trigger.dev project. Credentials come from `trigger login`
  // (CLI) and TRIGGER_SECRET_KEY (apps that trigger tasks).
  project: 'proj_tiypkdhtraueqaxkqoqv',
  dirs: ['./src/trigger'],
  runtime: 'node-24',
  // Generous ceiling; individual tasks set tighter limits where they need them.
  maxDuration: 3600,
  // Reuse a warm process between runs instead of starting one per run: no repeated start-up and
  // MongoDB connection (about 3 s per run measured in development on 2026-10-16, and up to 17 s
  // when DNS was slow). Module state is safe to share: the same code runs in the long-lived web
  // app. Trigger.dev may still end a process at any time; the next run simply starts a new one.
  processKeepAlive: true,
  retries: {
    enabledInDev: true,
    // Brief: at most five attempts for retryable failures, with increasing delays. Permanent
    // failures throw AbortTaskRunError and are not retried.
    default: {
      maxAttempts: 5,
      factor: 2,
      minTimeoutInMs: 2_000,
      maxTimeoutInMs: 60_000,
      randomize: true,
    },
  },
});
