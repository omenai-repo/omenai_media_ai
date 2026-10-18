import { ForbiddenError, getModels, UnauthenticatedError } from '@repo/core';
import { startTestDatabase, type TestDatabase } from '@repo/core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const requireUser = vi.fn();
const requireOwner = vi.fn();
vi.mock('next/server', () => ({ connection: () => Promise.resolve() }));
vi.mock('@/lib/session', () => ({ requireUser, requireOwner }));

const invitations = await import('./invitations/route');
const invitation = await import('./invitations/[id]/route');
const users = await import('./users/[id]/route');
const decision = await import('../stories/[id]/decision/route');

let db: TestDatabase;
beforeAll(async () => {
  db = await startTestDatabase();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  requireUser.mockReset();
  requireOwner.mockReset();
  process.env.BETTER_AUTH_URL = 'https://newsroom.example';
  delete process.env.RESEND_API_KEY;
});

const json = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });
const params = <T>(value: T) => ({ params: Promise.resolve(value) });

async function seedUser(role: 'owner' | 'editor', email = `${role}@omenai.example`) {
  const { insertedId } = await db.db
    .collection('user')
    .insertOne({ email, name: role, role, status: 'active', emailVerified: true });
  return insertedId.toString();
}

describe('team routes (owner-only)', () => {
  it('rejects editors and anonymous callers on every owner route', async () => {
    requireOwner.mockRejectedValueOnce(new ForbiddenError());
    expect(
      (
        await invitations.POST(
          new Request('http://x', json({ email: 'a@b.co', role: 'editor' })),
          undefined,
        )
      ).status,
    ).toBe(403);
    requireOwner.mockRejectedValueOnce(new UnauthenticatedError());
    expect(
      (await invitation.DELETE(new Request('http://x', { method: 'DELETE' }), params({ id: 'x' })))
        .status,
    ).toBe(401);
    requireOwner.mockRejectedValueOnce(new ForbiddenError());
    expect(
      (
        await users.PATCH(
          new Request('http://x', { method: 'PATCH', body: '{"role":"owner"}' }),
          params({ id: 'x' }),
        )
      ).status,
    ).toBe(403);
    const { Invitation } = await getModels();
    expect(await Invitation.countDocuments()).toBe(0);
  });

  it('lets an owner invite and get a one-time link when email is not configured', async () => {
    const ownerId = await seedUser('owner');
    requireOwner.mockResolvedValue({ id: ownerId, role: 'owner' });
    const response = await invitations.POST(
      new Request('http://x', json({ email: 'New@Omenai.example', role: 'editor' })),
      undefined,
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      link: string;
      emailed: boolean;
      invitation: { email: string; id: string };
    };
    expect(body.link).toMatch(/^https:\/\/newsroom\.example\/invite\/[\w-]{40,}$/);
    expect(body.emailed).toBe(false);
    expect(body.invitation.email).toBe('new@omenai.example');

    expect(
      (
        await invitation.DELETE(
          new Request('http://x', { method: 'DELETE' }),
          params({ id: body.invitation.id }),
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await invitation.DELETE(
          new Request('http://x', { method: 'DELETE' }),
          params({ id: body.invitation.id }),
        )
      ).status,
    ).toBe(404);
  });

  it('validates invitation input', async () => {
    requireOwner.mockResolvedValue({ id: 'o', role: 'owner' });
    expect(
      (
        await invitations.POST(
          new Request('http://x', json({ email: 'nope', role: 'editor' })),
          undefined,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await invitations.POST(
          new Request('http://x', json({ email: 'a@b.co', role: 'admin' })),
          undefined,
        )
      ).status,
    ).toBe(400);
  });

  it('changes roles and access, but never removes the last owner', async () => {
    const ownerId = await seedUser('owner');
    const editorId = await seedUser('editor');
    requireOwner.mockResolvedValue({ id: ownerId, role: 'owner' });
    const patch = (id: string, body: unknown) =>
      users.PATCH(
        new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) }),
        params({ id }),
      );

    expect(
      ((await (await patch(editorId, { role: 'owner' })).json()) as { role: string }).role,
    ).toBe('owner');
    expect((await patch(editorId, { role: 'editor' })).status).toBe(200);
    expect((await patch(ownerId, { role: 'editor' })).status).toBe(409);
    expect((await patch(ownerId, { status: 'deactivated' })).status).toBe(409);
    expect(
      ((await (await patch(editorId, { status: 'deactivated' })).json()) as { status: string })
        .status,
    ).toBe('deactivated');
    expect((await patch(editorId, {})).status).toBe(400);
  });
});

describe('story decisions', () => {
  it('lets editors save and skip, validates input, and 404s unknown stories', async () => {
    requireUser.mockResolvedValue({ id: 'editor-1', role: 'editor' });
    const { Story } = await getModels();
    const story = await Story.create({
      headline: 'A story',
      firstSeenRunKey: 'r',
      lastCandidateRunKey: 'r',
    });
    const post = (id: string, body: unknown) =>
      decision.POST(new Request('http://x', json(body)), params({ id }));

    expect(
      (
        (await (await post(String(story._id), { decision: 'save' })).json()) as {
          editorialState: string;
        }
      ).editorialState,
    ).toBe('saved');
    expect((await post(String(story._id), { decision: 'skip', reason: 'Not for us' })).status).toBe(
      200,
    );
    expect((await Story.findById(story._id).lean())?.decisions.map((d) => d.action)).toEqual([
      'saved',
      'skipped',
    ]);
    expect((await post(String(story._id), { decision: 'publish' })).status).toBe(400);
    expect((await post('0123456789abcdef01234567', { decision: 'save' })).status).toBe(404);
  });

  it('rejects callers without the editorial permission', async () => {
    requireUser.mockRejectedValue(new UnauthenticatedError());
    expect(
      (
        await decision.POST(
          new Request('http://x', json({ decision: 'save' })),
          params({ id: 'x' }),
        )
      ).status,
    ).toBe(401);
  });
});
