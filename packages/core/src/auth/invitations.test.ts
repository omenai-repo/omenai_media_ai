import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getModels } from '../db/models.js';
import { startTestDatabase, type TestDatabase } from '../testing/index.js';
import {
  CLAIM_TIMEOUT_MS,
  claimInvitation,
  createInvitation,
  hashInvitationToken,
  inspectInvitationToken,
  INVITATION_TTL_MS,
  InvitationRejectedError,
  revokeInvitation,
} from './invitations.js';

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

async function invite(email = 'editor@omenai.example', role: 'owner' | 'editor' = 'editor') {
  return createInvitation({ email, role, invitedBy: 'test-owner' });
}

async function expectRejection(promise: Promise<unknown>, reason: string) {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(InvitationRejectedError);
  expect((error as InvitationRejectedError).reason).toBe(reason);
}

describe('createInvitation', () => {
  it('stores only a hash of the token', async () => {
    const { token, invitation } = await invite('Editor@Omenai.Example ');
    const { Invitation } = await getModels();
    const stored = await Invitation.findById(invitation.id).lean();

    expect(stored?.tokenHash).toBe(hashInvitationToken(token));
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored?.email).toBe('editor@omenai.example');
  });

  it('revokes an earlier live invitation for the same email', async () => {
    const first = await invite();
    await invite();
    expect((await inspectInvitationToken(first.token)).state).toBe('revoked');
  });
});

describe('inspectInvitationToken', () => {
  it('classifies missing, unknown, expired and revoked tokens', async () => {
    expect((await inspectInvitationToken(undefined)).state).toBe('invalid');
    expect((await inspectInvitationToken('not-a-real-token')).state).toBe('invalid');

    const { token, invitation } = await invite();
    expect((await inspectInvitationToken(token)).state).toBe('valid');

    const later = new Date(Date.now() + INVITATION_TTL_MS + 1000);
    expect((await inspectInvitationToken(token, later)).state).toBe('expired');

    await revokeInvitation(invitation.id);
    expect((await inspectInvitationToken(token)).state).toBe('revoked');
  });
});

describe('claimInvitation', () => {
  it('claims a valid invitation and returns its role', async () => {
    const { token } = await invite('owner@omenai.example', 'owner');
    const result = await claimInvitation({
      token,
      email: 'OWNER@omenai.example',
    });
    expect(result.role).toBe('owner');
  });

  it('cannot be reused once claimed', async () => {
    const { token } = await invite();
    await claimInvitation({ token, email: 'editor@omenai.example' });
    await expectRejection(
      claimInvitation({ token, email: 'editor@omenai.example' }),
      'INVITATION_USED',
    );
  });

  it('rejects a missing or unknown token', async () => {
    await invite();
    await expectRejection(
      claimInvitation({ token: undefined, email: 'editor@omenai.example' }),
      'INVITATION_REQUIRED',
    );
    await expectRejection(
      claimInvitation({ token: 'guess', email: 'editor@omenai.example' }),
      'INVITATION_INVALID',
    );
  });

  it('rejects a different email even with the right token', async () => {
    const { token } = await invite();
    await expectRejection(
      claimInvitation({ token, email: 'intruder@example.com' }),
      'INVITATION_EMAIL_MISMATCH',
    );
  });

  it('rejects revoked and expired invitations', async () => {
    const revoked = await invite('a@omenai.example');
    await revokeInvitation(revoked.invitation.id);
    await expectRejection(
      claimInvitation({ token: revoked.token, email: 'a@omenai.example' }),
      'INVITATION_REVOKED',
    );

    const expiring = await invite('b@omenai.example');
    await expectRejection(
      claimInvitation({
        token: expiring.token,
        email: 'b@omenai.example',
        now: new Date(Date.now() + INVITATION_TTL_MS + 1000),
      }),
      'INVITATION_EXPIRED',
    );
  });

  it('lets exactly one of two concurrent claims succeed', async () => {
    const { token } = await invite();
    const attempt = () => claimInvitation({ token, email: 'editor@omenai.example' });

    const results = await Promise.allSettled([attempt(), attempt(), attempt()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('frees a stale claim so a failed sign-up can be retried', async () => {
    const { token } = await invite();
    const start = new Date();
    await claimInvitation({
      token,
      email: 'editor@omenai.example',
      now: start,
    });

    const retry = await claimInvitation({
      token,
      email: 'editor@omenai.example',
      now: new Date(start.getTime() + CLAIM_TIMEOUT_MS + 1000),
    });
    expect(retry.role).toBe('editor');
  });
});
