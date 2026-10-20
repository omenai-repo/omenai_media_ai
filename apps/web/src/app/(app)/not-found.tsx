import Link from 'next/link';

/**
 * A page that doesn't exist, or one the signed-in role can't open: owner pages answer editors
 * with this same page, so it never says which.
 */
export default function NotFound() {
  return (
    <div className="max-w-3xl pt-4 sm:pt-8">
      <p className="eyebrow mb-3">Not found</p>
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
  );
}
