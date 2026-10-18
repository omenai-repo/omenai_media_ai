import type { StoryCardDto } from '@repo/core';
import { ArrowRight, MessagesSquare } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { DecisionButtons } from './decisions';
import { pillarLabel, placeLabel } from './format';
import { MetaLine } from './primitives';
import { StoryImage } from './story-image';

type Variant = 'lead' | 'feature' | 'standard' | 'compact';

/** Long headlines step down a size so they never overwhelm the image beside them. */
function headlineClass(headline: string, variant: 'lead' | 'feature'): string {
  const long = headline.length > 90;
  if (variant === 'lead') return long ? 'display-md' : 'display-lg';
  return long ? 'display-sm' : 'display-md';
}

function Flags({ story }: { story: StoryCardDto }) {
  if (story.isUpdate) return <Badge variant="warning">Update on an earlier story</Badge>;
  if (story.relation === 'new_development') return <Badge variant="ochre">New development</Badge>;
  return null;
}

function Eyebrow({ story, className }: { story: StoryCardDto; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-2', className)}>
      <p className="eyebrow">
        {[pillarLabel(story.primaryPillar), placeLabel(story.geography)]
          .filter(Boolean)
          .join(' · ')}
      </p>
      <Flags story={story} />
    </div>
  );
}

function Headline({ story, className }: { story: StoryCardDto; className: string }) {
  return (
    <h2 id={`story-${story.id}`} className={className}>
      <Link href={`/stories/${story.id}`} className="headline-link rounded-sm">
        {story.headline}
      </Link>
    </h2>
  );
}

/**
 * The card's actions in order of weight: open the story (primary), research it (secondary),
 * then the quieter save and skip, which never compete with moving the story forward.
 */
function CardActions({
  story,
  controls,
  size,
}: {
  story: StoryCardDto;
  controls: ReactNode;
  size: 'default' | 'sm';
}) {
  const describedBy = `story-${story.id}`;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {/* Solid only on the lead, so a grid of cards doesn't become a wall of black buttons. */}
        <Button asChild size={size} variant={size === 'default' ? 'default' : 'outline'}>
          <Link href={`/stories/${story.id}`} aria-describedby={describedBy}>
            Open story <ArrowRight aria-hidden />
          </Link>
        </Button>
        <Button asChild size={size} variant="ghost">
          <Link href={`/stories/${story.id}/research`} aria-describedby={describedBy}>
            <MessagesSquare aria-hidden className="text-ochre" /> Research
          </Link>
        </Button>
      </div>
      {controls}
    </div>
  );
}

/**
 * A recommended story at four weights: the edition's lead, a wide feature (a lone second story),
 * a standard card in the grid, and a compact row for lists. Each shows only what helps choose
 * what to open; the angle, sources, scores and checks wait on the story page.
 */
export function StoryCard({
  story,
  variant = 'standard',
  actions,
  meta,
  className,
}: {
  story: StoryCardDto;
  variant?: Variant;
  /** Replaces the default save/skip controls. */
  actions?: ReactNode;
  /** Extra items for a quiet meta line (e.g. "Saved by Ada, 15 Oct"). */
  meta?: ReactNode[];
  className?: string;
}) {
  const pillar = pillarLabel(story.primaryPillar);
  const controls = actions ?? (
    <DecisionButtons storyId={story.id} state={story.editorialState} compact />
  );

  if (variant === 'lead') {
    return (
      <article
        aria-labelledby={`story-${story.id}`}
        className={cn('grid gap-8 lg:grid-cols-12 lg:gap-12', className)}
      >
        <StoryImage image={story.image} pillar={pillar} ratio="wide" className="lg:col-span-7" />
        <div className="flex min-w-0 flex-col lg:col-span-5 lg:py-2">
          <Eyebrow story={story} className="mb-4" />
          <Headline story={story} className={headlineClass(story.headline, 'lead')} />
          {story.summary ? <p className="standfirst mt-5">{story.summary}</p> : null}
          {story.whyItMatters ? (
            <p className="mt-5 font-serif text-[1.0625rem] leading-relaxed text-ink">
              <span className="mr-1.5 font-sans text-sm font-semibold text-ochre">
                Why it matters.
              </span>
              {story.whyItMatters}
            </p>
          ) : null}
          <MetaLine className="mt-5" items={meta ?? []} />
          <div className="mt-auto pt-8">
            <CardActions story={story} controls={controls} size="default" />
          </div>
        </div>
      </article>
    );
  }

  if (variant === 'feature') {
    return (
      <article
        aria-labelledby={`story-${story.id}`}
        className={cn('grid gap-8 md:grid-cols-12 md:gap-10 lg:gap-12', className)}
      >
        <StoryImage image={story.image} pillar={pillar} ratio="card" className="md:col-span-5" />
        <div className="flex min-w-0 flex-col md:col-span-7 lg:col-span-6">
          <Eyebrow story={story} className="mb-3" />
          <Headline story={story} className={headlineClass(story.headline, 'feature')} />
          {story.summary ? <p className="standfirst mt-4 text-lg">{story.summary}</p> : null}
          <MetaLine className="mt-4" items={meta ?? []} />
          <div className="mt-auto pt-6">
            <CardActions story={story} controls={controls} size="sm" />
          </div>
        </div>
      </article>
    );
  }

  if (variant === 'compact') {
    return (
      <article
        aria-labelledby={`story-${story.id}`}
        className={cn(
          'grid grid-cols-[5.5rem_1fr] gap-x-5 gap-y-4 py-6 sm:grid-cols-[9rem_1fr] md:gap-x-8',
          className,
        )}
      >
        <StoryImage
          image={story.image}
          pillar={pillar}
          ratio="square"
          caption={false}
          className="row-span-2 sm:row-span-1"
        />
        <div className="min-w-0">
          <Eyebrow story={story} className="mb-2" />
          <Headline
            story={story}
            className="font-display text-[1.375rem] leading-tight md:text-[1.625rem]"
          />
          {story.summary ? (
            <p className="mt-2 line-clamp-2 max-w-[70ch] font-serif leading-relaxed text-graphite">
              {story.summary}
            </p>
          ) : null}
          <MetaLine className="mt-3" items={meta ?? []} />
        </div>
        <div className="col-start-2">
          <CardActions story={story} controls={controls} size="sm" />
        </div>
      </article>
    );
  }

  return (
    <article
      aria-labelledby={`story-${story.id}`}
      className={cn('flex min-w-0 flex-col', className)}
    >
      <StoryImage image={story.image} pillar={pillar} ratio="card" />
      <Eyebrow story={story} className="mt-5 mb-3" />
      <Headline story={story} className="display-sm" />
      {story.summary ? (
        <p className="mt-3 line-clamp-3 font-serif text-[1.0625rem] leading-relaxed text-graphite">
          {story.summary}
        </p>
      ) : null}
      <MetaLine className="mt-3" items={meta ?? []} />
      <div className="mt-auto pt-5">
        <CardActions story={story} controls={controls} size="sm" />
      </div>
    </article>
  );
}
