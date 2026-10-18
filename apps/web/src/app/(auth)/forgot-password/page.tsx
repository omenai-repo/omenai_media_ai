import { isEmailConfigured } from '@repo/core';
import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { Suspense } from 'react';

import { ForgotPasswordForm } from '@/components/auth/forgot-password-form';

export const metadata: Metadata = { title: 'Reset password' };

async function Body() {
  await connection();
  if (!isEmailConfigured()) {
    return (
      <p className="leading-relaxed text-muted-foreground">
        Password reset by email isn’t set up for this newsroom yet. Please contact a workspace
        owner.
      </p>
    );
  }
  return <ForgotPasswordForm />;
}

export default function ForgotPasswordPage() {
  return (
    <div>
      <p className="eyebrow mb-3">Account</p>
      <h1 className="display-md mb-3">Reset your password</h1>
      <p className="mb-8 leading-relaxed text-muted-foreground">
        We’ll email you a link to choose a new one.
      </p>
      <Suspense>
        <Body />
      </Suspense>
      <p className="mt-8 border-t pt-6 text-sm">
        <Link href="/login" className="underline underline-offset-4">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
