import { getNewsroom, readRuntime, type ReviewedStoryDto, type RunSummaryDto } from '@repo/core';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';

import {
  editionIntro,
  editionName,
  editionTitle,
  progressLine,
  outcomeTone,
  shortfallPlain,
  smallEditionNote,
} from '@/components/editorial/copy';
import { EditionPicker } from '@/components/editorial/edition-picker';
import { formatDateTime } from '@/components/editorial/format';
import {
  Disclosure,
  EmptyState,
  MetaLine,
  PageMasthead,
  StatusLabel,
  StatusNote,
} from '@/components/editorial/primitives';
import { StoryCard } from '@/components/editorial/story-card';
import { Skeleton } from '@/components/ui/skeleton';
import { requirePageUser } from '@/lib/session';
import { cn } from '@/lib/utils';

export const metadata: Metadata = { title: 'Today’s edition' };

async function Edition({ searchParams }: Pick<PageProps<'/'>, 'searchParams'>) {
  const user = await requirePageUser();
  const { run: runParam } = await searchParams;
  const requested = typeof runParam === 'string' ? runParam : undefined;
  const { run, shortlist, reviewed, recentRuns, newerRun } = await getNewsroom(requested);

  if (!run) {
    return (
      <>
        <PageMasthead eyebrow="Today’s edition" title="Stories Shaping Culture" size="xl" />
        {newerRun ? <NewerRunNote run={newerRun} hasEdition={false} /> : null}
        <EmptyState
          title={
            requested ? 'We couldn’t find that edition' : 'The first edition hasn’t arrived yet'
          }
        >
          <p>
            {readRuntime() === 'production'
              ? 'Every night at midnight (Chicago time) the newsroom looks for new stories in contemporary culture, reviews each one against our editorial standards and recommends the strongest five to eight here.'
              : 'In this development newsroom, a search for stories runs only when an owner starts one. It reviews each story against our editorial standards and recommends the strongest five to eight here.'}
            {user.role === 'owner' ? (
              <>
                {' '}
                You can also start a search yourself from{' '}
                <Link href="/operations" className="underline decoration-ochre">
                  Operations
                </Link>
                .
              </>
            ) : null}
          </p>
        </EmptyState>
      </>
    );
  }

  const [lead, ...rest] = shortlist;
  const second = rest.slice(0, 2);
  const more = rest.slice(2);

  return (
    <div className="fade-in">
      <PageMasthead
        eyebrow={requested ? 'Edition' : 'Today’s edition'}
        title={editionTitle(run.runKey)}
        size="xl"
        aside={<EditionPicker runs={recentRuns} current={run.runKey} />}
      >
        <p>{editionIntro(run)}</p>
        <MetaLine
          className="mt-3 font-sans"
          items={[
            run.trigger === 'manual' ? 'An extra edition, started by hand' : null,
            run.completedAt ? `Ready ${formatDateTime(run.completedAt)}` : null,
          ]}
        />
      </PageMasthead>

      {newerRun ? <NewerRunNote run={newerRun} hasEdition /> : null}

      {run.shortfallReasons.length === 0 && run.sourceFailures + run.evaluationFailures > 0 ? (
        <StatusNote
          tone="attention"
          title="Some sources couldn’t be read for this edition."
          className="mt-8 max-w-3xl"
        >
          The stories below were assessed from what could be read; nothing was assumed about the
          rest. Details are in{' '}
          <Link href="/operations" className="text-ink underline decoration-ochre">
            Operations
          </Link>
          .
        </StatusNote>
      ) : null}

      {run.shortfallReasons.length > 0 && lead ? (
        <SmallEdition run={run} hasReviewed={reviewed.length > 0} className="mt-8" />
      ) : null}

      {lead ? (
        <div className="mt-10 md:mt-14">
          <StoryCard story={lead} variant="lead" />
          {second.length === 1 ? (
            <div className="mt-16 md:mt-24">
              <StoryCard story={second[0]!} variant="feature" />
            </div>
          ) : second.length ? (
            <div className="mt-16 grid gap-14 md:mt-24 md:grid-cols-2 md:gap-10 lg:gap-14">
              {second.map((story) => (
                <StoryCard key={story.id} story={story} />
              ))}
            </div>
          ) : null}
          {more.length ? (
            <div className="mt-16 grid gap-14 sm:grid-cols-2 sm:gap-10 md:mt-20 lg:grid-cols-3">
              {more.map((story) => (
                <StoryCard key={story.id} story={story} />
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <EmptyState title="No story met our standards in this edition" className="mt-10">
          <p>
            That happens, and it’s by design: we never pad an edition to fill it.
            {reviewed.length ? ' Every story we reviewed is listed below with the reason.' : ''}
          </p>
          {run.shortfallReasons.length ? (
            <Disclosure summary="Why there are no stories" className="mt-6 font-sans text-base">
              <ShortfallList run={run} />
            </Disclosure>
          ) : null}
        </EmptyState>
      )}

      {reviewed.length ? <AlsoReviewed stories={reviewed} /> : null}
    </div>
  );
}

function ShortfallList({ run }: { run: RunSummaryDto }) {
  return (
    <ul className="grid gap-1.5 text-[0.9375rem] text-graphite">
      {run.shortfallReasons.map((reason) => (
        <li key={reason.code}>{shortfallPlain(reason)}</li>
      ))}
    </ul>
  );
}

/** A smaller edition, said once and plainly; the reasons are there for anyone who wants them. */
function SmallEdition({
  run,
  hasReviewed,
  className,
}: {
  run: RunSummaryDto;
  hasReviewed: boolean;
  className?: string;
}) {
  return (
    <div className={cn('max-w-3xl', className)}>
      <StatusNote tone="info" title={smallEditionNote(run.shortlisted)}>
        <Disclosure summary="Why fewer stories" className="mt-1 border-t-0">
          <ShortfallList run={run} />
          {hasReviewed ? (
            <a
              href="#also-reviewed"
              className="mt-3 inline-block text-ink underline decoration-ochre"
            >
              See why each story wasn’t recommended
            </a>
          ) : null}
        </Disclosure>
      </StatusNote>
    </div>
  );
}

/** The latest edition is still being prepared, or its search failed: say so above the last one. */
function NewerRunNote({ run, hasEdition }: { run: RunSummaryDto; hasEdition: boolean }) {
  const previous = hasEdition ? ' Below is the most recent finished edition.' : '';
  if (run.status === 'failed')
    return (
      <StatusNote
        tone="attention"
        title={`The search for the ${editionName(run.runKey).replace(/^Edition/, 'edition')} didn’t finish.`}
        className="mt-8 max-w-3xl"
      >
        {`It stopped before choosing any stories.${previous} Details are in Operations.`}
      </StatusNote>
    );
  return (
    <StatusNote
      tone="info"
      title={`The ${editionName(run.runKey).replace(/^Edition/, 'edition')} is being prepared.`}
      className="mt-8 max-w-3xl"
    >
      {`${progressLine(run.progress) ?? 'Working'}.${previous}`}
    </StatusNote>
  );
}

function AlsoReviewed({ stories }: { stories: ReviewedStoryDto[] }) {
  return (
    <div id="also-reviewed" className="mt-20 scroll-mt-24 md:mt-28">
      <Disclosure
        variant="card"
        summary={`Also reviewed in this edition (${stories.length})`}
        hint="Why these weren’t recommended"
      >
        <ul className="divide-y divide-hairline-soft">
          {stories.map((story) => (
            <li key={story.id} className="grid gap-1 py-4 md:grid-cols-12 md:gap-8">
              <p className="md:col-span-7">
                <Link
                  href={`/stories/${story.id}`}
                  className="headline-link font-display text-xl leading-snug text-ink"
                >
                  {story.headline}
                </Link>
              </p>
              <div className="md:col-span-5">
                <StatusLabel
                  tone={story.outcome === 'qualified' ? 'info' : outcomeTone(story.outcome)}
                >
                  {story.reason}
                </StatusLabel>
              </div>
            </li>
          ))}
        </ul>
      </Disclosure>
    </div>
  );
}

function EditionSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading the edition">
      <div className="space-y-4 pb-10">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-16 w-3/4" />
        <Skeleton className="h-5 w-1/2" />
      </div>
      <div className="mt-14 grid gap-10 lg:grid-cols-12">
        <Skeleton className="aspect-[3/2] lg:col-span-7" />
        <div className="space-y-4 lg:col-span-5">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      </div>
    </div>
  );
}

export default function NewsroomPage({ searchParams }: PageProps<'/'>) {
  return (
    <Suspense fallback={<EditionSkeleton />}>
      <Edition searchParams={searchParams} />
    </Suspense>
  );
}
