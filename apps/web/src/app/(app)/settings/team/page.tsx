import { isEmailConfigured, listInvitations, listUsers } from '@repo/core';
import type { Metadata } from 'next';
import { Suspense } from 'react';

import { ROLE } from '@/components/editorial/copy';
import { formatDate } from '@/components/editorial/format';
import { PageMasthead } from '@/components/editorial/primitives';
import { InvitationsTable, type InvitationRow } from '@/components/team/invitations-table';
import { InviteForm } from '@/components/team/invite-form';
import { MembersTable, type MemberRow } from '@/components/team/members-table';
import { Skeleton } from '@/components/ui/skeleton';
import { requirePageUser } from '@/lib/session';

export const metadata: Metadata = { title: 'Team' };

/** Loads and shapes team data for the client lists (plain values, invitation expiry resolved now). */
async function loadTeam(): Promise<{ members: MemberRow[]; invitationRows: InvitationRow[] }> {
  const [users, invitations] = await Promise.all([listUsers(), listInvitations()]);
  const now = Date.now();
  const members: MemberRow[] = users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    status: u.status,
    joined: formatDate(u.createdAt ? u.createdAt.toISOString() : null),
  }));
  const invitationRows: InvitationRow[] = invitations.map((i) => ({
    id: i.id,
    email: i.email,
    role: i.role,
    state: i.status === 'pending' && i.expiresAt.getTime() <= now ? 'expired' : i.status,
    expires: formatDate(i.expiresAt.toISOString()),
    created: formatDate(i.createdAt.toISOString()),
  }));
  return { members, invitationRows };
}

async function Team() {
  // Owner-only: editors get a 404 here, and the team APIs refuse them independently.
  const owner = await requirePageUser('team:manage');
  const { members, invitationRows } = await loadTeam();

  const active = members.filter((m) => m.status === 'active').length;
  const owners = members.filter((m) => m.status === 'active' && m.role === 'owner').length;
  const waiting = invitationRows.filter(
    (i) => i.state === 'pending' || i.state === 'claimed',
  ).length;
  return (
    <>
      <PageMasthead
        eyebrow="Owner settings"
        title="Team"
        size="xl"
        className="border-b border-hairline pt-2 pb-8 sm:pt-4"
        aside={
          <dl className="flex gap-8">
            {[
              ['Can sign in', active],
              ['Owners', owners],
              ['Invitations waiting', waiting],
            ].map(([label, value]) => (
              <div key={label} className="flex flex-col-reverse">
                <dt className="text-[0.78125rem] text-slate">{label}</dt>
                <dd className="masthead mb-0.5 text-[2.75rem] leading-[0.9]">{value}</dd>
              </div>
            ))}
          </dl>
        }
      >
        <p>Who can use the newsroom, and what they can do.</p>
      </PageMasthead>
      <div className="mt-9 flex flex-wrap items-start gap-x-12 gap-y-10">
        <div className="min-w-0 flex-[1_1_100%] lg:sticky lg:top-28 lg:flex-[0_1_28.75rem]">
          <section
            aria-labelledby="invite-title"
            className="rounded-[18px] border border-hairline px-5 py-6 sm:px-7"
          >
            <h2 id="invite-title" className="font-serif text-[1.875rem] leading-tight font-medium">
              Invite someone
            </h2>
            <p className="mt-1.5 mb-5 max-w-[60ch] text-sm leading-normal text-graphite">
              The newsroom is by invitation only. Each link works once and expires after seven days.
            </p>
            <InviteForm emailConfigured={isEmailConfigured()} />
            <dl className="mt-6 grid gap-4 border-t border-hairline-soft pt-5">
              {Object.entries(ROLE).map(([id, role]) => (
                <div key={id}>
                  <dt className="text-sm font-semibold text-ink">{role.label}</dt>
                  <dd className="mt-1 text-[0.90625rem] leading-relaxed text-graphite">
                    {role.description}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
        <div className="flex min-w-0 flex-[1_1_35rem] flex-col gap-11">
          <section aria-labelledby="people-title">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2
                id="people-title"
                className="font-serif text-[1.875rem] leading-tight font-medium"
              >
                People with access
              </h2>
              <p className="text-[0.84375rem] text-slate">
                {active} {active === 1 ? 'person' : 'people'} can sign in.
              </p>
            </div>
            <div className="mt-3.5">
              <MembersTable members={members} currentUserId={owner.id} />
            </div>
          </section>
          <section aria-labelledby="invitations-title">
            <h2
              id="invitations-title"
              className="mb-3.5 font-serif text-[1.875rem] leading-tight font-medium"
            >
              Invitations
            </h2>
            <InvitationsTable invitations={invitationRows} />
          </section>
        </div>
      </div>
    </>
  );
}

export default function TeamPage() {
  // The heading renders only after the owner check, so editors never see an owner page shell.
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" aria-busy="true" aria-label="Loading" />}>
      <Team />
    </Suspense>
  );
}
