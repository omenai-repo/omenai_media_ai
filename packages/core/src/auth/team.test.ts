/**
 * An invitation never depends on its email: whatever Resend does (refuses, throws, never
 * answers), the invitation is kept and the owner gets the link to send themselves.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();
// No real email is sent in tests.
vi.mock('resend', () => ({
  Resend: class {
    emails = { send };
  },
}));
vi.mock('../email/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../email/index.js')>();
  // A short timeout, so the "never answers" case doesn't wait the real 10 s.
  return { ...actual, sendEmail: (m: never) => actual.sendEmail(m, { timeoutMs: 100 }) };
});

const { getModels } = await import('../db/models.js');
const { startTestDatabase } = await import('../testing/index.js');
const { inspectInvitationToken } = await import('./invitations.js');
const { inviteMember } = await import('./team.js');

let db: Awaited<ReturnType<typeof startTestDatabase>>;
beforeAll(async () => {
  db = await startTestDatabase();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  process.env.RESEND_API_KEY = 're_test';
  process.env.EMAIL_FROM = 'Omenai <newsroom@omenai.example>';
});
afterEach(() => {
  send.mockReset();
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
});

const invite = (email: string) =>
  inviteMember({
    email,
    role: 'editor',
    invitedBy: 'owner-1',
    appUrl: 'https://newsroom.example/',
  });

describe('inviting a member', () => {
  it.each([
    [
      'refuses',
      () => send.mockResolvedValueOnce({ data: null, error: { message: 'Domain not verified' } }),
      'Domain not verified',
    ],
    ['throws', () => send.mockRejectedValueOnce(new TypeError('fetch failed')), 'fetch failed'],
    ['never answers', () => send.mockReturnValueOnce(new Promise(() => {})), 'didn’t answer'],
  ] as const)(
    'keeps the invitation and returns its link when the email service %s',
    async (_, arrange, reason) => {
      arrange();
      const started = Date.now();
      const result = await invite('editor@omenai.example');
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(result.emailed).toBe(false);
      expect(result.emailError).toContain(reason);
      expect(result.link).toMatch(/^https:\/\/newsroom\.example\/invite\/[A-Za-z0-9_-]{20,}$/);
      // The link works: it opens a pending invitation for that email.
      const token = result.link.split('/invite/')[1];
      expect(await inspectInvitationToken(token)).toMatchObject({
        state: 'valid',
        invitation: { email: 'editor@omenai.example', status: 'pending' },
      });
      const { Invitation } = await getModels();
      expect(await Invitation.countDocuments({ email: 'editor@omenai.example' })).toBe(1);
    },
  );

  it('reports a sent email, still with the link', async () => {
    send.mockResolvedValueOnce({ data: { id: 'email_1' }, error: null });
    const result = await invite('editor@omenai.example');
    expect(result).toMatchObject({ emailed: true, emailError: null });
    expect(result.link).toContain('/invite/');
  });
});
