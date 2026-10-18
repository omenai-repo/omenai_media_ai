import { getDatabaseName, readRuntime } from '@repo/core';
import Link from 'next/link';

import { Wordmark } from '@/components/brand/wordmark';
import { roleLabel } from '@/components/editorial/copy';
import { requirePageUser } from '@/lib/session';

import { DesktopNav, MobileNav, type NavItem } from './main-nav';
import { SignOutButton } from './sign-out-button';

const EDITORIAL: NavItem[] = [
  { href: '/', label: 'Today’s edition' },
  { href: '/saved', label: 'Reading list' },
  { href: '/operations', label: 'Operations' },
];

/** Resolves the signed-in user (redirecting visitors to /login) and renders navigation for their role. */
export async function AppHeader() {
  const user = await requirePageUser();
  const items =
    user.role === 'owner' ? [...EDITORIAL, { href: '/settings/team', label: 'Team' }] : EDITORIAL;
  const name = user.name || user.email;
  const runtime = readRuntime();
  return (
    <>
      {runtime === 'fixtures' ? (
        <p className="border-b border-amber/30 bg-amber-wash py-1.5 text-center text-xs text-ink">
          <span className="font-medium">Development fixtures.</span> Stories, sources, people and
          usage here are invented for testing; none of it is real reporting.
        </p>
      ) : runtime === 'live-dev' ? (
        <p className="border-b border-hairline bg-bone/70 py-1.5 text-center text-xs text-ink">
          <span className="font-medium">Live development ({getDatabaseName()}).</span> Real searches
          and AI, within daily usage limits. Not the production newsroom.
        </p>
      ) : null}
      <div className="canvas flex h-16 items-center justify-between gap-4 md:h-[4.5rem]">
        <div className="flex items-center gap-2 lg:gap-12">
          <MobileNav items={items} name={name} role={roleLabel(user.role)} />
          <Link href="/" className="rounded-sm" aria-label="Omenai Newsroom, today’s edition">
            <Wordmark />
          </Link>
          <DesktopNav items={items} />
        </div>
        <div className="flex items-center gap-4">
          <p className="hidden text-right leading-tight lg:block">
            <span className="block text-sm text-ink">{name}</span>
            <span className="meta">{roleLabel(user.role)}</span>
          </p>
          <SignOutButton className="hidden md:inline-flex" />
        </div>
      </div>
    </>
  );
}
