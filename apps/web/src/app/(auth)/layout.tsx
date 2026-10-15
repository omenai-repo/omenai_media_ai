import type { ReactNode } from 'react';

import { Wordmark } from '@/components/brand/wordmark';

/** Split editorial layout for sign-in and invitations; stacks on small screens. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <aside className="relative hidden flex-col justify-between overflow-hidden border-r bg-sidebar px-12 py-10 lg:flex">
        <Wordmark />
        <figure className="max-w-md">
          <blockquote className="font-serif text-4xl leading-[1.15] font-light tracking-tight text-balance">
            Global in perspective. Selective in coverage.{' '}
            <em className="text-ochre">Distinctive in taste.</em>
          </blockquote>
          <figcaption className="kicker mt-6">Omenai editorial principle</figcaption>
        </figure>
        <p className="kicker">Stories Shaping Culture</p>
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -bottom-24 size-96 rounded-full border border-ochre/25"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -right-8 -bottom-40 size-96 rounded-full border border-ochre/15"
        />
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
