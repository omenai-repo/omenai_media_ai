'use client';

import { Check, Copy, Loader2, Send } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatDateTime } from '@/components/editorial/format';
import { formText } from '@/lib/forms';
import { scrollBehavior } from '@/lib/motion';

import { teamRequest } from './api';

/** Fired by "Invite again" in the invitations list to fill this form in. */
export const INVITE_AGAIN_EVENT = 'omenai:invite-again';
export type InviteAgainDetail = { email: string; role: string };

interface InviteResult {
  link: string;
  emailed: boolean;
  emailError: string | null;
  invitation: { email: string; role: string; expiresAt: string };
}

export function InviteForm({ emailConfigured }: { emailConfigured: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<InviteResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const roleSelect = useRef<HTMLSelectElement>(null);

  // Prefill from "Invite again", without submitting: the owner still sends it deliberately.
  useEffect(() => {
    function prefill(event: Event) {
      const { email, role } = (event as CustomEvent<InviteAgainDetail>).detail;
      if (emailInput.current) emailInput.current.value = email;
      if (roleSelect.current) roleSelect.current.value = role === 'owner' ? 'owner' : 'editor';
      emailInput.current?.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
      emailInput.current?.focus({ preventScroll: true });
    }
    window.addEventListener(INVITE_AGAIN_EVENT, prefill);
    return () => window.removeEventListener(INVITE_AGAIN_EVENT, prefill);
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setError(null);
    try {
      const invite = await teamRequest<InviteResult>('/api/team/invitations', {
        method: 'POST',
        body: JSON.stringify({ email: formText(data, 'email'), role: formText(data, 'role') }),
      });
      setResult(invite);
      setCopied(false);
      form.reset();
      toast.success(
        invite.emailed ? `Invitation emailed to ${invite.invitation.email}` : 'Invitation ready',
      );
      router.refresh();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'The invitation couldn’t be created.';
      setError(message);
      toast.error(message);
    } finally {
      setPending(false);
    }
  }

  async function copy(link: string) {
    await navigator.clipboard.writeText(link);
    setCopied(true);
  }

  return (
    <div>
      <form onSubmit={(event) => void handleSubmit(event)} className="grid gap-3.5">
        <div className="flex flex-col gap-2">
          <Label htmlFor="invite-email">Their email address</Label>
          <Input
            ref={emailInput}
            id="invite-email"
            name="email"
            type="email"
            required
            autoComplete="off"
            placeholder="name@omenai.com"
            className="h-11"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="invite-role">Role</Label>
          <select
            ref={roleSelect}
            id="invite-role"
            name="role"
            defaultValue="editor"
            className="h-11.5 rounded-xl border border-input bg-ivory px-3 text-[0.9375rem] text-ink transition-colors hover:border-ink"
          >
            <option value="editor">Editor</option>
            <option value="owner">Owner</option>
          </select>
        </div>
        <Button type="submit" size="lg" className="justify-self-start" disabled={pending}>
          {pending ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
          Send invitation
        </Button>
      </form>
      {error ? (
        <p role="alert" className="mt-3 rounded-xl bg-oxide-wash px-3 py-2 text-sm text-ink">
          {error}
        </p>
      ) : null}
      {!emailConfigured ? (
        <p className="meta mt-3">
          Email isn’t set up yet, so you’ll get a link to send them yourself.
        </p>
      ) : null}

      {result ? (
        <div className="mt-6 rise-in rounded-[14px] border border-hairline p-5" role="status">
          <p className="font-medium text-ink">
            {result.emailed
              ? `We’ve emailed ${result.invitation.email} an invitation.`
              : `Next step: send this link to ${result.invitation.email}.`}
          </p>
          <p className="meta mt-1 mb-3">
            {result.emailError
              ? `The email couldn’t be sent (${result.emailError}), so please send the link yourself. `
              : ''}
            The link works once, until {formatDateTime(result.invitation.expiresAt)}. For security
            it won’t be shown again.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              readOnly
              value={result.link}
              aria-label="Invitation link"
              className="h-10 font-mono text-xs"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button type="button" variant="outline" onClick={() => void copy(result.link)}>
              {copied ? <Check aria-hidden /> : <Copy aria-hidden />}{' '}
              {copied ? 'Copied' : 'Copy link'}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
