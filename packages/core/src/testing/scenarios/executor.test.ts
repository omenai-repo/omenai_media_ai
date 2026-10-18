import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getModels } from '../../db/models.js';
import { startRun } from '../../discovery/runs.js';
import { startTestDatabase, type TestDatabase } from '../index.js';
import { runFixtureDiscovery } from './executor.js';

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
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('fixture search started by hand (development fixtures only)', () => {
  it('refuses to run outside the fixtures runtime, whatever the database is called', async () => {
    vi.stubEnv('MONGODB_DB_NAME', 'omenai_fixtures');
    await expect(runFixtureDiscovery('manual:2026-10-16T15:00:00.000Z')).rejects.toThrow(
      /fixtures runtime/,
    );
    const { WorkflowRun } = await getModels();
    expect(await WorkflowRun.countDocuments()).toBe(0);
  });

  it('runs the real pipeline on scripted pages, records only simulated usage, and finds nothing new twice', async () => {
    vi.stubEnv('OMENAI_RUNTIME', 'fixtures');
    vi.stubEnv('MONGODB_DB_NAME', 'omenai_fixtures');
    const { WorkflowRun, AiUsage } = await getModels();

    const first = 'manual:2026-10-16T15:00:00.000Z';
    await startRun({ runKey: first, trigger: 'manual', requestedBy: 'owner-1' });
    await runFixtureDiscovery(first, { stepDelayMs: 0 });
    const run = (await WorkflowRun.findOne({ runKey: first }).lean())!;
    expect(run).toMatchObject({ status: 'completed', trigger: 'manual', requestedBy: 'owner-1' });
    // Two stories meet the standard; the listicle is held back by its editorial check.
    expect(run.shortlist).toHaveLength(2);
    expect(run.outcomes.map((o) => o.outcome).sort()).toEqual([
      'gate_reject',
      'qualified',
      'qualified',
    ]);
    const usage = await AiUsage.find({ runKey: first }).lean();
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.every((u) => u.simulated)).toBe(true);

    // Every page has been seen, so a second search the same day has nothing to recommend.
    const second = 'manual:2026-10-16T15:30:00.000Z';
    await startRun({ runKey: second, trigger: 'manual', requestedBy: 'owner-1' });
    await runFixtureDiscovery(second, { stepDelayMs: 0 });
    expect(await WorkflowRun.findOne({ runKey: second }).lean()).toMatchObject({
      status: 'completed',
      shortlist: [],
    });
  });
});
