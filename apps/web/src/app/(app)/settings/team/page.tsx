import { isEmailConfigured, listInvitations, listUsers } from '@repo/core';
import type { Metadata } from 'next';
import { Suspense } from 'react';

import { ROLE } from '@/components/editorial/copy';
import { formatDate } from '@/components/editorial/format';
import { PageMasthead, Section } from '@/components/editorial/primitives';
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
  return (
    <>
      <PageMasthead eyebrow="Owner settings" title="Team" size="md">
        <p>Who can use the newsroom, and what they can do.</p>
      </PageMasthead>
      <div className="mt-10 grid max-w-4xl gap-14">
        <section aria-labelledby="invite-title" className="surface p-5 sm:p-7">
          <h2 id="invite-title" className="display-sm">
            Invite someone
          </h2>
          <p className="meta mt-1 mb-6 max-w-[60ch]">
            The newsroom is by invitation only. Each link works once and expires after seven days.
          </p>
          <InviteForm emailConfigured={isEmailConfigured()} />
          <dl className="mt-7 grid gap-5 border-t border-hairline-soft pt-5 sm:grid-cols-2">
            {Object.entries(ROLE).map(([id, role]) => (
              <div key={id}>
                <dt className="text-sm font-semibold text-ink">{role.label}</dt>
                <dd className="mt-1 text-[0.9375rem] leading-relaxed text-graphite">
                  {role.description}
                </dd>
              </div>
            ))}
          </dl>
        </section>
        <Section
          title="People with access"
          description={`${active} ${active === 1 ? 'person' : 'people'} can sign in.`}
        >
          <MembersTable members={members} currentUserId={owner.id} />
        </Section>
        <Section title="Invitations">
          <InvitationsTable invitations={invitationRows} />
        </Section>
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
