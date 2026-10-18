'use client';

import { authErrorMessage, passwordProblem } from '@repo/shared';
import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { formText } from '@/lib/forms';

import { FormError } from './form-error';
import { FormField } from './form-field';

export function ResetPasswordForm({ token }: { token: string }) {
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = formText(form, 'password');
    const problem = passwordProblem(password);
    if (problem) return setError(problem);
    if (password !== formText(form, 'confirm')) return setError('The two passwords don’t match.');

    setPending(true);
    setError(null);
    const { error: authError } = await authClient.resetPassword({ newPassword: password, token });
    setPending(false);
    if (authError) {
      setError(
        authError.code === 'INVALID_TOKEN'
          ? 'This reset link is invalid or has expired. Request a new one.'
          : authErrorMessage(authError.code),
      );
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <p role="status" className="leading-relaxed">
        Your password has been changed and other sessions were signed out.{' '}
        <Link href="/login" className="underline underline-offset-4">
          Sign in
        </Link>
        .
      </p>
    );
  }
  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-5">
      <FormError message={error} />
      <FormField
        id="password"
        name="password"
        type="password"
        label="New password"
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
      <Button type="submit" size="lg" disabled={pending} className="w-full">
        {pending ? <Loader2 className="animate-spin" aria-hidden /> : null} Set new password
      </Button>
    </form>
  );
}
