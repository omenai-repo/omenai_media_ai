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
