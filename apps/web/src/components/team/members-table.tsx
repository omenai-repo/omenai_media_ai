'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/editorial/confirm-dialog';
import { roleLabel } from '@/components/editorial/copy';
import { StatusLabel } from '@/components/editorial/primitives';
import { Button } from '@/components/ui/button';

import { teamRequest } from './api';

export interface MemberRow {
  id: string;
  name: string;
  email: string;
  role: 'owner' | 'editor';
  status: 'active' | 'deactivated';
  joined: string;
}

type Change =
  | { kind: 'role'; member: MemberRow; role: 'owner' | 'editor' }
  | { kind: 'deactivate' | 'reactivate'; member: MemberRow };

function describe(change: Change) {
  const who = change.member.name || change.member.email;
  if (change.kind === 'role') {
    return change.role === 'owner'
      ? {
          title: `Make ${who} an owner?`,
          body: 'Owners can invite and remove people, change roles and start a search for stories, which uses paid services.',
          confirm: 'Make owner',
          destructive: false,
          done: `${who} is now an owner`,
        }
      : {
          title: `Make ${who} an editor?`,
          body: 'They will keep working with stories but can no longer manage the team or start a search for stories.',
          confirm: 'Make editor',
          destructive: false,
          done: `${who} is now an editor`,
        };
  }
  if (change.kind === 'deactivate') {
    return {
      title: `Remove ${who}’s access?`,
      body: 'They are signed out straight away and can’t sign in again. Their saves, skips and history stay. You can restore access later.',
      confirm: 'Remove access',
      destructive: true,
      done: `${who} no longer has access`,
    };
  }
  return {
    title: `Restore ${who}’s access?`,
    body: `They can sign in again as ${change.member.role === 'owner' ? 'an owner' : 'an editor'}.`,
    confirm: 'Restore access',
    destructive: false,
    done: `${who} has access again`,
  };
}

export function MembersTable({
  members,
  currentUserId,
}: {
  members: MemberRow[];
  currentUserId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [change, setChange] = useState<Change | null>(null);
  const copy = change ? describe(change) : null;

  function apply(next: Change) {
    const body =
      next.kind === 'role'
        ? { role: next.role }
        : { status: next.kind === 'deactivate' ? 'deactivated' : 'active' };
    startTransition(async () => {
      try {
        await teamRequest(`/api/team/users/${next.member.id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        toast.success(describe(next).done);
        router.refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'The change couldn’t be saved.');
      }
    });
  }

  return (
    <>
      <ul className="surface divide-y divide-hairline-soft">
        {members.map((member) => {
          const self = member.id === currentUserId;
          const active = member.status === 'active';
          return (
            <li
              key={member.id}
              className="grid gap-x-6 gap-y-3 px-5 py-4 sm:grid-cols-[1fr_auto] sm:items-center"
            >
              <div className="min-w-0">
                <p className="text-ink">
                  {member.name || member.email}
                  {self ? <span className="meta"> · You</span> : null}
                </p>
                <p className="meta break-all">
                  {member.email} · Joined {member.joined}
                </p>
                {!active ? (
                  <p className="mt-1">
                    <StatusLabel tone="attention">No access</StatusLabel>
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                {self ? (
                  <span className="text-sm text-ink">{roleLabel(member.role)}</span>
                ) : (
                  <>
                    <label className="sr-only" htmlFor={`role-${member.id}`}>
                      Role for {member.name || member.email}
                    </label>
                    <select
                      id={`role-${member.id}`}
                      value={member.role}
                      disabled={pending || !active}
                      onChange={(event) =>
                        setChange({
                          kind: 'role',
                          member,
                          role: event.target.value === 'owner' ? 'owner' : 'editor',
                        })
                      }
                      className="h-9 rounded-md border border-input bg-ivory px-2.5 text-sm text-ink transition-colors hover:border-rule-strong disabled:opacity-60"
                    >
                      <option value="editor">Editor</option>
                      <option value="owner">Owner</option>
                    </select>
                    <Button
                      variant="quiet"
                      disabled={pending}
                      onClick={() =>
                        setChange({ kind: active ? 'deactivate' : 'reactivate', member })
                      }
                    >
                      {active ? 'Remove access' : 'Restore access'}
                    </Button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {members.length === 1 ? (
        <p className="meta mt-3">No one else has access yet. Invite your first editor above.</p>
      ) : null}
      {change && copy ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setChange(null);
          }}
          title={copy.title}
          confirmLabel={copy.confirm}
          destructive={copy.destructive}
          onConfirm={() => apply(change)}
        >
          <p>{copy.body}</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
