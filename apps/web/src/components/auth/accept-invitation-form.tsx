'use client';

import { authErrorMessage, passwordProblem, type ApiErrorResponse } from '@repo/shared';
import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { formText } from '@/lib/forms';

import { FormError } from './form-error';
import { FormField } from './form-field';

/** Lets an invitee choose a display name and password; the account email is fixed by the invite. */
export function AcceptInvitationForm({ token, email }: { token: string; email: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = formText(form, 'name').trim();
    const password = formText(form, 'password');
    const confirm = formText(form, 'confirm');

    const problem = passwordProblem(password);
    if (problem) return setError(problem);
    if (password !== confirm) return setError('The two passwords don’t match.');

    setPending(true);
    setError(null);
    const response = await fetch('/api/invitations/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, name, password }),
    }).catch(() => null);

    if (!response?.ok) {
      const body = (await response?.json().catch(() => null)) as ApiErrorResponse | null;
      setError(
        response?.status === 429
          ? authErrorMessage('TOO_MANY_REQUESTS')
          : (authErrorMessage(body?.error.code) ?? 'Something went wrong. Please try again.'),
      );
      setPending(false);
      return;
    }
    router.replace('/');
    router.refresh();
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-5">
      <FormError message={error} />
      <FormField id="email" label="Email" value={email} readOnly disabled autoComplete="username" />
      <FormField
        id="name"
        name="name"
        label="Your name"
        autoComplete="name"
        maxLength={80}
        required
      />
      <FormField
        id="password"
        name="password"
        type="password"
        label="Choose a password"
        hint="At least 12 characters. A short phrase works well."
        autoComplete="new-password"
        minLength={12}
        maxLength={128}
        required
      />
      <FormField
        id="confirm"
        name="confirm"
        type="password"
        label="Confirm password"
        autoComplete="new-password"
        required
      />
      <Button type="submit" size="lg" variant="ochre" disabled={pending} className="mt-1 w-full">
        {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
        {pending ? 'Creating your account…' : 'Join the newsroom'}
      </Button>
    </form>
  );
}
