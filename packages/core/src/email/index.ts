import { Resend } from 'resend';

import { ConfigError, optionalEnv } from '../config/env.js';
import { isFixtureRuntime } from '../config/runtime.js';

/**
 * Transactional email through Resend, used for invitations and password resets. Optional: without
 * RESEND_API_KEY and EMAIL_FROM nothing is sent and callers fall back (e.g. the owner copies the
 * invitation link).
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type EmailResult =
  { sent: true; id: string } | { sent: false; reason: 'not_configured' | 'failed'; error?: string };

let client: Resend | undefined;

/**
 * Development fixtures only: `EMAIL_TRANSPORT=fixture-sent` or `fixture-failed` simulates the
 * email provider's answer, so the invitation screens can be checked without sending mail.
 * Refused unless the app is connected to a `*_fixtures` database.
 */
function fixtureTransport(): 'sent' | 'failed' | null {
  const mode = optionalEnv('EMAIL_TRANSPORT');
  if (!mode) return null;
  if (!isFixtureRuntime())
    throw new ConfigError('EMAIL_TRANSPORT', 'only allowed with a *_fixtures database');
  if (mode === 'fixture-sent') return 'sent';
  if (mode === 'fixture-failed') return 'failed';
  throw new ConfigError('EMAIL_TRANSPORT', 'expected fixture-sent or fixture-failed');
}

export function isEmailConfigured(): boolean {
  if (fixtureTransport()) return true;
  return Boolean(optionalEnv('RESEND_API_KEY') && optionalEnv('EMAIL_FROM'));
}

/**
 * The longest a send may take. Resend's SDK sets no timeout of its own, and an invitation waits
 * on its email: a provider that never answered held the request open indefinitely (reproduced
 * 2026-10-21), so the owner never saw the link.
 */
export const EMAIL_SEND_TIMEOUT_MS = 10_000;

/**
 * Sends one email. Never throws for a delivery problem and never waits longer than the timeout:
 * a refused, failed, thrown or unanswered send comes back as `{ sent: false }` with the reason,
 * so callers (an invitation shows its link instead) carry on. A misconfigured EMAIL_TRANSPORT
 * still throws: that's a setup mistake, not a delivery failure.
 */
export async function sendEmail(
  message: EmailMessage,
  options: { timeoutMs?: number } = {},
): Promise<EmailResult> {
  const simulated = fixtureTransport();
  if (simulated === 'sent') {
    console.info(`[fixture email, not sent] to ${message.to}: ${message.subject}`);
    return { sent: true, id: 'fixture' };
  }
  if (simulated === 'failed')
    return {
      sent: false,
      reason: 'failed',
      error: 'Simulated delivery failure (development fixture)',
    };
  const apiKey = optionalEnv('RESEND_API_KEY');
  const from = optionalEnv('EMAIL_FROM');
  if (!apiKey || !from) return { sent: false, reason: 'not_configured' };
  const timeoutMs = options.timeoutMs ?? EMAIL_SEND_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    client ??= new Resend(apiKey);
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`the email service didn’t answer within ${timeoutMs / 1000} s`)),
        timeoutMs,
      );
    });
    // A send that settles after the timeout must never surface as unhandled.
    const sending = client.emails.send({ from, ...message });
    sending.catch(() => undefined);
    const { data, error } = await Promise.race([sending, timedOut]);
    if (error || !data)
      return { sent: false, reason: 'failed', error: error?.message ?? 'Unknown email error' };
    return { sent: true, id: data.id };
  } catch (error) {
    return {
      sent: false,
      reason: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

function layout(
  heading: string,
  paragraphs: string[],
  action: { label: string; url: string },
): string {
  return `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;color:#1c1915">
<p style="letter-spacing:.18em;font-size:13px">OMENAI · NEWSROOM</p>
<h1 style="font-weight:normal;font-size:26px">${escape(heading)}</h1>
${paragraphs.map((p) => `<p style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6">${escape(p)}</p>`).join('\n')}
<p><a href="${escape(action.url)}" style="display:inline-block;background:#9a4a22;color:#fff;padding:12px 20px;text-decoration:none;font-family:Arial,sans-serif">${escape(action.label)}</a></p>
<p style="font-family:Arial,sans-serif;font-size:12px;color:#6b645b">Stories Shaping Culture.</p></div>`;
}

export function invitationEmail(input: {
  to: string;
  role: string;
  link: string;
  expiresAt: Date;
}): EmailMessage {
  const expires = input.expiresAt.toUTCString();
  const paragraphs = [
    `You've been invited to join the Omenai newsroom as ${input.role === 'owner' ? 'an Owner' : 'an Editor'}.`,
    `Open the link to set your password. It works once and expires on ${expires}.`,
  ];
  return {
    to: input.to,
    subject: 'Your invitation to the Omenai newsroom',
    text: `${paragraphs.join('\n\n')}\n\n${input.link}`,
    html: layout('Join the Omenai newsroom', paragraphs, {
      label: 'Set your password',
      url: input.link,
    }),
  };
}

export function passwordResetEmail(input: { to: string; name: string; url: string }): EmailMessage {
  const paragraphs = [
    `Hello ${input.name || 'there'}, a password reset was requested for your Omenai newsroom account.`,
    'The link works for one hour. If you did not ask for this, you can ignore this email.',
  ];
  return {
    to: input.to,
    subject: 'Reset your Omenai newsroom password',
    text: `${paragraphs.join('\n\n')}\n\n${input.url}`,
    html: layout('Reset your password', paragraphs, {
      label: 'Choose a new password',
      url: input.url,
    }),
  };
}
