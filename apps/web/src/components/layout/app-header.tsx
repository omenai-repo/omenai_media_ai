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

/** Up to two initials for the avatar: "Amara Okafor" → "AO", "kofi@…" → "K". */
function initials(name: string): string {
  const words = name.split(/[\s@.]+/).filter(Boolean);
  return words
    .slice(0, name.includes('@') ? 1 : 2)
    .map((word) => word[0]!.toUpperCase())
    .join('');
}

/** Resolves the signed-in user (redirecting visitors to /login) and renders navigation for their role. */
export async function AppHeader() {
  const user = await requirePageUser();
  const items =
    user.role === 'owner' ? [...EDITORIAL, { href: '/settings/team', label: 'Team' }] : EDITORIAL;
  const name = user.name || user.email;
  const runtime = readRuntime();
  return (
    <>
      {/* Always visible outside production, but quiet: one line, a dot saying which kind. */}
      {runtime === 'fixtures' ? (
        <p className="flex items-center justify-center gap-2 border-b border-hairline bg-bone px-4 py-1 text-center text-[0.71875rem] leading-snug text-graphite">
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-amber" />
          <span>
            <span className="font-semibold text-ink">Development fixtures:</span> invented data, not
            real reporting.
          </span>
        </p>
      ) : runtime === 'live-dev' ? (
        <p className="flex items-center justify-center gap-2 border-b border-hairline bg-bone px-4 py-1 text-center text-[0.71875rem] leading-snug text-graphite">
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-stone" />
          <span>
            <span className="font-semibold text-ink">Live development ({getDatabaseName()}):</span>{' '}
            real searches and AI within daily limits; not the production newsroom.
          </span>
        </p>
      ) : null}
      <div className="canvas flex min-h-16 items-center justify-between gap-4 py-2.5 lg:min-h-20">
        <div className="flex min-w-0 items-center gap-2">
          <MobileNav items={items} name={name} role={roleLabel(user.role)} />
          <Link href="/" className="rounded-sm" aria-label="Omenai Newsroom, today’s edition">
            <Wordmark />
          </Link>
        </div>
        <DesktopNav items={items} />
        <div className="flex shrink-0 items-center gap-2.5">
          <p className="hidden text-right leading-tight xl:block">
            <span className="block text-sm font-medium text-ink">{name}</span>
            <span className="meta">{roleLabel(user.role)}</span>
          </p>
          <span
            aria-hidden
            title={name}
            className="inline-flex size-9 items-center justify-center rounded-full bg-ink text-xs font-semibold tracking-[0.03em] text-white lg:size-10"
          >
            {initials(name)}
          </span>
          <SignOutButton iconOnly className="hidden border-hairline lg:inline-flex" />
        </div>
      </div>
    </>
  );
}
