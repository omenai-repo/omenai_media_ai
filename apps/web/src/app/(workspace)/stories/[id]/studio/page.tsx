import { getDraftsView, getStoryDetail, NotFoundError } from '@repo/core';
import { isDraftFormat } from '@repo/shared';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';

import { Wordmark } from '@/components/brand/wordmark';
import { pillarLabel, placeLabel } from '@/components/editorial/format';
import { DraftStudio } from '@/components/studio/studio';
import { requirePageUser } from '@/lib/session';

export const metadata: Metadata = { title: 'Studio' };

async function Studio({
  params,
  searchParams,
}: Pick<PageProps<'/stories/[id]/studio'>, 'params' | 'searchParams'>) {
  await requirePageUser();
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const [story, view] = await Promise.all([getStoryDetail(id), getDraftsView(id)]).catch(
    (error: unknown) => {
      if (error instanceof NotFoundError) notFound();
      throw error;
    },
  );
  const eyebrow = [pillarLabel(story.primaryPillar), placeLabel(story.geography)]
    .filter(Boolean)
    .join(' · ');
  return (
    <DraftStudio
      story={{ id: story.id, headline: story.headline, eyebrow }}
      initial={view}
      initialFormat={isDraftFormat(query.format) ? query.format : null}
    />
  );
}

export default function StudioPage({ params, searchParams }: PageProps<'/stories/[id]/studio'>) {
  return (
    <Suspense
      fallback={
        <div className="flex h-dvh flex-col items-center justify-center gap-4" aria-busy="true">
          <Wordmark />
          <p className="meta">Opening the studio…</p>
        </div>
      }
    >
      <Studio params={params} searchParams={searchParams} />
    </Suspense>
  );
}
