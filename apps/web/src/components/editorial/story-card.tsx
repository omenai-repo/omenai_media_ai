import type { StoryCardDto } from '@repo/core';
import { ArrowRight, Clock } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { DecisionButtons } from './decisions';
import { pillarLabel, pillarShort, placeLabel } from './format';
import { MetaLine } from './primitives';
import {
  HeroImage,
  IfImage,
  IfNoImage,
  ImageCredit,
  ImageScope,
  MotifTile,
  StoryImage,
} from './story-image';

/** "07": a story's position in the edition, in the masthead face. */
export const storyNumber = (n: number) => String(n).padStart(2, '0');

/** The anchor of a story on the edition page (the contents list and subject index link here). */
export const storyAnchor = (id: string) => `s-${id}`;

/** The flag worth a stronger line: a new development, or an update on an earlier story. */
function Flag({ story, dark = false }: { story: StoryCardDto; dark?: boolean }) {
  const label = story.isUpdate
    ? 'Update on an earlier story'
    : story.relation === 'new_development'
      ? 'New development'
      : null;
  if (!label) return null;
  return <Badge variant={dark ? 'dark' : 'ink'}>{label}</Badge>;
}

/** Time pressure is the one flag shown in colour: it changes what an editor does today. */
function TimeSensitive({ story }: { story: StoryCardDto }) {
  if (story.timeliness !== 'urgent') return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-[0.8125rem] font-semibold text-amber">
      <Clock className="size-3.5" aria-hidden />
      Time-sensitive
    </span>
  );
}

/** The subject as a neutral tag, then the place. */
function SubjectLine({ story, className }: { story: StoryCardDto; className?: string }) {
  const place = placeLabel(story.geography);
  return (
    <div className={cn('flex flex-wrap items-center gap-x-2.5 gap-y-2', className)}>
      {/* On a phone the subject's one-word name, so the tag never wraps; the full name is kept. */}
      <Badge title={pillarLabel(story.primaryPillar)}>
        {story.primaryPillar ? (
          <>
            <span className="min-w-0 truncate max-sm:hidden">
              {pillarLabel(story.primaryPillar)}
            </span>
            <span className="sm:hidden" aria-hidden>
              {pillarShort(story.primaryPillar)}
            </span>
            <span className="sr-only sm:hidden">{pillarLabel(story.primaryPillar)}</span>
          </>
        ) : (
          pillarLabel(null)
        )}
      </Badge>
      {place ? <span className="text-[0.84375rem] font-medium text-ink">{place}</span> : null}
    </div>
  );
}

function Headline({
  story,
  as: Tag = 'h3',
  className,
}: {
  story: StoryCardDto;
  as?: 'h2' | 'h3';
  className: string;
}) {
  return (
    <Tag id={`story-${story.id}`} className={cn('text-balance', className)}>
      <Link href={`/stories/${story.id}`} className="headline-link rounded-sm">
        {story.headline}
      </Link>
    </Tag>
  );
}

/** Open the story (the card's main action) and research it, as text links. */
function StoryLinks({ story, className }: { story: StoryCardDto; className?: string }) {
  const describedBy = `story-${story.id}`;
  return (
    <div className={cn('flex flex-wrap items-center gap-x-5', className)}>
      <Link
        href={`/stories/${story.id}`}
        aria-describedby={describedBy}
        className="group/open inline-flex min-h-11 items-center gap-1.5 rounded-sm text-sm font-semibold text-ink"
      >
        Open story
        <ArrowRight
          className="size-4 transition-transform group-hover/open:translate-x-0.5"
          aria-hidden
        />
      </Link>
      <Link
        href={`/stories/${story.id}/research`}
        aria-describedby={describedBy}
        className="inline-flex min-h-11 items-center rounded-sm text-sm font-medium text-graphite hover:text-ink"
      >
        Research
      </Link>
    </div>
  );
}

/** A white numbered tag over the corner of an image. */
function NumberTag({ n }: { n: number }) {
  return (
    <span className="masthead absolute top-3.5 left-3.5 rounded-full bg-white px-2.5 pt-1.5 pb-[5px] text-lg leading-none text-ink">
      {storyNumber(n)}
    </span>
  );
}

/**
 * The edition's lead: the image (or, with none, a drawn black cover) at full width with the
 * headline over its lower edge, then the context, the lead's state and its actions. "Review
 * story" is the screen's one signal-yellow action.
 */
export function LeadStory({ story, status }: { story: StoryCardDto; status: string[] }) {
  const pillar = pillarLabel(story.primaryPillar);
  const place = placeLabel(story.geography);
  return (
    <article
      id={storyAnchor(story.id)}
      aria-labelledby={`story-${story.id}`}
      className="scroll-mt-28"
    >
      <ImageScope>
        <HeroImage image={story.image} pillar={pillar}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="dark">{pillar}</Badge>
            <Flag story={story} dark />
          </div>
          <Headline
            story={story}
            as="h2"
            className="mt-3 font-serif text-[clamp(1.625rem,0.9rem+3vw,3.375rem)] leading-[1.04] font-medium tracking-[-0.016em] text-white sm:mt-3.5"
          />
        </HeroImage>
        <div className="mt-5 flex flex-wrap items-start justify-between gap-x-12 gap-y-5">
          <div className="max-w-[48.75rem] min-w-0 flex-[1_1_30rem]">
            {story.summary ? (
              <p className="font-serif text-[1.0625rem] leading-[1.55] text-graphite sm:text-[1.1875rem]">
                {story.summary}
              </p>
            ) : null}
            <MetaLine
              className="mt-2.5 text-[0.78125rem]"
              items={[place || null, <ImageCredit key="credit" image={story.image} />]}
            />
          </div>
          <div className="flex flex-col items-start gap-3.5 lg:items-end">
            {/* Separators trail each item, so a wrapped line never starts with one. */}
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[0.84375rem] text-graphite lg:justify-end">
              <span aria-hidden className="size-[7px] rounded-full bg-moss" />
              {['Recommended', ...status].map((item, i, all) => (
                <span
                  key={item}
                  className={cn('whitespace-nowrap', i === 0 && 'font-semibold text-ink')}
                >
                  {item}
                  {i < all.length - 1 ? ' ·' : ''}
                </span>
              ))}
              <TimeSensitive story={story} />
            </p>
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              <Button
                asChild
                variant="signal"
                className="h-12 w-full justify-between gap-3 pr-1.5 pl-5 text-[0.9375rem] sm:w-auto"
              >
                <Link href={`/stories/${story.id}`} aria-describedby={`story-${story.id}`}>
                  Review story
                  <span className="inline-flex size-[38px] items-center justify-center rounded-full bg-ink text-white">
                    <ArrowRight aria-hidden />
                  </span>
                </Link>
              </Button>
              <Button asChild variant="outline" className="h-12 px-5 font-medium">
                <Link href={`/stories/${story.id}/research`} aria-describedby={`story-${story.id}`}>
                  Research
                </Link>
              </Button>
              <DecisionButtons
                storyId={story.id}
                state={story.editorialState}
                appearance="icons"
                size="lg"
              />
            </div>
          </div>
        </div>
      </ImageScope>
    </article>
  );
}

/**
 * A secondary story as a wide band: its image beside the headline and why it matters, or, with no
 * image (or one that won't load), a wash panel with the subject's motif and the angle as a pull
 * quote. Bands alternate the image's side down the page (`side`); on narrow screens the image
 * always comes first. The image area has a set size whatever the source's proportions.
 */
export function FeatureStory({
  story,
  n,
  side = 'left',
}: {
  story: StoryCardDto;
  n: number;
  side?: 'left' | 'right';
}) {
  const pillar = pillarLabel(story.primaryPillar);
  const skipped = story.editorialState === 'skipped';
  const panel = (
    <>
      <MotifTile pillar={pillar} className="opacity-70" />
      <div className="relative flex items-start justify-between gap-4">
        <span className="masthead text-[4.5rem] leading-[0.8]">{storyNumber(n)}</span>
        <Flag story={story} />
      </div>
      {story.angle ? (
        <div className="relative">
          <p className="mb-3 text-[0.8125rem] font-semibold">Our angle</p>
          <p className="line-clamp-5 max-w-[17ch] font-serif text-[clamp(1.75rem,1.1rem+2.2vw,3.25rem)] leading-[1.04] font-medium tracking-[-0.015em] italic">
            {story.angle}
          </p>
        </div>
      ) : null}
    </>
  );
  return (
    <ImageScope>
      <article
        id={storyAnchor(story.id)}
        aria-labelledby={`story-${story.id}`}
        className={cn(
          'flex scroll-mt-28 flex-wrap items-stretch gap-x-12 gap-y-7',
          // Wrapped onto two lines, the image still comes first.
          side === 'right' && 'flex-row-reverse',
        )}
      >
        <div
          className={cn(
            'relative flex min-h-[22rem] min-w-0 flex-[7_1_32rem] flex-col justify-between gap-10 overflow-hidden rounded-[20px] bg-bone px-6 pt-6 pb-7 sm:min-h-[27.5rem] sm:px-8 sm:pt-7 sm:pb-8',
            skipped && 'opacity-60',
          )}
        >
          {story.image ? (
            <>
              <IfImage>
                <div className="absolute inset-0">
                  <StoryImage image={story.image} pillar={pillar} ratio="fill" caption={false} />
                </div>
                <div className="relative flex items-start justify-between gap-4">
                  <span className="masthead rounded-full bg-white px-3 pt-2 pb-1.5 text-2xl leading-none">
                    {storyNumber(n)}
                  </span>
                  <span className="rounded-full bg-white">
                    <Flag story={story} />
                  </span>
                </div>
              </IfImage>
              <IfNoImage>{panel}</IfNoImage>
            </>
          ) : (
            panel
          )}
        </div>
        <div className="flex min-w-0 flex-[5_1_22.5rem] flex-col pt-1">
          <div className={cn(skipped && 'opacity-60')}>
            <SubjectLine story={story} />
            <div className="mt-3 flex flex-wrap items-center gap-2 empty:hidden">
              <TimeSensitive story={story} />
            </div>
            <Headline
              story={story}
              className="mt-4 font-serif text-[clamp(1.75rem,1.2rem+1.6vw,2.5rem)] leading-[1.06] font-medium tracking-[-0.014em]"
            />
            {story.summary ? (
              <p className="mt-3.5 font-serif text-lg leading-[1.55] text-graphite">
                {story.summary}
              </p>
            ) : null}
            {story.whyItMatters ? (
              <p className="mt-3 font-serif text-[1.0625rem] leading-[1.55] text-ink">
                <strong className="mr-1.5 font-sans text-[0.8125rem] font-semibold">
                  Why it matters.
                </strong>
                {story.whyItMatters}
              </p>
            ) : null}
            {story.image && story.angle ? (
              // Over the panel instead when the image won't load.
              <IfImage>
                <p className="mt-3 font-serif text-[1.0625rem] leading-[1.55] text-ink italic">
                  <strong className="mr-1.5 font-sans text-[0.8125rem] font-semibold not-italic">
                    Our angle.
                  </strong>
                  {story.angle}
                </p>
              </IfImage>
            ) : null}
            {story.image ? (
              <p className="meta mt-3 text-xs">
                <ImageCredit image={story.image} />
              </p>
            ) : null}
          </div>
          <div className="mt-auto flex flex-wrap items-center justify-between gap-3 pt-5">
            <div className="flex flex-wrap items-center gap-x-5">
              <StoryLinks story={story} />
            </div>
            <DecisionButtons storyId={story.id} state={story.editorialState} appearance="icons" />
          </div>
        </div>
      </article>
    </ImageScope>
  );
}

/**
 * Stories three to five, side by side in different shapes: an image in portrait or landscape,
 * or, with no image (or one that won't load), a text-led column that opens with the angle. Below
 * 1024px, where three won't fit, each becomes a numbered row with a small image, as in the
 * edition's list, so no column is ever left to stretch across the page with its image.
 */
export function ColumnStory({
  story,
  n,
  shape,
}: {
  story: StoryCardDto;
  n: number;
  shape: 'portrait' | 'landscape' | 'text';
}) {
  const pillar = pillarLabel(story.primaryPillar);
  const skipped = story.editorialState === 'skipped';
  const textHeader = (
    <div className="flex items-center justify-between gap-3 border-t-2 border-ink pt-4">
      <span className="masthead text-[2.875rem] leading-[0.85]">{storyNumber(n)}</span>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Flag story={story} />
        <TimeSensitive story={story} />
      </div>
    </div>
  );
  return (
    <article
      id={storyAnchor(story.id)}
      aria-labelledby={`story-${story.id}`}
      className={cn(
        'flex w-full min-w-0 scroll-mt-28 flex-col',
        shape === 'landscape' ? 'lg:flex-[1.35_1_23.75rem]' : 'lg:flex-[1_1_18.75rem]',
      )}
    >
      <ImageScope>
        <div className={cn(skipped && 'opacity-60')}>
          {shape === 'text' ? (
            textHeader
          ) : (
            <>
              <IfImage>
                <div className="relative hidden lg:block">
                  <StoryImage image={story.image} pillar={pillar} ratio={shape} />
                  <NumberTag n={n} />
                </div>
                <div className="flex items-start justify-between gap-4 border-t-2 border-ink pt-4 lg:hidden">
                  <span className="masthead text-[2.875rem] leading-[0.85]">{storyNumber(n)}</span>
                  <div className="relative h-20 w-28 flex-none overflow-hidden rounded-[10px] bg-bone">
                    <StoryImage
                      image={story.image}
                      pillar={pillar}
                      ratio="fill"
                      caption={false}
                      fit="cover"
                    />
                  </div>
                </div>
              </IfImage>
              <IfNoImage>{textHeader}</IfNoImage>
            </>
          )}
          <SubjectLine story={story} className={shape === 'text' ? 'mt-5' : 'mt-4'} />
          {shape !== 'text' ? (
            <IfImage>
              <div className="mt-2 flex flex-wrap items-center gap-2 empty:hidden">
                <Flag story={story} />
                <TimeSensitive story={story} />
              </div>
            </IfImage>
          ) : null}
          <Headline
            story={story}
            className="mt-3 font-serif text-[clamp(1.5rem,1.15rem+1.1vw,2.125rem)] leading-[1.08] font-medium tracking-[-0.012em]"
          />
          {shape === 'text' && story.angle ? (
            <p className="mt-5 border-y border-hairline py-4 font-serif text-[1.375rem] leading-[1.15] font-medium tracking-[-0.01em] italic sm:text-[1.625rem]">
              {story.angle}
            </p>
          ) : null}
          {story.summary ? (
            <p className="mt-3.5 line-clamp-4 font-serif text-[1.0625rem] leading-[1.55] text-graphite">
              {story.summary}
            </p>
          ) : null}
          {shape !== 'text' && story.image ? (
            <p className="meta mt-2 text-xs lg:hidden">
              <ImageCredit image={story.image} />
            </p>
          ) : null}
        </div>
        <div className="mt-auto flex flex-wrap items-center gap-x-5 pt-3">
          <StoryLinks story={story} />
          <span className="ml-auto">
            <DecisionButtons storyId={story.id} state={story.editorialState} appearance="icons" />
          </span>
        </div>
      </ImageScope>
    </article>
  );
}

/** Stories six onwards: a ranked row with a small image or motif tile. */
export function RankedStory({ story, n }: { story: StoryCardDto; n: number }) {
  const pillar = pillarLabel(story.primaryPillar);
  const skipped = story.editorialState === 'skipped';
  return (
    <li
      id={storyAnchor(story.id)}
      aria-labelledby={`story-${story.id}`}
      className="grid scroll-mt-28 grid-cols-[2.75rem_minmax(0,1fr)] items-start gap-x-3 gap-y-3 border-b border-hairline py-6 sm:grid-cols-[4rem_minmax(0,1fr)_15.5rem] sm:gap-x-8 md:grid-cols-[4rem_minmax(0,1fr)_15.5rem_10.5rem]"
    >
      <span
        className={cn(
          'masthead text-[2.375rem] leading-[0.82] sm:text-[3.5rem]',
          skipped && 'text-stone',
        )}
      >
        {storyNumber(n)}
      </span>
      <div className={cn('min-w-0', skipped && 'opacity-60')}>
        <SubjectLine story={story} />
        <div className="mt-2 flex flex-wrap items-center gap-2 empty:hidden">
          <Flag story={story} />
          <TimeSensitive story={story} />
        </div>
        <Headline
          story={story}
          className="mt-2.5 font-serif text-[clamp(1.375rem,1.15rem+0.7vw,1.8125rem)] leading-[1.12] font-medium tracking-[-0.01em]"
        />
        {story.summary ? (
          <p className="mt-2 line-clamp-2 font-serif text-[1.03125rem] leading-normal text-graphite">
            {story.summary}
          </p>
        ) : null}
      </div>
      <div className="col-start-2 flex flex-wrap items-center gap-x-4 gap-y-1 sm:col-start-auto sm:flex-col sm:items-start sm:gap-1.5">
        <StoryLinks story={story} />
        <DecisionButtons storyId={story.id} state={story.editorialState} appearance="icons" />
      </div>
      <div
        className={cn(
          'relative hidden h-28 overflow-hidden rounded-[12px] bg-bone md:block',
          skipped && 'opacity-60',
        )}
      >
        {story.image ? (
          <StoryImage
            image={story.image}
            pillar={pillar}
            ratio="fill"
            caption={false}
            fit="cover"
          />
        ) : (
          <MotifTile pillar={pillar} />
        )}
      </div>
    </li>
  );
}

/**
 * A recommended story as a list row, for the reading list: image or motif, subject, headline,
 * summary and its own actions.
 */
export function StoryCard({
  story,
  actions,
  meta,
  className,
}: {
  story: StoryCardDto;
  /** Replaces the default save/skip controls. */
  actions?: ReactNode;
  /** Extra items for a quiet meta line (e.g. "Saved by Ada, 15 Oct"). */
  meta?: ReactNode[];
  className?: string;
}) {
  const pillar = pillarLabel(story.primaryPillar);
  const controls = actions ?? (
    <DecisionButtons storyId={story.id} state={story.editorialState} appearance="icons" />
  );
  return (
    <article
      aria-labelledby={`story-${story.id}`}
      className={cn(
        'grid grid-cols-[5.5rem_1fr] gap-x-5 gap-y-3 py-6 sm:grid-cols-[10.5rem_1fr] md:gap-x-8',
        className,
      )}
    >
      <StoryImage
        image={story.image}
        pillar={pillar}
        ratio="landscape"
        caption={false}
        className="row-span-2 sm:row-span-1"
      />
      <div className="min-w-0">
        <SubjectLine story={story} />
        <Headline
          story={story}
          className="mt-2.5 font-serif text-[1.375rem] leading-tight font-medium md:text-[1.625rem]"
        />
        {story.summary ? (
          <p className="mt-2 line-clamp-2 max-w-[70ch] font-serif text-[1.03125rem] leading-relaxed text-graphite">
            {story.summary}
          </p>
        ) : null}
        <MetaLine className="mt-2.5" items={meta ?? []} />
      </div>
      <div className="col-start-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <StoryLinks story={story} />
        {controls}
      </div>
    </article>
  );
}
