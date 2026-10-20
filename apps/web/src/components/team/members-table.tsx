'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/editorial/confirm-dialog';
import { roleLabel } from '@/components/editorial/copy';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

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
      <ul className="divide-y divide-hairline-soft overflow-hidden rounded-[18px] border border-hairline">
        {members.map((member) => {
          const self = member.id === currentUserId;
          const active = member.status === 'active';
          const who = member.name || member.email;
          return (
            <li
              key={member.id}
              className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-4 sm:px-5.5"
            >
              <span
                aria-hidden
                className={cn(
                  'inline-flex size-10 flex-none items-center justify-center rounded-full text-[0.8125rem] font-semibold',
                  self ? 'bg-ink text-white' : 'bg-[#edece7] text-ink',
                  !active && 'opacity-60',
                )}
              >
                {who
                  .split(/[\s@.]+/)
                  .filter(Boolean)
                  .slice(0, who.includes('@') ? 1 : 2)
                  .map((w) => w[0]!.toUpperCase())
                  .join('')}
              </span>
              <div className="min-w-0 flex-[1_1_15rem]">
                <p className="font-medium text-ink">
                  {who}
                  {self ? (
                    <span className="text-[0.8125rem] font-normal text-slate"> · You</span>
                  ) : null}
                </p>
                <p className="meta mt-px break-all">
                  {member.email} · Joined {member.joined}
                </p>
                {!active ? (
                  <p className="mt-1.5">
                    <span className="inline-flex h-6 items-center rounded-full border border-tag-line px-2.5 text-xs font-medium text-graphite">
                      No access
                    </span>
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                {self ? (
                  <span className="text-sm font-medium text-ink">{roleLabel(member.role)}</span>
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
                      className="h-10 rounded-[10px] border border-input bg-ivory px-2.5 text-sm text-ink transition-colors hover:border-ink disabled:opacity-60"
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
