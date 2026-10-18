import type { ReactNode } from 'react';

import { Wordmark } from '@/components/brand/wordmark';

/** Split editorial layout for sign-in and invitations; stacks on small screens. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <aside className="hidden flex-col justify-between border-r border-hairline bg-bone px-14 py-12 lg:flex">
        <Wordmark />
        <figure className="max-w-lg">
          <span aria-hidden className="mb-8 block h-px w-14 bg-ochre" />
          <blockquote className="display-lg text-ink">
            Global in perspective. Selective in coverage.{' '}
            <em className="text-ochre">Distinctive in taste.</em>
          </blockquote>
          <figcaption className="meta mt-6">The Omenai editorial principle</figcaption>
        </figure>
        <p className="font-display text-lg text-graphite italic">Stories Shaping Culture</p>
      </aside>
      <main className="flex flex-col px-6 py-8 sm:px-12">
        <Wordmark className="lg:hidden" />
        <div className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-sm">{children}</div>
        </div>
      </main>
    </div>
  );
}
