'use client';

import { authErrorMessage } from '@repo/shared';
import { Loader2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { formText } from '@/lib/forms';

import { FormError } from './form-error';
import { FormField } from './form-field';

export function ForgotPasswordForm() {
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const { error: authError } = await authClient.requestPasswordReset({
      email: formText(new FormData(event.currentTarget), 'email'),
      redirectTo: '/reset-password',
    });
    setPending(false);
    if (authError) {
      setError(authErrorMessage(authError.status === 429 ? 'TOO_MANY_REQUESTS' : authError.code));
      return;
    }
    // Same message whether or not the account exists: the form never reveals who has an account.
    setSent(true);
  }

  if (sent) {
    return (
      <p role="status" className="leading-relaxed">
        If an account exists for that address, a reset link is on its way. It works for one hour.
      </p>
    );
  }
  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-5">
      <FormError message={error} />
      <FormField id="email" name="email" type="email" label="Email" autoComplete="email" required />
      <Button type="submit" size="lg" disabled={pending} className="w-full">
        {pending ? <Loader2 className="animate-spin" aria-hidden /> : null} Send reset link
      </Button>
    </form>
  );
}
