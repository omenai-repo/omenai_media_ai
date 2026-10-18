import { getResearchView, getStoryDetail, NotFoundError } from '@repo/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';

import { Wordmark } from '@/components/brand/wordmark';
import { pillarLabel, placeLabel } from '@/components/editorial/format';
import { ResearchWorkspace } from '@/components/research/workspace';
import { requirePageUser } from '@/lib/session';

export const metadata: Metadata = { title: 'Research' };

async function Workspace({ params }: Pick<PageProps<'/stories/[id]/research'>, 'params'>) {
  await requirePageUser();
  const { id } = await params;
  const [story, view] = await Promise.all([getStoryDetail(id), getResearchView(id)]).catch(
    (error: unknown) => {
      if (error instanceof NotFoundError) notFound();
      throw error;
    },
  );
  const eyebrow = [pillarLabel(story.primaryPillar), placeLabel(story.geography)]
    .filter(Boolean)
    .join(' · ');
  return (
    <ResearchWorkspace story={{ id: story.id, headline: story.headline, eyebrow }} initial={view} />
  );
}

export default function ResearchPage({ params }: PageProps<'/stories/[id]/research'>) {
  return (
    <Suspense
      fallback={
        <div className="flex h-dvh flex-col items-center justify-center gap-4" aria-busy="true">
          <Wordmark />
          <p className="meta">Opening the research workspace…</p>
        </div>
      }
    >
      <Workspace params={params} />
    </Suspense>
  );
}
