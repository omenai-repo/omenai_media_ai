import { ForbiddenError, UnauthenticatedError } from '@repo/core';
import { startTestDatabase, type TestDatabase } from '@repo/core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const getSession = vi.fn();

vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers()) }));
vi.mock('./auth', () => ({ getAuth: () => ({ api: { getSession } }) }));

const { requireOwner, requireUser } = await import('./session');

let db: TestDatabase;

beforeAll(async () => {
  db = await startTestDatabase();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  getSession.mockReset();
});

async function signInAs(role: 'owner' | 'editor', status: 'active' | 'deactivated' = 'active') {
  const { insertedId } = await db.db.collection('user').insertOne({
    name: role,
    email: `${role}@omenai.example`,
    emailVerified: true,
    role,
    status,
  });
  getSession.mockResolvedValue({ user: { id: insertedId.toString() }, session: {} });
  return insertedId.toString();
}

describe('server-side authorization helpers', () => {
  it('rejects requests without a session', async () => {
    getSession.mockResolvedValue(null);
    await expect(requireUser()).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('treats a deactivated user as signed out even with a live session', async () => {
    await signInAs('editor', 'deactivated');
    await expect(requireUser()).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('lets editors do editorial work but not owner-only operations', async () => {
    await signInAs('editor');
    await expect(requireUser('drafts:generate')).resolves.toMatchObject({ role: 'editor' });
    await expect(requireOwner()).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requireUser('runs:trigger')).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('lets owners perform owner-only operations', async () => {
    await signInAs('owner');
    await expect(requireOwner()).resolves.toMatchObject({ role: 'owner' });
  });

  it('uses the role stored in the database, not the session payload', async () => {
    const id = await signInAs('editor');
    // A session claiming a different role must not matter.
    getSession.mockResolvedValue({ user: { id, role: 'owner' }, session: {} });
    await expect(requireOwner()).rejects.toBeInstanceOf(ForbiddenError);
  });
});
