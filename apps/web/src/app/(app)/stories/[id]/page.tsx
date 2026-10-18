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
import { ArrowLeft, TriangleAlert } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense, type ReactNode } from 'react';

import { Assessment } from '@/components/editorial/assessment';
import {
  DECISION_ACTION,
  editionName,
  nextStep,
  outcomeLabel,
  outcomeTone,
} from '@/components/editorial/copy';
import { DecisionButtons } from '@/components/editorial/decisions';
import {
  formatDate,
  formatDateTime,
  formatLabel,
  pillarLabel,
  placeLabel,
  subcategoryLabel,
  tagLabel,
} from '@/components/editorial/format';
import { NextAction, WorkflowSteps } from '@/components/editorial/next-step';
import {
  Disclosure,
  Fact,
  MetaLine,
  Prose,
  PullQuote,
  StatusLabel,
} from '@/components/editorial/primitives';
import { SourceList } from '@/components/editorial/sources';
import { StoryImage } from '@/components/editorial/story-image';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { requirePageUser } from '@/lib/session';

export const metadata: Metadata = { title: 'Story' };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One part of the overview: a quiet serif heading and its reading text. */
function Part({ title, children, note }: { title: string; children: ReactNode; note?: ReactNode }) {
  const id = `part-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="mb-3 font-display text-[1.625rem] leading-tight text-ink">
        {title}
      </h2>
      {children}
      {note ? <p className="meta mt-3">{note}</p> : null}
    </section>
  );
}

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
    <ul className="prose-editorial list-disc space-y-2 pl-5 marker:text-ochre">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function GroupHeading({ children }: { children: ReactNode }) {
  return <h3 className="mb-3 text-sm font-semibold text-ink">{children}</h3>;
}

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
  return (
    <section aria-label="Next step" className="surface p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <StatusLabel tone={outcomeTone(story.outcome)}>{outcomeLabel(story.outcome)}</StatusLabel>
        {step ? <p className="meta">Suggested: {step.toLowerCase()}</p> : null}
      </div>
      <div className="mt-6">
        <WorkflowSteps storyId={story.id} research={research} drafts={drafts} />
      </div>
      <div className="mt-6">
        <NextAction storyId={story.id} research={research} drafts={drafts} />
      </div>
      <div className="mt-5 border-t border-hairline-soft pt-4">
        <DecisionButtons storyId={story.id} state={story.editorialState} />
      </div>
      {checks ? (
        <a
          href="#things-to-check"
          className="mt-4 flex items-center gap-2 rounded-md text-sm text-ink hover:underline"
        >
          <TriangleAlert className="size-4 shrink-0 text-amber" aria-hidden />
          {plural(checks, 'thing', 'things')} to check before relying on this
        </a>
      ) : null}
    </section>
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
  const hasPeople =
    story.peopleToApproach.length > 0 ||
    story.entities.length > 0 ||
    story.culturalConnections.length > 0;
  const hasIdeas = story.formatPotential.length > 0 || story.visualOpportunities.length > 0;

  return (
    <article aria-labelledby="story-title" className="fade-in">
      <Link
        href="/"
        className="meta mb-8 inline-flex items-center gap-1.5 rounded-sm transition-colors hover:text-ink"
      >
        <ArrowLeft className="size-4" aria-hidden /> Today’s edition
      </Link>

      <header className="max-w-[62rem]">
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <p className="eyebrow">{[pillar, place].filter(Boolean).join(' · ')}</p>
          {story.relation === 'new_development' ? (
            <Badge variant="ochre">New development</Badge>
          ) : null}
          {story.relation === 'same_development_new_info' ? (
            <Badge variant="warning">Updated reporting</Badge>
          ) : null}
        </div>
        <h1 id="story-title" className="display-lg">
          {story.headline}
        </h1>
        {story.summary ? <p className="standfirst mt-6 max-w-[60ch]">{story.summary}</p> : null}
        <MetaLine
          className="mt-5"
          items={[
            plural(story.sourceCount, 'source', 'sources'),
            story.createdAt ? `First seen ${formatDate(story.createdAt)}` : null,
          ]}
        />
      </header>

      <div className="mt-10 grid gap-12 lg:mt-14 lg:grid-cols-12 lg:gap-x-14">
        {/* First in reading order on phones; a sticky panel beside the story on desktop. */}
        <aside className="lg:col-span-4 lg:col-start-9 lg:row-start-1">
          <div className="lg:sticky lg:top-28">
            <NextStepPanel story={story} research={research} drafts={drafts} />
          </div>
        </aside>

        <div className="min-w-0 space-y-12 lg:col-span-8 lg:col-start-1 lg:row-start-1">
          <StoryImage image={story.image} pillar={pillar} ratio="wide" />

          <Part
            title="What happened"
            note={
              <>
                As reported in{' '}
                <a href="#sources" className="underline decoration-hairline hover:decoration-ochre">
                  this story’s sources
                </a>
                .
              </>
            }
          >
            <Prose>
              <p>{story.whatHappened || 'Not summarised yet.'}</p>
            </Prose>
          </Part>

          <Part title="Why it matters">
            <Prose>
              {story.whyItMatters ? <p>{story.whyItMatters}</p> : null}
              <p className="text-graphite italic">
                {story.editorialTest.canAnswer
                  ? story.editorialTest.answer
                  : 'We couldn’t yet say clearly why this matters to our readers.'}
              </p>
            </Prose>
          </Part>

          {story.whyNow ? (
            <Part title="Why now">
              <Prose>
                <p>{story.whyNow}</p>
              </Prose>
            </Part>
          ) : null}

          {story.angle ? (
            <Part title="Our angle">
              <PullQuote>{story.angle}</PullQuote>
            </Part>
          ) : null}

          {story.verificationNeeds.length ? (
            <section
              id="things-to-check"
              aria-labelledby="things-to-check-title"
              className="scroll-mt-28 rounded-lg bg-amber-wash/60 px-5 py-5 sm:px-6"
            >
              <h2
                id="things-to-check-title"
                className="flex items-center gap-2 text-[0.9375rem] font-semibold text-ink"
              >
                <TriangleAlert className="size-4 text-amber" aria-hidden />
                Before relying on this, check
              </h2>
              <ul className="mt-3 grid gap-2 pl-6 font-serif text-[1.0625rem] leading-relaxed text-ink">
                {story.verificationNeeds.map((item) => (
                  <li key={item} className="list-disc marker:text-amber">
                    {item}
                  </li>
                ))}
              </ul>
              <p className="meta mt-3">Not yet verified by the newsroom.</p>
            </section>
          ) : null}

          <div className="grid gap-3">
            <Disclosure
              variant="card"
              id="sources"
              summary={`Sources and verification (${story.sources.length})`}
              hint={reliabilityMix(story)}
            >
              <SourceList sources={story.sources} />
              <p className="meta mt-4">
                Links, publishers and dates come from our records of each article, never from the
                AI. How each source can be relied on is shown under it.
              </p>
            </Disclosure>

            {hasPeople ? (
              <Disclosure
                variant="card"
                summary="People and institutions"
                hint={
                  story.peopleToApproach.length
                    ? `${plural(story.peopleToApproach.length, 'person', 'people')} to approach`
                    : undefined
                }
              >
                <div className="grid gap-8">
                  {story.peopleToApproach.length ? (
                    <div>
                      <GroupHeading>People who could help</GroupHeading>
                      <ul className="grid gap-4 sm:grid-cols-2">
                        {story.peopleToApproach.map((p) => (
                          <li key={`${p.name}-${p.role}`}>
                            <p className="font-medium text-ink">{p.name}</p>
                            <p className="text-graphite">{p.role}</p>
                            <p className="meta mt-1">Mentioned in: {p.basis}</p>
                          </li>
                        ))}
                      </ul>
                      <p className="meta mt-3">
                        Leads named in the sources. We haven’t confirmed access to anyone.
                      </p>
                    </div>
                  ) : null}
                  {story.entities.length ? (
                    <div>
                      <GroupHeading>Named in the reporting</GroupHeading>
                      <p className="text-[0.9375rem] leading-relaxed text-ink">
                        {story.entities.join(' · ')}
                      </p>
                    </div>
                  ) : null}
                  {story.culturalConnections.length ? (
                    <div>
                      <GroupHeading>Cultural connections</GroupHeading>
                      <List items={story.culturalConnections} />
                    </div>
                  ) : null}
                </div>
              </Disclosure>
            ) : null}

            {hasIdeas ? (
              <Disclosure
                variant="card"
                summary="Ideas for developing the story"
                hint={
                  story.formatPotential.length
                    ? `${plural(story.formatPotential.length, 'format', 'formats')} suggested`
                    : undefined
                }
              >
                <div className="grid gap-8">
                  {story.formatPotential.length ? (
                    <div>
                      <GroupHeading>Ways we could cover it</GroupHeading>
                      <ul className="grid gap-4 sm:grid-cols-2">
                        {story.formatPotential.map((f) => (
                          <li key={f.format} className="border-l-2 border-ochre/50 pl-4">
                            <p className="font-medium text-ink">{formatLabel(f.format)}</p>
                            <p className="mt-1 font-serif leading-relaxed text-graphite">
                              {f.rationale}
                            </p>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {story.visualOpportunities.length ? (
                    <div>
                      <GroupHeading>Visual possibilities</GroupHeading>
                      <List items={story.visualOpportunities} />
                      <p className="meta mt-3">
                        Ideas only. Rights to any image or footage haven’t been cleared.
                      </p>
                    </div>
                  ) : null}
                </div>
              </Disclosure>
            ) : null}

            <Disclosure
              variant="card"
              summary="Background and context"
              hint={
                story.parent || story.developments.length ? 'Includes related stories' : undefined
              }
            >
              <div className="grid gap-8">
                <dl className="grid gap-4 sm:grid-cols-2">
                  {story.geography.length ? (
                    <Fact label="Places">
                      {story.geography
                        .map(
                          (g) =>
                            `${g.city ? `${g.city}, ` : ''}${g.country} (${REGIONS[g.region].label})`,
                        )
                        .join('; ')}
                    </Fact>
                  ) : null}
                  {story.subcategories.length ? (
                    <Fact label="Subjects">
                      {story.subcategories.map(subcategoryLabel).join(', ')}
                    </Fact>
                  ) : null}
                  {story.crossCuttingTags.length ? (
                    <Fact label="Themes">{story.crossCuttingTags.map(tagLabel).join(', ')}</Fact>
                  ) : null}
                </dl>
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
            </Disclosure>

            <Disclosure
              variant="card"
              summary="Assessment and history"
              hint={
                story.score.total !== null
                  ? `Scored ${story.score.total} / 100 · decisions and editions`
                  : 'Decisions and editions'
              }
            >
              <div className="grid gap-10">
                <Assessment story={story} />
                <div>
                  <GroupHeading>History</GroupHeading>
                  <ul className="grid gap-3 text-[0.9375rem] text-ink">
                    {story.recommendations.map((r) => (
                      <li key={r.runKey}>
                        Recommended in the {editionName(r.runKey).replace(/^Edition/, 'edition')}
                        {r.isUpdate ? ', as an update' : ''}
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
                {missing.length ? (
                  <p className="meta">
                    Not covered in this assessment: {missing.join(', ')}. That means nothing was
                    suggested, not that it was checked.
                  </p>
                ) : null}
              </div>
            </Disclosure>
          </div>
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
          <Skeleton className="h-16 w-3/4" />
          <Skeleton className="h-6 w-1/2" />
          <div className="grid gap-12 pt-6 lg:grid-cols-12">
            <Skeleton className="aspect-[3/2] lg:col-span-8" />
            <Skeleton className="h-80 lg:col-span-4" />
          </div>
        </div>
      }
    >
      <Story params={params} />
    </Suspense>
  );
}
