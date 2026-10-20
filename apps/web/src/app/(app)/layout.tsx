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
            <div className="canvas flex min-h-16 items-center lg:min-h-20">
              <Wordmark />
            </div>
          }
        >
          <AppHeader />
        </Suspense>
      </header>
      <main id="main" className="canvas flex-1 pt-5 pb-16 md:pt-6 md:pb-20">
        {children}
      </main>
      {/* One compact footer on every page. */}
      <footer className="canvas">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-hairline py-5">
          <p className="text-[0.8125rem] font-medium text-ink">
            Omenai Newsroom{' '}
            <span className="font-normal text-slate">· Stories shaping culture</span>
          </p>
          <p className="meta">For the editorial team</p>
        </div>
      </footer>
    </div>
  );
}
