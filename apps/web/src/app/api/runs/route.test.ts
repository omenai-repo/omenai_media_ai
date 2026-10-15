import { ForbiddenError, getModels } from '@repo/core';
import { startTestDatabase, type TestDatabase } from '@repo/core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const trigger = vi.fn();
const requireUser = vi.fn();

vi.mock('next/server', () => ({ connection: () => Promise.resolve() }));
// No real Trigger.dev call is made in tests.
vi.mock('@trigger.dev/sdk', () => ({ tasks: { trigger } }));
vi.mock('@/lib/session', () => ({ requireUser }));

const { POST } = await import('./route');

let db: TestDatabase;
beforeAll(async () => {
  db = await startTestDatabase();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  trigger.mockReset().mockResolvedValue({ id: 'run_test_123' });
  requireUser.mockReset();
  process.env.TRIGGER_SECRET_KEY = 'tr_dev_test';
});

const post = () => POST(new Request('http://localhost/api/runs', { method: 'POST' }), undefined);

describe('POST /api/runs', () => {
  it('refuses editors (server-side), without creating or triggering anything', async () => {
    requireUser.mockRejectedValue(new ForbiddenError());
    const response = await post();
    expect(response.status).toBe(403);
    expect(trigger).not.toHaveBeenCalled();
    const { WorkflowRun } = await getModels();
    expect(await WorkflowRun.countDocuments()).toBe(0);
  });

  it('lets an owner start a manual run, idempotently keyed by its run key', async () => {
    requireUser.mockResolvedValue({ id: 'owner-1', role: 'owner' });
    const response = await post();
    expect(response.status).toBe(202);
    const body = (await response.json()) as { runKey: string };
    expect(body.runKey).toMatch(/^manual:/);
    expect(trigger).toHaveBeenCalledWith(
      'discovery-run',
      { runKey: body.runKey },
      { idempotencyKey: body.runKey },
    );
    const { WorkflowRun } = await getModels();
    expect(await WorkflowRun.findOne({ runKey: body.runKey }).lean()).toMatchObject({
      trigger: 'manual',
      requestedBy: 'owner-1',
      triggerRunId: 'run_test_123',
    });
  });

  it('refuses to overlap a run that is in progress', async () => {
    requireUser.mockResolvedValue({ id: 'owner-1', role: 'owner' });
    await db.db.collection('workflowRuns').insertOne({
      runKey: 'daily-discovery:2026-10-15',
      trigger: 'schedule',
      status: 'running',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const response = await post();
    expect(response.status).toBe(409);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('reports missing Trigger.dev configuration clearly', async () => {
    requireUser.mockResolvedValue({ id: 'owner-1', role: 'owner' });
    delete process.env.TRIGGER_SECRET_KEY;
    const response = await post();
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain(
      'TRIGGER_SECRET_KEY',
    );
  });
});
