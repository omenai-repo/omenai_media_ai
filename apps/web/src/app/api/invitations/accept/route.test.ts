import { createAuthOptions, createInvitation, getModels, revokeInvitation } from '@repo/core';
import { startTestDatabase, type TestDatabase } from '@repo/core/testing';
import { betterAuth } from 'better-auth';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

function createTestAuth(testDb: TestDatabase) {
  return betterAuth(
    createAuthOptions({
      client: testDb.client,
      db: testDb.db,
      secret: 'test-secret-that-is-long-enough-for-better-auth',
      baseURL: 'http://localhost:3000',
    }),
  );
}

let db: TestDatabase;
let auth: ReturnType<typeof createTestAuth>;

vi.mock('next/server', () => ({ connection: () => Promise.resolve() }));
// A real Better Auth instance against the test database (without the Next.js cookie plugin,
// which needs a live request scope).
vi.mock('@/lib/auth', () => ({ getReadyAuth: () => Promise.resolve(auth) }));

const { POST } = await import('./route');

beforeAll(async () => {
  db = await startTestDatabase();
  auth = createTestAuth(db);
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
});

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/invitations/accept', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    undefined,
  );
}

async function invite(role: 'owner' | 'editor' = 'editor') {
  return createInvitation({ email: 'editor@omenai.example', role, invitedBy: 'test' });
}

describe('POST /api/invitations/accept', () => {
  it('creates the account for the invited email with the invited role', async () => {
    const { token } = await invite('owner');
    const response = await post({
      token,
      name: 'Ada Editor',
      password: 'a long enough passphrase',
    });

    expect(response.status).toBe(200);
    const { AuthUser } = await getModels();
    const user = await AuthUser.findOne({ email: 'editor@omenai.example' }).lean();
    expect(user).toMatchObject({ name: 'Ada Editor', role: 'owner', status: 'active' });
  });

  it('refuses revoked or unknown invitations', async () => {
    const { token, invitation } = await invite();
    await revokeInvitation(invitation.id);

    const revoked = await post({ token, name: 'A', password: 'a long enough passphrase' });
    expect(revoked.status).toBe(410);
    expect(((await revoked.json()) as { error: { code: string } }).error.code).toBe(
      'INVITATION_REVOKED',
    );
    const unknown = await post({
      token: 'x'.repeat(43),
      name: 'A',
      password: 'a long enough passphrase',
    });
    expect(unknown.status).toBe(410);

    const { AuthUser } = await getModels();
    expect(await AuthUser.countDocuments()).toBe(0);
  });

  it('rejects a weak password and leaves the invitation usable', async () => {
    const { token } = await invite();
    expect((await post({ token, name: 'A', password: 'short' })).status).toBe(400);
    expect((await post({ token, name: 'A', password: 'a long enough passphrase' })).status).toBe(
      200,
    );
  });

  it('cannot be used twice', async () => {
    const { token } = await invite();
    expect((await post({ token, name: 'A', password: 'a long enough passphrase' })).status).toBe(
      200,
    );
    const again = await post({ token, name: 'B', password: 'another long passphrase' });
    expect(again.status).toBe(410);
  });
});
