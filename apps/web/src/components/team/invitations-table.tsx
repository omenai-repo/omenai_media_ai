'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/editorial/confirm-dialog';
import { INVITATION_STATUS, roleLabel } from '@/components/editorial/copy';
import { Disclosure } from '@/components/editorial/primitives';
import { Button } from '@/components/ui/button';

import { teamRequest } from './api';
import { INVITE_AGAIN_EVENT, type InviteAgainDetail } from './invite-form';

export interface InvitationRow {
  id: string;
  email: string;
  role: string;
  state: 'pending' | 'claimed' | 'accepted' | 'revoked' | 'expired';
  expires: string;
  created: string;
}

/** What happens next for an invitation, in a phrase. */
function nextStep(invitation: InvitationRow): string {
  switch (invitation.state) {
    case 'pending':
      return `Their link works until ${invitation.expires}.`;
    case 'claimed':
      return 'They’re setting up their account now.';
    case 'expired':
      return 'The link has expired. Invite them again to give them access.';
    case 'revoked':
      return 'The link no longer works.';
    default:
      return 'They now appear under People with access.';
  }
}

function inviteAgain(invitation: InvitationRow) {
  window.dispatchEvent(
    new CustomEvent<InviteAgainDetail>(INVITE_AGAIN_EVENT, {
      detail: { email: invitation.email, role: invitation.role },
    }),
  );
}

export function InvitationsTable({ invitations }: { invitations: InvitationRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [withdrawing, setWithdrawing] = useState<InvitationRow | null>(null);

  function withdraw(invitation: InvitationRow) {
    startTransition(async () => {
      try {
        await teamRequest(`/api/team/invitations/${invitation.id}`, { method: 'DELETE' });
        toast.success(`Invitation for ${invitation.email} withdrawn`);
        router.refresh();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : 'The invitation couldn’t be withdrawn.',
        );
      }
    });
  }

  if (invitations.length === 0)
    return <p className="meta">No invitations yet. Invitations you send will appear here.</p>;

  // Outstanding invitations need a decision; finished ones are kept for reference.
  const outstanding = invitations.filter((i) =>
    ['pending', 'claimed', 'expired'].includes(i.state),
  );
  const past = invitations.filter((i) => !outstanding.includes(i));

  const row = (invitation: InvitationRow) => {
    const status = INVITATION_STATUS[invitation.state] ?? INVITATION_STATUS.pending!;
    return (
      <li
        key={invitation.id}
        className="grid gap-x-6 gap-y-2 px-4 py-4 sm:grid-cols-[1fr_auto] sm:items-center sm:px-5.5"
      >
        <div className="min-w-0">
          <p className="font-medium break-all text-ink">{invitation.email}</p>
          <p className="meta">
            As {roleLabel(invitation.role).toLowerCase()} · sent {invitation.created}.{' '}
            {nextStep(invitation)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {/* Only an expired link is worth colour: it needs re-sending. */}
          {invitation.state === 'expired' ? (
            <span className="inline-flex items-center gap-1.5 text-[0.8125rem] font-semibold text-amber">
              <span aria-hidden className="size-1.5 rounded-full bg-current" />
              {status.label}
            </span>
          ) : (
            <span className="inline-flex h-6 items-center rounded-full border border-tag-line px-2.5 text-xs font-medium text-graphite">
              {status.label}
            </span>
          )}
          {invitation.state === 'pending' ? (
            <Button variant="quiet" disabled={pending} onClick={() => setWithdrawing(invitation)}>
              Withdraw
            </Button>
          ) : null}
          {invitation.state === 'expired' || invitation.state === 'revoked' ? (
            <Button variant="outline" size="sm" onClick={() => inviteAgain(invitation)}>
              Invite again
            </Button>
          ) : null}
        </div>
      </li>
    );
  };

  return (
    <div className="grid gap-4">
      {outstanding.length ? (
        <ul className="divide-y divide-hairline-soft overflow-hidden rounded-[18px] border border-hairline">
          {outstanding.map(row)}
        </ul>
      ) : (
        <p className="meta">No invitations are waiting to be accepted.</p>
      )}
      {past.length ? (
        <Disclosure
          variant="card"
          summary={`Past invitations (${past.length})`}
          hint="Accepted and withdrawn"
        >
          <ul className="-mx-5 divide-y divide-hairline-soft sm:-mr-6 sm:-ml-[3.25rem]">
            {past.map(row)}
          </ul>
        </Disclosure>
      ) : null}
      {withdrawing ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setWithdrawing(null);
          }}
          title="Withdraw this invitation?"
          confirmLabel="Withdraw invitation"
          destructive
          onConfirm={() => withdraw(withdrawing)}
        >
          <p>
            The link sent to {withdrawing.email} will stop working. You can invite them again at any
            time.
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
