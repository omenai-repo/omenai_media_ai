import { Suspense } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { requirePageUser } from '@/lib/session';

async function Newsroom() {
  await requirePageUser();
  // Phase 2 adds discovery runs; until then there is genuinely nothing to show.
  return (
    <section aria-labelledby="newsroom-heading" className="max-w-2xl">
      <p className="kicker mb-3">Daily newsroom</p>
      <h1 id="newsroom-heading" className="mb-4 text-4xl font-normal">
        No discovery runs yet
      </h1>
      <p className="leading-relaxed text-muted-foreground">
        The daily shortlist appears here once the discovery pipeline has run. Each morning’s run
        starts at midnight Central Time.
      </p>
    </section>
  );
}

export default function HomePage() {
  return (
    <Suspense
      fallback={
        <div className="max-w-2xl space-y-4" aria-busy="true">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-10 w-2/3" />
          <Skeleton className="h-16 w-full" />
        </div>
      }
    >
      <Newsroom />
    </Suspense>
  );
}
