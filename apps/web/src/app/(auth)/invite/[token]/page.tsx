import { ConfigError, inspectInvitationToken, type InvitationTokenState } from '@repo/core';
import { AlertCircle } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';

import { AcceptInvitationForm } from '@/components/auth/accept-invitation-form';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

export const metadata: Metadata = { title: 'Invitation' };

const UNUSABLE: Record<Exclude<InvitationTokenState, 'valid'>, { title: string; body: string }> = {
  invalid: {
    title: 'This link isn’t valid',
    body: 'Check that you copied the whole link, or ask a workspace owner to invite you again.',
  },
  expired: {
    title: 'This invitation has expired',
    body: 'Invitations last seven days. Ask a workspace owner to send a new one.',
  },
  revoked: {
    title: 'This invitation was withdrawn',
    body: 'A newer invitation may have been sent to you. Otherwise, contact a workspace owner.',
  },
  accepted: {
    title: 'You’ve already joined',
    body: 'This invitation has been used. Sign in with your email and password.',
  },
};

const ROLE_LABEL = { owner: 'Owner', editor: 'Editor' } as const;

async function InvitationState({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let result: Awaited<ReturnType<typeof inspectInvitationToken>>;
  try {
    result = await inspectInvitationToken(token);
  } catch (error) {
    const missing = error instanceof ConfigError ? ` (${error.variable})` : '';
    return (
      <Alert variant="destructive">
        <AlertCircle aria-hidden />
        <AlertTitle>The newsroom is temporarily unavailable</AlertTitle>
        <AlertDescription>
          We couldn’t check this invitation{missing}. Please try again shortly.
        </AlertDescription>
      </Alert>
    );
  }

  if (result.state !== 'valid' || !result.invitation) {
    const copy = UNUSABLE[result.state === 'valid' ? 'invalid' : result.state];
    return (
      <div>
        <h1 className="display-md mb-3">{copy.title}</h1>
        <p className="mb-8 leading-relaxed text-muted-foreground">{copy.body}</p>
        <Button asChild variant="outline">
          <Link href="/login">Go to sign in</Link>
        </Button>
      </div>
    );
  }

  const { invitation } = result;
  return (
    <div>
      <p className="eyebrow mb-3">Invitation · {ROLE_LABEL[invitation.role]}</p>
      <h1 className="display-md mb-3">Join the Omenai newsroom</h1>
      <p className="mb-2 leading-relaxed text-muted-foreground">
        You’ve been invited to join as an{' '}
        <span className="text-foreground">{ROLE_LABEL[invitation.role]}</span>.
      </p>
      <p className="mb-8 leading-relaxed text-muted-foreground">
        Set a password to finish creating your account for{' '}
        <span className="font-medium text-foreground">{invitation.email}</span>.
      </p>
      <AcceptInvitationForm token={token} email={invitation.email} />
      <p className="mt-6 text-xs text-muted-foreground">
        Expires{' '}
        <time dateTime={invitation.expiresAt.toISOString()}>
          {invitation.expiresAt.toLocaleDateString('en-GB', { dateStyle: 'long' })}
        </time>
        .
      </p>
    </div>
  );
}

export default function InvitationPage({ params }: PageProps<'/invite/[token]'>) {
  return (
    <Suspense
      fallback={
        <div className="space-y-4" aria-busy="true" aria-label="Checking invitation">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      }
    >
      <InvitationState params={params} />
    </Suspense>
  );
}
