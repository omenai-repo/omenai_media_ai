import { runWithEndpointContext } from '@better-auth/core/context';
import { betterAuth } from 'better-auth';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getModels } from '../db/models.js';
import { ConflictError } from '../errors.js';
import { startTestDatabase, type TestDatabase } from '../testing/index.js';
import { createAuthOptions } from './better-auth.js';
import { deactivateUser, findUserById, setUserRole } from './users.js';

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

/** Inserts a user directly, as Better Auth would have stored it. */
async function seedUser(email: string, role: 'owner' | 'editor', status = 'active') {
  const { insertedId } = await db.db.collection('user').insertOne({
    name: email,
    email,
    emailVerified: true,
    role,
    status,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return insertedId.toString();
}

async function seedSession(userId: string) {
  await db.db.collection('session').insertOne({
    userId: new Types.ObjectId(userId),
    token: `token-${userId}-${Math.random()}`,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
}

describe('user administration rules', () => {
  it('keeps at least one active owner when changing roles', async () => {
    const owner = await seedUser('owner@omenai.example', 'owner');
    await expect(setUserRole({ userId: owner, role: 'editor' })).rejects.toBeInstanceOf(
      ConflictError,
    );

    const second = await seedUser('second@omenai.example', 'owner');
    await setUserRole({ userId: owner, role: 'editor' });
    expect((await findUserById(owner))?.role).toBe('editor');
    expect((await findUserById(second))?.role).toBe('owner');
  });

  it('refuses self-deactivation and deactivating the last owner', async () => {
    const owner = await seedUser('owner@omenai.example', 'owner');
    const editor = await seedUser('editor@omenai.example', 'editor');

    await expect(deactivateUser({ actorId: owner, userId: owner })).rejects.toThrow(
      /your own account/,
    );
    await expect(deactivateUser({ actorId: editor, userId: owner })).rejects.toThrow(
      /at least one active owner/,
    );
  });

  it('revokes every session when a user is deactivated', async () => {
    const owner = await seedUser('owner@omenai.example', 'owner');
    const editor = await seedUser('editor@omenai.example', 'editor');
    await seedSession(editor);
    await seedSession(editor);
    await seedSession(owner);

    await deactivateUser({ actorId: owner, userId: editor });

    const { AuthSession } = await getModels();
    expect(await AuthSession.countDocuments({ userId: new Types.ObjectId(editor) })).toBe(0);
    expect(await AuthSession.countDocuments({ userId: new Types.ObjectId(owner) })).toBe(1);
    expect((await findUserById(editor))?.status).toBe('deactivated');
  });

  it('prevents a deactivated user from obtaining a new session', async () => {
    const editor = await seedUser('editor@omenai.example', 'editor', 'deactivated');
    const auth = betterAuth(
      createAuthOptions({
        client: db.client,
        db: db.db,
        secret: 'test-secret-that-is-long-enough-for-better-auth',
        baseURL: 'http://localhost:3000',
      }),
    );
    const context = await auth.$context;
    const endpointContext = {
      context,
      headers: new Headers(),
      getCookie: () => null,
    } as unknown as Parameters<typeof runWithEndpointContext>[0];

    await expect(
      runWithEndpointContext(endpointContext, () => context.internalAdapter.createSession(editor)),
    ).rejects.toThrow(/deactivated/);
  });
});
