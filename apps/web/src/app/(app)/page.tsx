import {
  getDraftStatus,
  getNewsroom,
  getResearchStatus,
  readRuntime,
  type ReviewedStoryDto,
  type RunSummaryDto,
  type StoryCardDto,
} from '@repo/core';
import { PILLARS, type PillarId } from '@repo/shared';
import { ArrowDown, ChevronDown, CircleAlert, Info, TriangleAlert } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense, type ReactNode } from 'react';

import {
  editionWhen,
  outcomeShort,
  progressLine,
  shortfallPlain,
} from '@/components/editorial/copy';
import { leadStatus, planEdition, type EditionPlan } from '@/components/editorial/edition-plan';
import { EditionPicker } from '@/components/editorial/edition-picker';
import { pillarLabel, pillarShort } from '@/components/editorial/format';
import { Disclosure, EmptyState } from '@/components/editorial/primitives';
import {
  ColumnStory,
  FeatureStory,
  LeadStory,
  RankedStory,
  storyAnchor,
  storyNumber,
} from '@/components/editorial/story-card';
import { Skeleton } from '@/components/ui/skeleton';
import { requirePageUser } from '@/lib/session';
import { cn } from '@/lib/utils';

export const metadata: Metadata = { title: 'Today’s edition' };

const COUNT_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
const countWord = (n: number) => COUNT_WORDS[n] ?? String(n);

/**
 * The Newsroom: one design for every edition. "What's New" is always the page's name; the
 * edition selector says which edition is showing, and every section below is built from that
 * edition's own data, appearing only when it has something to show.
 */
async function Edition({ searchParams }: Pick<PageProps<'/'>, 'searchParams'>) {
  const user = await requirePageUser();
  const { run: runParam } = await searchParams;
  const requested = typeof runParam === 'string' ? runParam : undefined;
  const { run, shortlist, reviewed, recentRuns, newerRun } = await getNewsroom(requested);

  if (!run) {
    return (
      <>
        <h1 className="masthead masthead-xl pt-2 sm:pt-4">What’s New</h1>
        {newerRun ? (
          <Notices>
            <NewerRunNotice run={newerRun} />
          </Notices>
        ) : null}
        <EmptyState
          className="mt-6"
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
                <Link href="/operations" className="text-link text-ink">
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

  const plan = planEdition(shortlist);
  const { lead } = plan;
  // The lead's research and drafts, read from their records, for its status line.
  const [research, drafts] = lead
    ? await Promise.all([getResearchStatus(lead.id), getDraftStatus(lead.id)])
    : [null, null];
  const latest = !requested || recentRuns[0]?.runKey === run.runKey;
  const shortfall = run.shortfallReasons.length > 0 && lead !== null;
  const unreadable =
    run.shortfallReasons.length === 0 && run.sourceFailures + run.evaluationFailures > 0;

  return (
    <div className="fade-in">
      <section aria-labelledby="edition-title">
        <div className="flex flex-wrap items-end justify-between gap-x-12 gap-y-4 pt-2 sm:pt-4">
          <h1 id="edition-title" className="masthead masthead-xl">
            What’s New
          </h1>
          <div className="w-full max-w-[26rem] pb-1 sm:w-auto sm:min-w-[22rem]">
            <EditionPicker runs={recentRuns} current={run} />
            <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.8125rem]">
              {latest ? null : (
                <span className="text-graphite">
                  An earlier edition ·{' '}
                  <Link href="/" className="text-link font-semibold text-ink">
                    Back to the latest
                  </Link>
                </span>
              )}
              {plan.hasMore ? (
                <a
                  href="#contents"
                  className="text-link inline-flex min-h-11 items-center gap-1.5 font-semibold text-ink sm:min-h-8"
                >
                  All stories at a glance
                  <ArrowDown className="size-3.5" strokeWidth={2.2} aria-hidden />
                </a>
              ) : null}
            </p>
          </div>
        </div>

        {newerRun || shortfall || unreadable ? (
          <Notices>
            {newerRun ? <NewerRunNotice run={newerRun} /> : null}
            {shortfall ? <ShortfallNotice run={run} hasReviewed={reviewed.length > 0} /> : null}
            {unreadable ? (
              <Notice tone="attention">
                Some sources couldn’t be read for this edition; the stories were assessed from what
                could be read.{' '}
                <Link href="/operations" className="text-link font-medium text-ink">
                  Details in Operations
                </Link>
              </Notice>
            ) : null}
          </Notices>
        ) : null}

        {lead ? (
          <div className="mt-5">
            <LeadStory story={lead} status={leadStatus(lead, research, drafts)} />
          </div>
        ) : (
          <EmptyState title="No story met our standards in this edition" className="mt-6">
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
      </section>

      {plan.hasMore ? <MoreStories plan={plan} /> : null}
      {plan.hasMore && lead ? (
        <>
          <SubjectIndex stories={shortlist} lead={lead} />
          <Contents stories={shortlist} />
        </>
      ) : null}
      {/* The last editorial section: nothing with stories in it comes after. */}
      {reviewed.length ? <AlsoReviewed stories={reviewed} /> : null}
    </div>
  );
}

/** Compact notices above the lead: one line each, details on request. */
function Notices({ children }: { children: ReactNode }) {
  return <div className="mt-5 divide-y divide-hairline border-y border-hairline">{children}</div>;
}

const NOTICE_TONE = {
  info: { icon: Info, className: 'text-graphite' },
  attention: { icon: TriangleAlert, className: 'text-amber' },
  problem: { icon: CircleAlert, className: 'text-oxide' },
} as const;

function Notice({ tone, children }: { tone: keyof typeof NOTICE_TONE; children: ReactNode }) {
  const { icon: Icon, className } = NOTICE_TONE[tone];
  return (
    <p className="flex items-start gap-2.5 py-2.5 text-[0.84375rem] leading-normal text-ink">
      <Icon className={cn('mt-0.5 size-4 shrink-0', className)} aria-hidden />
      <span>{children}</span>
    </p>
  );
}

/** A smaller edition, said once without counts; the reasons open on request. */
function ShortfallNotice({ run, hasReviewed }: { run: RunSummaryDto; hasReviewed: boolean }) {
  return (
    <details className="disclosure group py-1">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2.5 gap-y-1 rounded-sm py-1.5 text-[0.84375rem] text-ink [&::-webkit-details-marker]:hidden">
        <Info className="size-4 shrink-0 text-graphite" aria-hidden />
        <span>Fewer stories than usual: we don’t lower the bar to fill an edition.</span>
        <span className="inline-flex items-center gap-1 font-semibold underline underline-offset-[3px]">
          Why fewer stories?
          <ChevronDown
            className="size-3.5 transition-transform group-open:rotate-180"
            aria-hidden
          />
        </span>
      </summary>
      <div className="pt-1 pb-3 pl-6.5 group-open:rise-in">
        <ShortfallList run={run} />
        {hasReviewed ? (
          <a href="#also-reviewed" className="text-link mt-2 inline-block text-sm text-ink">
            See why each story wasn’t recommended
          </a>
        ) : null}
      </div>
    </details>
  );
}

/** A newer edition is being prepared, or its search failed: said in one line. */
function NewerRunNotice({ run }: { run: RunSummaryDto }) {
  const { day } = editionWhen(run);
  if (run.status === 'failed')
    return (
      <Notice tone="attention">
        The search for {day} didn’t finish, so the latest complete edition is shown.{' '}
        <Link href="/operations" className="text-link font-medium text-ink">
          Details in Operations
        </Link>
      </Notice>
    );
  return (
    <Notice tone="info">
      The edition of {day} is being prepared · {progressLine(run.progress) ?? 'Working'}.
    </Notice>
  );
}

/**
 * The edition by subject: one word per subject with its count, linking to the first story on
 * it. The lead's subject is underlined. Anchors, not a filter.
 */
function SubjectIndex({ stories, lead }: { stories: StoryCardDto[]; lead: StoryCardDto }) {
  const subjects = (Object.keys(PILLARS) as PillarId[])
    .map((id) => ({ id, stories: stories.filter((story) => story.primaryPillar === id) }))
    .filter((subject) => subject.stories.length > 0);
  if (subjects.length === 0) return null;
  return (
    <nav
      aria-label="This edition by subject"
      className="mt-14 flex flex-wrap items-baseline gap-x-8 gap-y-3 border-t-2 border-ink pt-4 md:mt-16"
    >
      <span className="w-full text-[0.78125rem] text-graphite sm:w-auto">In this edition</span>
      {subjects.map(({ id, stories: onSubject }) => {
        const current = id === lead.primaryPillar;
        const count = onSubject.length;
        return (
          <a
            key={id}
            href={`#${storyAnchor(onSubject[0]!.id)}`}
            title={`${pillarLabel(id)}: ${count} ${count === 1 ? 'story' : 'stories'}`}
            className={cn(
              'masthead inline-flex items-start gap-1 rounded-sm text-[1.75rem] leading-none sm:text-[1.875rem]',
              current
                ? 'border-b-2 border-ink pb-1'
                : 'pb-1.5 text-subject transition-colors hover:text-ink',
            )}
          >
            {pillarShort(id)}
            <span
              aria-hidden
              className="font-sans text-xs leading-none font-semibold text-graphite normal-case [font-stretch:100%]"
            >
              {count}
            </span>
            <span className="sr-only">
              , {count} {count === 1 ? 'story' : 'stories'}
            </span>
          </a>
        );
      })}
    </nav>
  );
}

/** One plain note per story for the contents list: the decision first, then a flag. */
function contentsNote(story: StoryCardDto): string | null {
  if (story.editorialState === 'skipped') return 'Skipped';
  if (story.editorialState === 'saved') return 'Saved';
  if (story.isUpdate) return 'Update';
  if (story.relation === 'new_development') return 'New development';
  if (story.timeliness === 'urgent') return 'Time-sensitive';
  return null;
}

/** Every recommended story on one screen: the quick route to any of them. */
function Contents({ stories }: { stories: StoryCardDto[] }) {
  return (
    <section id="contents" aria-labelledby="contents-title" className="mt-12 scroll-mt-28">
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-ink pb-2.5">
        <h2 id="contents-title" className="section-label">
          All {stories.length} stories
        </h2>
        <span className="text-[0.78125rem] text-slate">
          Strongest first. Choose one to jump to it.
        </span>
      </div>
      <ol className="grid grid-cols-[minmax(0,1fr)] gap-x-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {stories.map((story, index) => {
          const note = contentsNote(story);
          const skipped = story.editorialState === 'skipped';
          return (
            <li key={story.id} className="border-b border-hairline-soft">
              <a
                href={`#${storyAnchor(story.id)}`}
                className={cn(
                  'group/row flex min-h-12 items-center gap-3.5 rounded-sm py-1.5',
                  skipped && 'text-slate',
                )}
              >
                <span
                  className={cn('masthead w-6 flex-none text-[1.0625rem]', skipped && 'text-slate')}
                >
                  {storyNumber(index + 1)}
                </span>
                <span className="min-w-0 flex-1 truncate font-serif text-[1.0625rem] group-hover/row:underline">
                  {story.headline}
                </span>
                {note ? <span className="flex-none text-xs text-slate">{note}</span> : null}
              </a>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * The rest of the edition, in rank order and in different shapes: wide bands that alternate the
 * image's side, a row of three columns, then ranked rows. Each part appears only when the edition
 * has stories for it (see `planEdition`).
 */
function MoreStories({ plan }: { plan: EditionPlan<StoryCardDto> }) {
  // Story numbers continue across the parts: the lead is 01.
  const firstColumn = plan.bands.length + 2;
  const firstRanked = firstColumn + plan.columns.length;
  return (
    <section aria-labelledby="more-title" className="mt-20 md:mt-24">
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4 border-b border-hairline pb-5">
        <h2 id="more-title" className="masthead text-[clamp(2.875rem,1.6rem+4.6vw,5.5rem)]">
          More from this edition
        </h2>
        <p className="max-w-[28.75rem] text-[0.9375rem] leading-normal text-graphite">
          Recommended against our editorial standards, strongest first. A recommendation isn’t a
          fact-check: each story’s claims still need confirming.
        </p>
      </div>
      {plan.bands.length ? (
        <div className="mt-10 grid gap-14 md:gap-18">
          {plan.bands.map(({ story, side }, index) => (
            <FeatureStory key={story.id} story={story} n={index + 2} side={side} />
          ))}
        </div>
      ) : null}
      {plan.columns.length ? (
        <div className="mt-12 flex flex-wrap items-start gap-x-8 gap-y-10 sm:mt-16 sm:gap-y-14 md:mt-18 lg:flex-nowrap">
          {plan.columns.map(({ story, shape }, index) => (
            <ColumnStory key={story.id} story={story} n={firstColumn + index} shape={shape} />
          ))}
        </div>
      ) : null}
      {plan.ranked.length ? (
        <ol
          aria-label={`Stories ${firstRanked} to ${firstRanked + plan.ranked.length - 1}`}
          className="mt-16 border-t-2 border-ink md:mt-20"
        >
          {plan.ranked.map((story, index) => (
            <RankedStory key={story.id} story={story} n={firstRanked + index} />
          ))}
        </ol>
      ) : null}
    </section>
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

/**
 * How a story that wasn't recommended is marked: a neutral tag, except a story that needs
 * checking (amber) or couldn't be assessed (red), which say something an editor may act on.
 */
function ReviewedOutcome({ outcome }: { outcome: string }) {
  if (outcome === 'gate_hold' || outcome === 'evaluation_failed' || outcome === 'source_failed')
    return (
      <span
        className={cn(
          'inline-flex flex-none items-center gap-1.5 text-[0.78125rem] font-semibold whitespace-nowrap',
          outcome === 'gate_hold' ? 'text-amber' : 'text-oxide',
        )}
      >
        <span aria-hidden className="size-1.5 rounded-full bg-current" />
        {outcomeShort(outcome)}
      </span>
    );
  return (
    <span className="inline-flex h-6 flex-none items-center rounded-full border border-tag-line px-2.5 text-xs font-medium whitespace-nowrap text-graphite">
      {outcomeShort(outcome)}
    </span>
  );
}

function AlsoReviewed({ stories }: { stories: ReviewedStoryDto[] }) {
  return (
    <section
      id="also-reviewed"
      aria-labelledby="reviewed-title"
      className="mt-20 scroll-mt-28 md:mt-24"
    >
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-3 border-b-2 border-ink pb-4">
        <h2 id="reviewed-title" className="masthead text-[clamp(2.125rem,1.5rem+2.4vw,3.25rem)]">
          Also reviewed
        </h2>
        <p className="max-w-[30rem] text-[0.90625rem] leading-normal text-graphite">
          {countWord(stories.length)} {stories.length === 1 ? 'story' : 'stories'} assessed but not
          recommended, and why. We never lower the bar to fill an edition.
        </p>
      </div>
      <ul>
        {stories.map((story) => (
          <li
            key={story.id}
            className="flex flex-wrap items-center gap-x-7 gap-y-2 border-b border-hairline py-4 lg:grid lg:grid-cols-[minmax(0,1.25fr)_9.5rem_minmax(0,1fr)_2.5rem]"
          >
            <Link
              href={`/stories/${story.id}`}
              className="headline-link min-w-0 flex-[1_1_26rem] rounded-sm font-serif text-[1.1875rem] leading-snug text-ink"
            >
              {story.headline}
            </Link>
            <span className="lg:justify-self-start">
              <ReviewedOutcome outcome={story.outcome} />
            </span>
            <span className="min-w-0 flex-[1_1_18rem] text-sm text-graphite">{story.reason}</span>
            <span
              className={cn(
                'w-10 flex-none text-right',
                story.score === null ? 'text-sm text-slate' : 'masthead text-[1.375rem]',
              )}
            >
              {story.score ?? '—'}
              {story.score === null ? <span className="sr-only">No score</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function EditionSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading the edition">
      <div className="flex flex-wrap items-end justify-between gap-6 pt-4">
        <Skeleton className="h-24 w-3/5 max-w-160" />
        <div className="w-full max-w-104 space-y-2.5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-12 w-full" />
        </div>
      </div>
      <Skeleton className="mt-6 h-[clamp(27.5rem,42vw,38.75rem)] w-full rounded-[20px]" />
      <div className="mt-5 flex flex-wrap justify-between gap-6">
        <Skeleton className="h-16 w-full max-w-3xl" />
        <Skeleton className="h-12 w-72" />
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
