import { afterEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();
// No real email is sent in tests.
vi.mock('resend', () => ({
  Resend: class {
    emails = { send };
  },
}));

const { invitationEmail, isEmailConfigured, sendEmail } = await import('./index.js');

afterEach(() => {
  send.mockReset();
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
});

describe('email', () => {
  it('does nothing without configuration', async () => {
    expect(isEmailConfigured()).toBe(false);
    expect(await sendEmail({ to: 'a@b.c', subject: 's', text: 't', html: 'h' })).toEqual({
      sent: false,
      reason: 'not_configured',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('sends through Resend and reports provider errors without throwing', async () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.EMAIL_FROM = 'Omenai <newsroom@omenai.example>';
    send.mockResolvedValueOnce({ data: { id: 'email_1' }, error: null });
    expect(await sendEmail({ to: 'a@b.c', subject: 's', text: 't', html: 'h' })).toEqual({
      sent: true,
      id: 'email_1',
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'Omenai <newsroom@omenai.example>', to: 'a@b.c' }),
    );

    send.mockResolvedValueOnce({ data: null, error: { message: 'Domain not verified' } });
    expect(await sendEmail({ to: 'a@b.c', subject: 's', text: 't', html: 'h' })).toEqual({
      sent: false,
      reason: 'failed',
      error: 'Domain not verified',
    });
  });

  it('reports a send that throws (network failure, SDK error) as failed, without throwing', async () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.EMAIL_FROM = 'Omenai <newsroom@omenai.example>';
    send.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await sendEmail({ to: 'a@b.c', subject: 's', text: 't', html: 'h' })).toEqual({
      sent: false,
      reason: 'failed',
      error: 'fetch failed',
    });
  });

  it('gives up on a send that never answers, within the timeout', async () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.EMAIL_FROM = 'Omenai <newsroom@omenai.example>';
    send.mockReturnValueOnce(new Promise(() => {}));
    const started = Date.now();
    const result = await sendEmail(
      { to: 'a@b.c', subject: 's', text: 't', html: 'h' },
      { timeoutMs: 50 },
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result).toEqual({
      sent: false,
      reason: 'failed',
      error: 'the email service didn’t answer within 0.05 s',
    });
  });

  it('escapes content in the HTML template', () => {
    const email = invitationEmail({
      to: 'x@y.z',
      role: 'editor',
      link: 'https://app.example/invite/a"b',
      expiresAt: new Date(0),
    });
    expect(email.html).toContain('a&quot;b');
    expect(email.text).toContain('https://app.example/invite/a"b');
  });
});
