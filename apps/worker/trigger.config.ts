import { defineConfig } from '@trigger.dev/sdk';

export default defineConfig({
  // Not a secret: identifies the Trigger.dev project. Credentials come from `trigger login`
  // (CLI) and TRIGGER_SECRET_KEY (apps that trigger tasks).
  project: 'proj_ydafdiqitotsvbyazmaw',
  dirs: ['./src/trigger'],
  runtime: 'node-24',
  // Generous ceiling; individual tasks set tighter limits where they need them.
  maxDuration: 3600,
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
