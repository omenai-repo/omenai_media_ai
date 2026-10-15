import { emptyFunnel } from '@repo/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startTestDatabase, type TestDatabase } from '../testing/index.js';
import {
  claimRun,
  closeCandidateSet,
  completeRun,
  failRun,
  getRun,
  MAX_RUN_ATTEMPTS,
  renewLease,
  startRun,
  tryUseEscalation,
} from './runs.js';

let db: TestDatabase;
beforeAll(async () => {
  db = await startTestDatabase();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
});

const RUN = 'daily-discovery:2026-11-01';
const config = {
  leaseMs: 60_000,
  softDeadlineMinutes: 120,
  extensionDeadlineMinutes: 180,
  hardDeadlineMinutes: 240,
};
const T0 = new Date('2026-11-01T05:00:00Z');
const later = (ms: number) => new Date(T0.getTime() + ms);

describe('run identity and idempotency', () => {
  it('creates one run for concurrent starts of the same day (schedule + manual retry + duplicate)', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => startRun({ runKey: RUN, trigger: 'schedule' })),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await db.db.collection('workflowRuns').countDocuments({ runKey: RUN })).toBe(1);
  });
});

describe('leases', () => {
  it('lets exactly one worker claim a run', async () => {
    await startRun({ runKey: RUN, trigger: 'schedule' });
    const claims = await Promise.all([
      claimRun({ runKey: RUN, owner: 'a', now: T0, config }),
      claimRun({ runKey: RUN, owner: 'b', now: T0, config }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('fixes deadlines at first start and keeps them on resume', async () => {
    await startRun({ runKey: RUN, trigger: 'schedule' });
    const first = await claimRun({ runKey: RUN, owner: 'a', now: T0, config });
    expect(first?.deadlines?.soft?.toISOString()).toBe(later(120 * 60_000).toISOString());
    expect(first?.deadlines?.hard?.toISOString()).toBe(later(240 * 60_000).toISOString());

    // Worker "a" dies; after the lease expires "b" resumes with the same deadlines.
    const resumed = await claimRun({ runKey: RUN, owner: 'b', now: later(61_000), config });
    expect(resumed?.leaseOwner).toBe('b');
    expect(resumed?.deadlines?.hard?.toISOString()).toBe(first?.deadlines?.hard?.toISOString());
    expect(resumed?.attempts).toBe(2);
  });

  it('does not let a second worker take a live lease, and renewal keeps it alive', async () => {
    await startRun({ runKey: RUN, trigger: 'schedule' });
    await claimRun({ runKey: RUN, owner: 'a', now: T0, config });
    expect(await claimRun({ runKey: RUN, owner: 'b', now: later(30_000), config })).toBeNull();
    expect(await renewLease({ runKey: RUN, owner: 'a', now: later(50_000), leaseMs: 60_000 })).toBe(
      true,
    );
    expect(await claimRun({ runKey: RUN, owner: 'b', now: later(100_000), config })).toBeNull();
    expect(
      await renewLease({ runKey: RUN, owner: 'b', now: later(100_000), leaseMs: 60_000 }),
    ).toBe(false);
  });

  it('never reruns a completed run', async () => {
    await startRun({ runKey: RUN, trigger: 'schedule' });
    await claimRun({ runKey: RUN, owner: 'a', now: T0, config });
    const done = await completeRun({
      runKey: RUN,
      owner: 'a',
      now: later(1000),
      funnel: emptyFunnel(),
      shortlist: [],
      outcomes: [],
      shortfallReasons: [],
    });
    expect(done).toBe(true);
    expect(await claimRun({ runKey: RUN, owner: 'b', now: later(10 * 60_000), config })).toBeNull();
    expect((await getRun(RUN))?.status).toBe('completed');
  });

  it('only the lease owner can complete a run', async () => {
    await startRun({ runKey: RUN, trigger: 'schedule' });
    await claimRun({ runKey: RUN, owner: 'a', now: T0, config });
    const stolen = await completeRun({
      runKey: RUN,
      owner: 'intruder',
      now: T0,
      funnel: emptyFunnel(),
      shortlist: [],
      outcomes: [],
      shortfallReasons: [],
    });
    expect(stolen).toBe(false);
  });

  it('retries a failed run a bounded number of times', async () => {
    await startRun({ runKey: RUN, trigger: 'schedule' });
    for (let i = 0; i < MAX_RUN_ATTEMPTS; i += 1) {
      const claim = await claimRun({ runKey: RUN, owner: `w${i}`, now: later(i), config });
      expect(claim).not.toBeNull();
      await failRun({ runKey: RUN, owner: `w${i}`, stage: 'discover', message: 'boom' });
    }
    expect(await claimRun({ runKey: RUN, owner: 'last', now: later(99), config })).toBeNull();
    expect((await getRun(RUN))?.runErrors).toHaveLength(MAX_RUN_ATTEMPTS);
  });
});

describe('run-wide budgets', () => {
  it('caps escalations atomically under concurrency', async () => {
    await startRun({ runKey: RUN, trigger: 'schedule' });
    const grants = await Promise.all(Array.from({ length: 10 }, () => tryUseEscalation(RUN, 4)));
    expect(grants.filter(Boolean)).toHaveLength(4);
  });

  it('closes the candidate set once; the first close time wins', async () => {
    await startRun({ runKey: RUN, trigger: 'schedule' });
    const first = await closeCandidateSet(RUN, later(1));
    const second = await closeCandidateSet(RUN, later(999));
    expect(second.toISOString()).toBe(first.toISOString());
  });
});
