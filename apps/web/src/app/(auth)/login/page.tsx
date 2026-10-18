import type { Metadata } from 'next';
import Link from 'next/link';

import { SignInForm } from '@/components/auth/sign-in-form';

export const metadata: Metadata = { title: 'Sign in' };

export default function LoginPage() {
  return (
    <div>
      <p className="eyebrow mb-3">Editorial access</p>
      <h1 className="display-md mb-3">Sign in to the newsroom</h1>
      <p className="mb-8 text-[0.9375rem] leading-relaxed text-muted-foreground">
        Daily discovery, research and drafting for Omenai’s editors.
      </p>
      <SignInForm />
      <p className="mt-4 text-sm">
        <Link
          href="/forgot-password"
          className="text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          Forgot your password?
        </Link>
      </p>
      <p className="mt-8 border-t pt-6 text-sm leading-relaxed text-muted-foreground">
        Access is by invitation only. New to the newsroom? Open the link in your invitation email to
        set your password.
      </p>
    </div>
  );
}
