import Link from 'next/link';

import { Wordmark } from '@/components/brand/wordmark';

/** Any address outside the app's pages, and a story workspace that doesn't exist. */
export default function NotFound() {
  return (
    <main className="canvas flex min-h-dvh flex-col justify-center gap-8 py-16">
      <Wordmark />
      <div className="max-w-3xl">
        <h1 className="masthead text-[clamp(3.5rem,2rem+5.2vw,6.5rem)]">Nothing here</h1>
        <p className="standfirst mt-4 max-w-[52ch]">
          We couldn’t find that page. It may have moved, or it may not be open to you.
        </p>
        <Link
          href="/"
          className="text-link mt-6 inline-flex min-h-11 items-center rounded-sm text-sm font-semibold text-ink"
        >
          Back to today’s edition
        </Link>
      </div>
    </main>
  );
}
