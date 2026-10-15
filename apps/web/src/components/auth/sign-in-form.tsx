'use client';

import { authErrorMessage } from '@repo/shared';
import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { formText } from '@/lib/forms';
import { authClient } from '@/lib/auth-client';

import { FormError } from './form-error';
import { FormField } from './form-field';

export function SignInForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const { error: authError } = await authClient.signIn.email({
      email: formText(form, 'email'),
      password: formText(form, 'password'),
    });
    if (authError) {
      setError(authErrorMessage(authError.status === 429 ? 'TOO_MANY_REQUESTS' : authError.code));
      setPending(false);
      return;
    }
    router.replace('/');
    router.refresh();
  }

  return (
    <form
      onSubmit={(event) => void handleSubmit(event)}
      className="flex flex-col gap-5"
      noValidate={false}
    >
      <FormError message={error} />
      <FormField id="email" name="email" type="email" label="Email" autoComplete="email" required />
      <FormField
        id="password"
        name="password"
        type="password"
        label="Password"
        autoComplete="current-password"
        required
      />
      <Button type="submit" size="lg" disabled={pending} className="mt-1 w-full">
        {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
        {pending ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}
