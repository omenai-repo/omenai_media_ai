'use client';

import type { ImageDto } from '@repo/core';
import { PILLARS, type PillarId } from '@repo/shared';
import { useCallback, useState } from 'react';

import { cn } from '@/lib/utils';

import { IMAGE_CREDIT } from './copy';

const RATIO = {
  wide: 'aspect-[3/2]',
  card: 'aspect-[4/3]',
  square: 'aspect-square',
} as const;

/**
 * The publisher's preview image, linked rather than hosted, with an editorial fallback when a
 * story has no image or the image won't load. Rights are never assumed: the credit always says
 * so. A fixed aspect ratio keeps the layout still while the image loads.
 *
 * A plain <img> is deliberate: the MVP has no image hosting or optimisation, and the hosts are
 * arbitrary publishers, so next/image (which proxies and needs an allow-list) doesn't fit.
 */
export function StoryImage({
  image,
  pillar,
  ratio = 'card',
  caption = true,
  className,
}: {
  image: ImageDto | null;
  pillar: string;
  ratio?: keyof typeof RATIO;
  caption?: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [portrait, setPortrait] = useState(false);
  const inspect = useCallback((element: HTMLImageElement) => {
    if (element.naturalWidth === 0) setFailed(true);
    // Tall images are shown whole on a mat instead of being cropped through the subject.
    else setPortrait(element.naturalHeight > element.naturalWidth * 1.05);
  }, []);
  // An image can load or fail before React hydrates and attaches its handlers; check on mount.
  const checkLoaded = useCallback(
    (element: HTMLImageElement | null) => {
      if (element?.complete) inspect(element);
    },
    [inspect],
  );
  const showImage = image && !failed;

  return (
    <figure className={cn('min-w-0', className)}>
      <div
        className={cn(
          'relative overflow-hidden bg-bone',
          ratio === 'square' ? 'rounded-md' : 'rounded-lg',
          RATIO[ratio],
        )}
      >
        {showImage ? (
          // eslint-disable-next-line @next/next/no-img-element -- linked publisher image; see above
          <img
            ref={checkLoaded}
            src={image.url}
            alt={image.alt ?? ''}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onLoad={(event) => inspect(event.currentTarget)}
            onError={() => setFailed(true)}
            className={cn(
              'absolute inset-0 size-full fade-in',
              portrait ? 'object-contain p-[4%]' : 'object-cover',
            )}
          />
        ) : (
          <Fallback pillar={pillar} />
        )}
      </div>
      {caption && showImage ? (
        <figcaption className="mt-2 text-xs text-graphite">
          {IMAGE_CREDIT(image.publisher)}
        </figcaption>
      ) : null}
    </figure>
  );
}

type Motif = 'arcs' | 'weave' | 'waves' | 'arches' | 'dots' | 'strata';
const MOTIF: Record<PillarId, Motif> = {
  art_creative_expression: 'arcs',
  fashion_design_objects: 'weave',
  film_music_performance: 'waves',
  places_architecture_living: 'arches',
  people_influence_institutions: 'dots',
  ideas_history_cultural_change: 'strata',
};

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

function MotifLines({ motif }: { motif: Motif }) {
  switch (motif) {
    case 'arcs':
      return range(9).map((i) => <circle key={i} cx="400" cy="300" r={46 + i * 38} />);
    case 'weave':
      return range(17).map((i) => (
        <g key={i} opacity={i % 2 ? 0.55 : 1}>
          <line x1="0" y1={i * 18} x2="400" y2={i * 18} />
          <line x1={i * 25} y1="0" x2={i * 25} y2="300" />
        </g>
      ));
    case 'waves':
      return range(11).map((i) => {
        const y = 40 + i * 22;
        const lift = 8 + (i % 3) * 5;
        return (
          <path
            key={i}
            d={`M0 ${y} Q 50 ${y - lift} 100 ${y} T 200 ${y} T 300 ${y} T 400 ${y}`}
            fill="none"
          />
        );
      });
    case 'arches':
      return range(6).map((i) => {
        const x = 12 + i * 66;
        return <path key={i} d={`M${x} 300 V150 A27 27 0 0 1 ${x + 54} 150 V300`} fill="none" />;
      });
    case 'dots':
      return range(6).flatMap((row) =>
        range(9).map((col) => (
          <circle
            key={`${row}-${col}`}
            cx={24 + col * 46 + (row % 2) * 23}
            cy={30 + row * 50}
            r={row % 3 === 1 ? 3.5 : 2}
            fill="currentColor"
            stroke="none"
          />
        )),
      );
    case 'strata':
      return range(12).map((i) => {
        const y = 24 + i * 22 + (i % 3) * 4;
        return <line key={i} x1="0" y1={y} x2="400" y2={y} opacity={i % 4 === 1 ? 1 : 0.55} />;
      });
  }
}

/**
 * When there's no usable image: a quiet line motif for the story's subject area, drawn rather
 * than borrowed, so an empty slot never shows unrelated imagery or repeats the label beside it.
 */
function Fallback({ pillar }: { pillar: string }) {
  const id = (Object.keys(PILLARS) as PillarId[]).find((key) => PILLARS[key].label === pillar);
  return (
    <svg
      aria-hidden
      viewBox="0 0 400 300"
      preserveAspectRatio="xMidYMid slice"
      className="absolute inset-0 size-full text-ochre"
    >
      <g stroke="currentColor" strokeWidth="1" fill="none" opacity="0.3">
        <MotifLines motif={id ? MOTIF[id] : 'strata'} />
      </g>
    </svg>
  );
}
