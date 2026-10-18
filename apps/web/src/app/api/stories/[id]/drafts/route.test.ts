import { getModels, objectId, UnauthenticatedError } from '@repo/core';
import { startTestDatabase, type TestDatabase } from '@repo/core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const trigger = vi.fn();
const requireUser = vi.fn();
const after = vi.fn();

vi.mock('next/server', () => ({ connection: () => Promise.resolve(), after }));
// No real Trigger.dev call is made in tests.
vi.mock('@trigger.dev/sdk', () => ({ tasks: { trigger } }));
vi.mock('@/lib/session', () => ({ requireUser }));

const { GET, POST, PUT } = await import('./route');

let db: TestDatabase;
beforeAll(async () => {
  db = await startTestDatabase();
});
afterAll(async () => {
  await db?.stop();
});

const storyId = objectId('6ad1f0000000000000000001');
const context = { params: Promise.resolve({ id: String(storyId) }) };
const call = (handler: typeof POST, method: string, body?: unknown) =>
  handler(
    new Request(`http://localhost/api/stories/${String(storyId)}/drafts`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    context,
  );

beforeEach(async () => {
  await db.reset();
  trigger.mockReset().mockResolvedValue({ id: 'run_test_123' });
  requireUser.mockReset().mockResolvedValue({ id: 'editor-1', role: 'editor' });
  after.mockReset();
  vi.unstubAllEnvs();
  process.env.TRIGGER_SECRET_KEY = 'tr_dev_test';
  await db.db.collection('stories').insertOne({ _id: storyId, headline: 'A story' });
});

const addBrief = () =>
  db.db.collection('researchBriefs').insertOne({
    storyId,
    taskId: `research:standard:${String(storyId)}:6ad1f0000000000000000002`,
    sections: [],
    sources: [],
    createdAt: new Date(),
  });

describe('/api/stories/[id]/drafts', () => {
  it('checks the session on the server for every method, and does nothing when refused', async () => {
    requireUser.mockRejectedValue(new UnauthenticatedError());
    expect((await call(GET, 'GET')).status).toBe(401);
    expect((await call(POST, 'POST', { format: 'x_post' })).status).toBe(401);
    expect(
      (await call(PUT, 'PUT', { format: 'x_post', baseVersion: 1, body: 'Text' })).status,
    ).toBe(401);
    expect(trigger).not.toHaveBeenCalled();
    const { Task } = await getModels();
    expect(await Task.countDocuments()).toBe(0);
  });

  it('lets an editor ask for a draft once the story has research, and hands it to the worker', async () => {
    const refused = await call(POST, 'POST', { format: 'x_post' });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('NO_BRIEF');

    await addBrief();
    const response = await call(POST, 'POST', { format: 'x_post', instructions: 'Keep it calm.' });
    expect(response.status).toBe(202);
    expect(requireUser).toHaveBeenLastCalledWith('drafts:generate');
    const { taskKey } = (await response.json()) as { taskKey: string };
    expect(trigger).toHaveBeenCalledWith(
      'generate-draft',
      { taskKey, database: 'omenai_test' },
      { idempotencyKey: taskKey },
    );
    // A second request for the same format waits for the first.
    expect((await call(POST, 'POST', { format: 'x_post' })).status).toBe(409);
  });

  it('rejects unknown formats and malformed edits before touching anything', async () => {
    await addBrief();
    expect((await call(POST, 'POST', { format: 'tiktok' })).status).toBe(400);
    expect((await call(PUT, 'PUT', { format: 'x_post', body: 'No base version' })).status).toBe(
      400,
    );
    expect(trigger).not.toHaveBeenCalled();
  });

  it('against a fixtures database, writes drafts in-process and never calls Trigger.dev', async () => {
    vi.stubEnv('OMENAI_RUNTIME', 'fixtures');
    vi.stubEnv('MONGODB_DB_NAME', 'omenai_fixtures');
    delete process.env.TRIGGER_SECRET_KEY;
    await addBrief();
    expect((await call(POST, 'POST', { format: 'newsletter_item' })).status).toBe(202);
    expect(trigger).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalledTimes(1);
  });
});
