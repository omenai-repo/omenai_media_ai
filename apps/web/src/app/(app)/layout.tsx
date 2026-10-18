import { Suspense, type ReactNode } from 'react';

import { Wordmark } from '@/components/brand/wordmark';
import { AppHeader } from '@/components/layout/app-header';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only rounded-sm bg-ink px-3 py-2 text-ivory focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b border-hairline bg-paper/95 backdrop-blur-sm">
        <Suspense
          fallback={
            <div className="canvas flex h-16 items-center md:h-[4.5rem]">
              <Wordmark />
            </div>
          }
        >
          <AppHeader />
        </Suspense>
      </header>
      <main id="main" className="canvas flex-1 pt-10 pb-24 md:pt-14">
        {children}
      </main>
      <footer className="border-t border-hairline">
        <div className="canvas flex flex-wrap items-baseline justify-between gap-2 py-6">
          <span className="font-display text-lg text-graphite italic">Stories Shaping Culture</span>
          <span className="meta">Omenai Newsroom · for the editorial team</span>
        </div>
      </footer>
    </div>
  );
}
