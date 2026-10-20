import { listSavedStories } from '@repo/core';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';

import { RemoveFromListButton } from '@/components/editorial/decisions';
import { formatDate } from '@/components/editorial/format';
import { EmptyState, PageMasthead } from '@/components/editorial/primitives';
import { StoryCard } from '@/components/editorial/story-card';
import { Skeleton } from '@/components/ui/skeleton';
import { requirePageUser } from '@/lib/session';

export const metadata: Metadata = { title: 'Reading list' };

async function ReadingList() {
  await requirePageUser();
  const stories = await listSavedStories();
  if (stories.length === 0) {
    return (
      <EmptyState title="Nothing saved yet" className="mt-10">
        <p>
          Save a story from{' '}
          <Link href="/" className="text-link text-ink">
            today’s edition
          </Link>{' '}
          to keep it here for research or a pitch. The reading list is shared by the whole team,
          newest first.
        </p>
      </EmptyState>
    );
  }
  return (
    <div className="mt-8">
      <p className="border-b-2 border-ink pb-3 text-[0.8125rem] text-graphite">
        {stories.length} {stories.length === 1 ? 'story' : 'stories'}, shared by the whole team
      </p>
      <div className="divide-y divide-hairline">
        {stories.map((story) => (
          <StoryCard
            key={story.id}
            story={story}
            actions={<RemoveFromListButton storyId={story.id} />}
            meta={story.saved ? [`Saved by ${story.saved.by}, ${formatDate(story.saved.at)}`] : []}
          />
        ))}
      </div>
    </div>
  );
}

export default function SavedPage() {
  return (
    <>
      <PageMasthead title="Reading list" size="masthead" className="pt-2 sm:pt-4">
        <p>Stories the team has kept for a closer look, research or a pitch.</p>
      </PageMasthead>
      <Suspense
        fallback={
          <div className="mt-6" aria-busy="true" aria-label="Loading the reading list">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="grid grid-cols-[10.5rem_1fr] gap-8 py-6">
                <Skeleton className="aspect-[3/2]" />
                <div className="space-y-3">
                  <Skeleton className="h-3 w-40" />
                  <Skeleton className="h-7 w-3/4" />
                  <Skeleton className="h-12 w-full" />
                </div>
              </div>
            ))}
          </div>
        }
      >
        <ReadingList />
      </Suspense>
    </>
  );
}
