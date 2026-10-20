import {
  getDraftStatus,
  getResearchStatus,
  getStoryDetail,
  NotFoundError,
  type DraftStatusDto,
  type ResearchStatusDto,
  type StoryDetailDto,
} from '@repo/core';
import { REGIONS } from '@repo/shared';
import { ArrowDown, ArrowLeft, ArrowRight, TriangleAlert } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense, type ReactNode } from 'react';

import { Assessment, BAND } from '@/components/editorial/assessment';
import {
  CONFIDENCE,
  DECISION_ACTION,
  editionName,
  nextStep,
  outcomeLabel,
  outcomeTone,
  type Tone,
} from '@/components/editorial/copy';
import { DecisionButtons } from '@/components/editorial/decisions';
import {
  dimensionLabel,
  formatDate,
  formatDateTime,
  formatLabel,
  pillarLabel,
  placeLabel,
  subcategoryLabel,
  tagLabel,
} from '@/components/editorial/format';
import { NextAction, WorkflowSteps } from '@/components/editorial/next-step';
import { SourceList } from '@/components/editorial/sources';
import { storyNumber } from '@/components/editorial/story-card';
import { StoryImage } from '@/components/editorial/story-image';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { requirePageUser } from '@/lib/session';
import { cn } from '@/lib/utils';

export const metadata: Metadata = { title: 'Story' };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Optional parts the assessment left empty, named once instead of as empty sections. */
function notCovered(story: StoryDetailDto): string[] {
  return [
    !story.angle && 'an angle',
    !story.whyNow && 'why now',
    !story.formatPotential.length && 'ways to cover it',
    !story.verificationNeeds.length && 'open questions to check',
    !story.peopleToApproach.length && 'people to approach',
    !story.visualOpportunities.length && 'visual ideas',
  ].filter((item): item is string => Boolean(item));
}

const MIX: Record<string, [string, string]> = {
  primary: ['original source', 'original sources'],
  reputable_secondary: ['established publication', 'established publications'],
  specialist: ['specialist publication', 'specialist publications'],
  unverified_social: ['unverified social post', 'unverified social posts'],
  unknown: ['source not yet assessed', 'sources not yet assessed'],
};

/** "1 original source, 2 established publications": how far the sources can be relied on. */
function reliabilityMix(story: StoryDetailDto): string {
  const counts = new Map<string, number>();
  for (const { sourceQuality } of story.sources) {
    const key = sourceQuality in MIX ? sourceQuality : 'unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, n]) => plural(n, MIX[key]![0], MIX[key]![1])).join(', ');
}

function List({ items }: { items: string[] }) {
  return (
    <ul className="list-disc space-y-1 pl-5 font-serif text-[1.09375rem] leading-[1.55] text-ink marker:text-stone">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function GroupHeading({ children }: { children: ReactNode }) {
  return <h3 className="mb-2 text-[0.84375rem] font-semibold text-ink">{children}</h3>;
}

/** A numbered part of the story, in the masthead face. */
function SectionHeading({
  id,
  n,
  tone,
  className,
  children,
}: {
  id: string;
  n: number;
  tone?: 'attention';
  className?: string;
  children: ReactNode;
}) {
  return (
    <h2
      id={id}
      className={cn(
        'masthead flex items-baseline gap-3 text-2xl leading-none tracking-[0.02em]',
        className,
      )}
    >
      <span className={tone === 'attention' ? 'text-amber' : 'text-stone'}>{storyNumber(n)}</span>
      {children}
    </h2>
  );
}

interface Part {
  id: string;
  title: string;
  /** A count beside the rail entry. */
  count?: number;
  tone?: 'attention';
}

/** The parts this story has, in order and numbered: optional ones appear only with content. */
function partsOf(story: StoryDetailDto): Part[] {
  // Names in the reporting are listed under "At a glance".
  const hasPeople = story.peopleToApproach.length > 0 || story.culturalConnections.length > 0;
  const hasIdeas = story.formatPotential.length > 0 || story.visualOpportunities.length > 0;
  const parts: Array<Part | false> = [
    { id: 'what', title: 'What happened' },
    { id: 'why', title: story.whyNow ? 'Why it matters, why now' : 'Why it matters' },
    Boolean(story.angle) && { id: 'angle', title: 'Our angle' },
    story.verificationNeeds.length > 0 && {
      id: 'check',
      title: 'Before relying on this',
      count: story.verificationNeeds.length,
      tone: 'attention',
    },
    { id: 'sources', title: 'Sources', count: story.sources.length },
    hasPeople && {
      id: 'people',
      title: 'People and institutions',
      count: story.peopleToApproach.length || undefined,
    },
    hasIdeas && {
      id: 'ideas',
      title: 'Ways to develop it',
      count: story.formatPotential.length || undefined,
    },
    { id: 'assessment', title: 'Assessment and history' },
  ];
  return parts.filter((part): part is Part => Boolean(part));
}

/** How the outcome reads on the black scorecard: a semantic chip, never decoration. */
const ON_DARK: Record<Tone, string> = {
  done: 'bg-moss-wash text-moss',
  attention: 'bg-amber-wash text-amber',
  problem: 'bg-oxide-wash text-oxide',
  info: 'bg-white/15 text-white',
};

/** The assessment at a glance: total, band and each part's score. Detail waits in part 08. */
function Scorecard({ story }: { story: StoryDetailDto }) {
  const { total, band, confidence } = story.score;
  const tone = outcomeTone(story.outcome);
  return (
    <aside
      aria-label="Assessment at a glance"
      className="on-dark min-w-0 flex-[0_1_21.5rem] rounded-[16px] bg-ink px-5 pt-4.5 pb-4 text-white"
    >
      <div className="flex items-center justify-between gap-2.5">
        <span className="masthead text-sm tracking-[0.08em] text-white/70">Assessment</span>
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.78125rem] font-semibold',
            ON_DARK[tone],
          )}
        >
          <span aria-hidden className="size-1.5 rounded-full bg-current" />
          {outcomeLabel(story.outcome)}
        </span>
      </div>
      <div className="mt-3 flex items-end gap-3.5">
        <span className="masthead text-[4rem] leading-[0.8] tracking-[-0.02em] sm:text-[4.5rem]">
          {total ?? '—'}
        </span>
        <div className="pb-1">
          <p className="text-[0.8125rem] text-white/70">out of 100</p>
          <p className="mt-0.5 text-[0.9375rem] font-semibold">
            {band ? BAND[band] : 'Not scored yet'}
          </p>
          {confidence ? (
            <p className="mt-0.5 text-[0.8125rem] text-white/70">
              {CONFIDENCE[confidence] ?? confidence}
            </p>
          ) : null}
        </div>
      </div>
      {story.dimensions.length ? (
        <ul
          aria-label="Score by part"
          className="mt-4.5 grid gap-[7px] border-t border-white/15 pt-3.5"
        >
          {story.dimensions.map((d) => (
            <li
              key={d.dimension}
              className="grid grid-cols-[minmax(0,1fr)_5.75rem_1.375rem] items-center gap-2.5 text-[0.78125rem]"
            >
              <span className="truncate text-white/80">{dimensionLabel(d.dimension)}</span>
              <span aria-hidden className="h-1.5 overflow-hidden rounded-full bg-[#2c2c31]">
                <span
                  className="block h-full bg-white"
                  style={{ width: `${(Math.max(0, Math.min(5, d.score)) / 5) * 100}%` }}
                />
              </span>
              <span className="text-right font-semibold">
                {d.score}
                <span className="sr-only"> out of 5</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <a
        href="#assessment"
        className="text-link mt-3.5 inline-flex min-h-9 items-center gap-1.5 rounded-sm text-[0.84375rem] font-medium text-white"
      >
        How the score was built
        <ArrowDown className="size-3.5" aria-hidden />
      </a>
    </aside>
  );
}

/** The anchor rail: every part of the page, numbered, with counts where they help. */
function OnThisPage({ parts }: { parts: Part[] }) {
  return (
    <>
      <p className="masthead mb-2.5 text-sm tracking-[0.08em] text-slate">On this page</p>
      <ol className="border-t border-hairline">
        {parts.map((part, i) => (
          <li key={part.id} className="border-b border-hairline">
            <a
              href={`#${part.id}`}
              className="flex items-baseline gap-2.5 rounded-sm py-2.5 text-sm text-graphite hover:text-ink"
            >
              <span className="masthead text-sm text-slate">{storyNumber(i + 1)}</span>
              {part.title}
              {part.count ? (
                <span
                  className={cn(
                    'ml-auto text-xs',
                    part.tone === 'attention'
                      ? 'rounded-full bg-amber-wash px-2 font-semibold text-amber'
                      : 'text-slate',
                  )}
                >
                  {part.count}
                </span>
              ) : null}
            </a>
          </li>
        ))}
      </ol>
    </>
  );
}

/** Where, what about and who: the story's coordinates from the assessment. */
function AtAGlance({ story }: { story: StoryDetailDto }) {
  const facts: Array<[string, string]> = [
    [
      story.geography.length > 1 ? 'Places' : 'Place',
      story.geography
        .map((g) => `${g.city ? `${g.city}, ` : ''}${g.country} · ${REGIONS[g.region].label}`)
        .join('; '),
    ],
    ['Subjects', story.subcategories.map(subcategoryLabel).join(', ')],
    ['Themes', story.crossCuttingTags.map(tagLabel).join(', ')],
    ['Named in the reporting', story.entities.join(', ')],
  ];
  const shown = facts.filter(([, value]) => value);
  if (shown.length === 0) return null;
  return (
    <>
      <p className="masthead mb-2.5 text-sm tracking-[0.08em] text-slate">At a glance</p>
      <dl className="grid gap-3 text-[0.84375rem]">
        {shown.map(([label, value]) => (
          <div key={label}>
            <dt className="text-[0.78125rem] text-slate">{label}</dt>
            <dd className="mt-0.5 text-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

const RESEARCH_STATE: Record<ResearchStatusDto['state'], { label: string; tone: string }> = {
  none: { label: 'Not started', tone: 'text-slate' },
  running: { label: 'In progress', tone: 'text-ink' },
  ready: { label: 'Researched', tone: 'text-moss' },
  failed: { label: 'Didn’t finish', tone: 'text-amber' },
};

/** The decision panel: where the story is, the one next action, then save and skip. */
function NextStepPanel({
  story,
  research,
  drafts,
}: {
  story: StoryDetailDto;
  research: ResearchStatusDto;
  drafts: DraftStatusDto;
}) {
  const step = nextStep(story.recommendedAction);
  const checks = story.verificationNeeds.length;
  const state = RESEARCH_STATE[research.state];
  return (
    <div className="flex flex-col gap-3.5">
      <section
        aria-labelledby="next-step-title"
        className="rounded-[18px] border border-hairline bg-ivory p-5 shadow-float sm:px-5.5 sm:pt-5.5"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 id="next-step-title" className="masthead text-[1.375rem] tracking-[0.02em]">
            Next step
          </h2>
          {step ? <p className="meta text-[0.78125rem]">Suggested: {step.toLowerCase()}</p> : null}
        </div>
        <div className="mt-4.5">
          <WorkflowSteps storyId={story.id} research={research} drafts={drafts} />
        </div>
        <div className="mt-5">
          <NextAction storyId={story.id} research={research} drafts={drafts} />
        </div>
        <div className="mt-4.5 border-t border-hairline-soft pt-4">
          <DecisionButtons storyId={story.id} state={story.editorialState} />
        </div>
      </section>
      {checks ? (
        <a
          href="#check"
          className="flex items-center gap-2.5 rounded-[14px] bg-amber-wash px-4 py-3.5 text-sm font-medium text-ink hover:underline"
        >
          <TriangleAlert className="size-4 shrink-0 text-amber" aria-hidden />
          {plural(checks, 'thing', 'things')} to check before relying on this
        </a>
      ) : null}
      <section
        aria-labelledby="research-so-far-title"
        className="rounded-[14px] bg-bone px-4.5 py-4"
      >
        <div className="flex items-center justify-between gap-2">
          <h2 id="research-so-far-title" className="masthead text-[1.0625rem] tracking-[0.03em]">
            Research so far
          </h2>
          <span
            className={cn(
              'inline-flex items-center gap-1.5 text-[0.78125rem] font-semibold',
              state.tone,
            )}
          >
            <span aria-hidden className="size-1.5 rounded-full bg-current" />
            {state.label}
          </span>
        </div>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1.5 text-[0.84375rem]">
          <dt className="text-slate">Briefings</dt>
          <dd>{research.briefs}</dd>
          <dt className="text-slate">Questions</dt>
          <dd>{research.questions}</dd>
          <dt className="text-slate">Drafts</dt>
          <dd>
            {drafts.writing
              ? 'Writing one now'
              : drafts.versions
                ? `${plural(drafts.versions, 'version', 'versions')} in ${plural(drafts.formats, 'format', 'formats')}`
                : 'None yet'}
          </dd>
        </dl>
        <Link
          href={`/stories/${story.id}/research`}
          className="text-link mt-3 inline-flex min-h-9 items-center gap-1.5 rounded-sm text-[0.84375rem] font-semibold"
        >
          Open the research
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </section>
    </div>
  );
}

function Dossier({
  story,
  research,
  drafts,
}: {
  story: StoryDetailDto;
  research: ResearchStatusDto;
  drafts: DraftStatusDto;
}) {
  const pillar = pillarLabel(story.primaryPillar);
  const place = placeLabel(story.geography);
  const missing = notCovered(story);
  const parts = partsOf(story);
  const n = (id: string) => parts.findIndex((part) => part.id === id) + 1;
  const latestRecommendation = story.recommendations.reduce<
    StoryDetailDto['recommendations'][number] | null
  >((latest, r) => (!latest || r.at > latest.at ? r : latest), null);

  return (
    <article aria-labelledby="story-title" className="fade-in">
      <Link
        href="/"
        className="inline-flex min-h-10 items-center gap-2 rounded-sm text-sm font-medium text-graphite transition-colors hover:text-ink"
      >
        <ArrowLeft className="size-4" aria-hidden /> Today’s edition
      </Link>

      <header className="flex flex-wrap items-end gap-x-14 gap-y-8 border-b-2 border-ink pt-4 pb-10">
        <div className="min-w-0 flex-[1_1_40rem]">
          <div className="flex flex-wrap items-center gap-2.5">
            <Badge>{pillar}</Badge>
            {place ? <span className="text-sm font-medium text-ink">{place}</span> : null}
            {story.relation === 'new_development' ? (
              <Badge variant="ink">New development</Badge>
            ) : null}
            {story.relation === 'same_development_new_info' ? (
              <Badge variant="ink">Updated reporting</Badge>
            ) : null}
          </div>
          <h1
            id="story-title"
            className="mt-4.5 max-w-[24ch] font-serif text-[clamp(2.125rem,1.3rem+2.6vw,3.75rem)] leading-[1.02] font-medium tracking-[-0.018em] text-balance"
          >
            {story.headline}
          </h1>
          {story.summary ? (
            <p className="mt-5 max-w-[62ch] font-serif text-[1.1875rem] leading-normal text-graphite sm:text-[1.3125rem]">
              {story.summary}
            </p>
          ) : null}
          <p className="meta mt-4 text-[0.84375rem]">
            {[
              plural(story.sourceCount, 'source', 'sources'),
              story.createdAt ? `first seen ${formatDate(story.createdAt)}` : null,
              latestRecommendation
                ? `recommended in the ${editionName(latestRecommendation.runKey).replace(/^Edition/, 'edition')}`
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <Scorecard story={story} />
      </header>

      <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_20.625rem] xl:grid-cols-[15rem_minmax(0,1fr)_20.625rem]">
        {/* First on phones; a sticky panel beside the story on wider screens. */}
        <aside
          aria-label="Next step"
          className="lg:sticky lg:top-28 lg:col-start-2 lg:row-start-1 lg:self-start xl:col-start-3"
        >
          <NextStepPanel story={story} research={research} drafts={drafts} />
        </aside>

        <nav
          aria-label="On this page"
          className="hidden xl:sticky xl:top-28 xl:col-start-1 xl:row-start-1 xl:block xl:self-start"
        >
          <OnThisPage parts={parts} />
          <div className="mt-7">
            <AtAGlance story={story} />
          </div>
        </nav>

        <div className="flex min-w-0 flex-col gap-11 lg:col-start-1 lg:row-start-1 xl:col-start-2">
          <StoryImage image={story.image} pillar={pillar} ratio="video" fallback="none" />

          <section id="what" aria-labelledby="what-title" className="scroll-mt-28">
            <SectionHeading id="what-title" n={n('what')} className="mb-3.5">
              What happened
            </SectionHeading>
            <p className="max-w-[66ch] font-serif text-lg leading-[1.65] sm:text-xl">
              {story.whatHappened || 'Not summarised yet.'}
            </p>
            <p className="meta mt-3">
              As reported in{' '}
              <a href="#sources" className="text-link text-ink">
                this story’s sources
              </a>
              , not yet checked by the newsroom.
            </p>
          </section>

          <section
            id="why"
            aria-labelledby="why-title"
            className="flex scroll-mt-28 flex-wrap gap-x-10 gap-y-7"
          >
            <div className="min-w-0 flex-[2_1_21rem]">
              <SectionHeading id="why-title" n={n('why')} className="mb-3.5">
                Why it matters
              </SectionHeading>
              {story.whyItMatters ? (
                <p className="font-serif text-lg leading-[1.6] sm:text-xl">{story.whyItMatters}</p>
              ) : null}
              <p className="mt-3 font-serif text-[1.0625rem] leading-[1.6] text-graphite italic sm:text-lg">
                {story.editorialTest.canAnswer
                  ? story.editorialTest.answer
                  : 'We couldn’t yet say clearly why this matters to our readers.'}
              </p>
            </div>
            {story.whyNow ? (
              <div className="min-w-0 flex-[1_1_12.5rem] border-t-2 border-ink pt-3">
                <h3 className="masthead text-lg tracking-[0.03em]">Why now</h3>
                <p className="mt-2 font-serif text-lg leading-normal sm:text-[1.1875rem]">
                  {story.whyNow}
                </p>
              </div>
            ) : null}
          </section>

          {story.angle ? (
            <section
              id="angle"
              aria-labelledby="angle-title"
              className="scroll-mt-28 border-t-4 border-ink pt-4.5"
            >
              <SectionHeading id="angle-title" n={n('angle')} className="mb-3.5">
                Our angle
              </SectionHeading>
              <p className="max-w-[22ch] font-serif text-[clamp(1.75rem,1.3rem+1.4vw,2.75rem)] leading-[1.1] font-medium tracking-[-0.014em] italic">
                {story.angle}
              </p>
            </section>
          ) : null}

          {story.verificationNeeds.length ? (
            <section
              id="check"
              aria-labelledby="check-title"
              className="scroll-mt-28 rounded-2xl bg-amber-soft px-5 py-5.5 sm:px-6"
            >
              <SectionHeading id="check-title" n={n('check')} tone="attention">
                Before relying on this, check
              </SectionHeading>
              <ul className="mt-3.5 grid gap-2.5">
                {story.verificationNeeds.map((item) => (
                  <li
                    key={item}
                    className="flex gap-3 font-serif text-lg leading-[1.45] sm:text-[1.1875rem]"
                  >
                    <TriangleAlert className="mt-1 size-4 shrink-0 text-amber" aria-hidden />
                    {item}
                  </li>
                ))}
              </ul>
              <p className="mt-3.5 text-[0.8125rem] text-[#5e4300]">
                Not yet verified by the newsroom.
              </p>
            </section>
          ) : null}

          <section id="sources" aria-labelledby="sources-title" className="scroll-mt-28">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
              <SectionHeading id="sources-title" n={n('sources')}>
                Sources and verification
              </SectionHeading>
              {story.sources.length ? <span className="meta">{reliabilityMix(story)}</span> : null}
            </div>
            <SourceList sources={story.sources} />
            <p className="meta mt-3 max-w-[70ch]">
              Links, publishers and dates come from our records of each article, never from the AI.
            </p>
          </section>

          {parts.some((part) => part.id === 'people') ? (
            <section id="people" aria-labelledby="people-title" className="scroll-mt-28">
              <SectionHeading id="people-title" n={n('people')} className="mb-3.5">
                People and institutions
              </SectionHeading>
              {story.peopleToApproach.length ? (
                <>
                  <ul className="grid grid-cols-[repeat(auto-fit,minmax(min(15rem,100%),1fr))] gap-3.5">
                    {story.peopleToApproach.map((p) => (
                      <li
                        key={`${p.name}-${p.role}`}
                        className="rounded-[14px] border border-hairline px-4.5 py-4"
                      >
                        <p className="font-semibold text-ink">{p.name}</p>
                        <p className="mt-0.5 text-sm text-graphite">{p.role}</p>
                        <p className="meta mt-2.5 text-[0.78125rem]">Mentioned in: {p.basis}</p>
                      </li>
                    ))}
                  </ul>
                  <p className="meta mt-3">
                    Leads named in the sources. We haven’t confirmed access to anyone.
                  </p>
                </>
              ) : null}
              <div className="mt-5.5 grid grid-cols-[repeat(auto-fit,minmax(min(16.25rem,100%),1fr))] gap-x-8 gap-y-5 empty:hidden">
                {story.culturalConnections.length ? (
                  <div>
                    <GroupHeading>Cultural connections</GroupHeading>
                    <List items={story.culturalConnections} />
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}

          {parts.some((part) => part.id === 'ideas') ? (
            <section id="ideas" aria-labelledby="ideas-title" className="scroll-mt-28">
              <SectionHeading id="ideas-title" n={n('ideas')} className="mb-3.5">
                Ways to develop it
              </SectionHeading>
              {story.formatPotential.length ? (
                <ul className="grid grid-cols-[repeat(auto-fit,minmax(min(12.5rem,100%),1fr))] gap-3">
                  {story.formatPotential.map((f) => (
                    <li key={f.format} className="rounded-[14px] bg-bone px-4.5 py-4">
                      <p className="masthead text-xl tracking-[0.02em]">{formatLabel(f.format)}</p>
                      <p className="mt-1.5 font-serif text-[1.03125rem] leading-normal text-graphite">
                        {f.rationale}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : null}
              {story.visualOpportunities.length ? (
                <div className="mt-5.5">
                  <GroupHeading>Visual possibilities</GroupHeading>
                  <List items={story.visualOpportunities} />
                  <p className="meta mt-2">
                    Ideas only. Rights to any image or footage haven’t been cleared.
                  </p>
                </div>
              ) : null}
            </section>
          ) : null}

          {/* Below the widest layout the rail is hidden, so its facts sit here instead. */}
          <div className="xl:hidden">
            <AtAGlance story={story} />
          </div>

          <section
            id="assessment"
            aria-labelledby="assessment-title"
            className="scroll-mt-28 border-t-2 border-ink pt-4.5"
          >
            <SectionHeading id="assessment-title" n={n('assessment')} className="mb-4">
              Assessment and history
            </SectionHeading>
            <div className="grid gap-10">
              <Assessment story={story} summary={false} />
              <div className="grid grid-cols-[repeat(auto-fit,minmax(min(17.5rem,100%),1fr))] gap-x-10 gap-y-6">
                <div>
                  <GroupHeading>History</GroupHeading>
                  <ul className="grid gap-3 text-[0.9375rem] text-ink">
                    {story.recommendations.map((r) => (
                      <li key={r.runKey}>
                        Recommended in the {editionName(r.runKey).replace(/^Edition/, 'edition')}
                        {r.isUpdate ? ', as an update' : ''}
                        <span className="meta block">Ranked {r.rank}</span>
                      </li>
                    ))}
                    {story.decisions.map((d, i) => (
                      <li key={`${d.at}-${i}`}>
                        {DECISION_ACTION[d.action] ?? d.action} by {d.userName}
                        <span className="meta block">{formatDateTime(d.at)}</span>
                        {d.reason ? (
                          <span className="block font-serif text-graphite italic">
                            “{d.reason}”
                          </span>
                        ) : null}
                      </li>
                    ))}
                    {story.recommendations.length === 0 && story.decisions.length === 0 ? (
                      <li className="meta">Not recommended or decided on yet.</li>
                    ) : null}
                  </ul>
                </div>
                {story.parent || story.developments.length ? (
                  <div>
                    <GroupHeading>Related stories</GroupHeading>
                    <ul className="grid gap-3 text-[0.9375rem]">
                      {story.parent ? (
                        <li>
                          <span className="meta block">This follows</span>
                          <Link
                            href={`/stories/${story.parent.id}`}
                            className="headline-link font-serif text-[1.0625rem] text-ink"
                          >
                            {story.parent.headline}
                          </Link>
                          {story.parent.editorialState === 'skipped' ? (
                            <span className="meta block">An editor skipped that story.</span>
                          ) : null}
                        </li>
                      ) : null}
                      {story.developments.map((d) => (
                        <li key={d.id}>
                          <span className="meta block">Later development</span>
                          <Link
                            href={`/stories/${d.id}`}
                            className="headline-link font-serif text-[1.0625rem] text-ink"
                          >
                            {d.headline}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
              {missing.length ? (
                <p className="meta">
                  Not covered in this assessment: {missing.join(', ')}. That means nothing was
                  suggested, not that it was checked.
                </p>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    </article>
  );
}

async function Story({ params }: Pick<PageProps<'/stories/[id]'>, 'params'>) {
  await requirePageUser();
  const { id } = await params;
  const [story, research, drafts] = await Promise.all([
    getStoryDetail(id),
    getResearchStatus(id),
    getDraftStatus(id),
  ]).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  return <Dossier story={story} research={research} drafts={drafts} />;
}

export default function StoryPage({ params }: PageProps<'/stories/[id]'>) {
  return (
    <Suspense
      fallback={
        <div className="space-y-5" aria-busy="true" aria-label="Loading the story">
          <Skeleton className="h-4 w-28" />
          <div className="flex flex-wrap items-end gap-10 border-b-2 border-hairline pb-10">
            <div className="min-w-0 flex-[1_1_40rem] space-y-4">
              <Skeleton className="h-6 w-56" />
              <Skeleton className="h-28 w-full max-w-3xl" />
              <Skeleton className="h-12 w-full max-w-2xl" />
            </div>
            <Skeleton className="h-72 w-full max-w-[25rem] rounded-[18px]" />
          </div>
          <div className="grid gap-10 pt-6 lg:grid-cols-[minmax(0,1fr)_20.625rem]">
            <Skeleton className="aspect-video" />
            <Skeleton className="h-96 rounded-[18px]" />
          </div>
        </div>
      }
    >
      <Story params={params} />
    </Suspense>
  );
}
