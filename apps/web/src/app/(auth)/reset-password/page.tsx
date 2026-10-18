import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';

import { ResetPasswordForm } from '@/components/auth/reset-password-form';

export const metadata: Metadata = { title: 'Choose a new password' };

async function Body({ searchParams }: Pick<PageProps<'/reset-password'>, 'searchParams'>) {
  const { token, error } = await searchParams;
  if (error || typeof token !== 'string' || !token) {
    return (
      <p className="leading-relaxed text-muted-foreground">
        This reset link is invalid or has expired.{' '}
        <Link href="/forgot-password" className="underline underline-offset-4">
          Request a new one
        </Link>
        .
      </p>
    );
  }
  return <ResetPasswordForm token={token} />;
}

export default function ResetPasswordPage({ searchParams }: PageProps<'/reset-password'>) {
  return (
    <div>
      <p className="eyebrow mb-3">Account</p>
      <h1 className="display-md mb-8">Choose a new password</h1>
      <Suspense>
        <Body searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
