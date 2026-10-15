import Link from 'next/link';
import { Suspense, type ReactNode } from 'react';

import { Wordmark } from '@/components/brand/wordmark';
import { UserMenu } from '@/components/layout/user-menu';
import { Skeleton } from '@/components/ui/skeleton';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh">
      <header className="border-b">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link href="/" className="rounded-sm">
            <Wordmark />
          </Link>
          <Suspense fallback={<Skeleton className="h-8 w-40" />}>
            <UserMenu />
          </Suspense>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">{children}</main>
    </div>
  );
}
