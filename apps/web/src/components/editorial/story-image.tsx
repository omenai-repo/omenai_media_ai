'use client';

import type { ImageDto } from '@repo/core';
import { PILLARS, type PillarId } from '@repo/shared';
import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from 'react';

import { cn } from '@/lib/utils';

import { IMAGE_CREDIT } from './copy';

const RATIO = {
  video: 'aspect-video',
  wide: 'aspect-[3/2]',
  landscape: 'aspect-[3/2]',
  card: 'aspect-[4/3]',
  portrait: 'aspect-[4/5]',
  square: 'aspect-square',
  /** Fills a parent that sets its own size. */
  fill: 'size-full',
} as const;

export type ImageRatio = keyof typeof RATIO;

/**
 * Whether an image failed to load, shared between the image and its credit line so the credit
 * never names a publisher's image the reader can't see. Without a scope, each image keeps its
 * own state.
 */
const ImageState = createContext<{ failed: boolean; setFailed: (failed: boolean) => void } | null>(
  null,
);

export function ImageScope({ children }: { children: ReactNode }) {
  const [failed, setFailed] = useState(false);
  return <ImageState.Provider value={{ failed, setFailed }}>{children}</ImageState.Provider>;
}

function useFailed(): [boolean, (failed: boolean) => void] {
  const scope = useContext(ImageState);
  const [own, setOwn] = useState(false);
  return scope ? [scope.failed, scope.setFailed] : [own, setOwn];
}

/** The image's credit, or plainly why there's no image. Rights are never assumed. */
export function ImageCredit({ image }: { image: ImageDto | null }) {
  const [failed] = useFailed();
  if (!image) return <>No usable image in this story’s sources</>;
  if (failed) return <>The source’s image couldn’t be loaded</>;
  return <>{IMAGE_CREDIT(image.publisher)}</>;
}

/** Shows its children only while the scope's image is usable (see `ImageScope`). */
export function IfImage({ children }: { children: ReactNode }) {
  const [failed] = useFailed();
  return failed ? null : <>{children}</>;
}

/** Shows its children only once the scope's image has failed to load. */
export function IfNoImage({ children }: { children: ReactNode }) {
  const [failed] = useFailed();
  return failed ? <>{children}</> : null;
}

/**
 * Loading state for a linked publisher image. An image can load or fail before React hydrates
 * and attaches its handlers, so the element is also checked when it mounts. `shouldContain`
 * decides, from the image's and its frame's proportions, when to show the image whole on a mat
 * instead of cropping through the subject.
 */
function useImageLoad(shouldContain: (imageAspect: number, frameAspect: number) => boolean) {
  const [failed, setFailed] = useFailed();
  const [contain, setContain] = useState(false);
  const inspect = useCallback(
    (element: HTMLImageElement) => {
      if (element.naturalWidth === 0) return setFailed(true);
      const frame = element.parentElement?.getBoundingClientRect();
      const frameAspect = frame && frame.height > 0 ? frame.width / frame.height : 1.5;
      setContain(shouldContain(element.naturalWidth / element.naturalHeight, frameAspect));
    },
    [setFailed, shouldContain],
  );
  // A callback ref, named so it isn't mistaken for a ref object read during render.
  const attach = useCallback(
    (element: HTMLImageElement | null) => {
      if (element?.complete) inspect(element);
    },
    [inspect],
  );
  return {
    failed,
    contain,
    attach,
    onLoad: (event: SyntheticEvent<HTMLImageElement>) => inspect(event.currentTarget),
    onError: () => setFailed(true),
  };
}

/** Cropping to fill the frame would hide more than ~40% of the image. */
const mostlyCropped = (imageAspect: number, frameAspect: number) => imageAspect < frameAspect * 0.6;
/** The lead's wide frame crops landscape images; only an upright one is shown whole. */
const upright = (imageAspect: number) => imageAspect < 1;
const never = () => false;

/**
 * The publisher's preview image, linked rather than hosted, with a drawn tile when a story has no
 * image or the image won't load: never a broken box or unrelated imagery. A fixed aspect ratio
 * keeps the layout still while the image loads.
 *
 * A plain <img> is deliberate: the MVP has no image hosting or optimisation, and the hosts are
 * arbitrary publishers, so next/image (which proxies and needs an allow-list) doesn't fit.
 */
export function StoryImage({
  image,
  pillar,
  ratio = 'card',
  caption = true,
  fallback = 'tile',
  fit = 'auto',
  className,
}: {
  image: ImageDto | null;
  pillar: string;
  ratio?: ImageRatio;
  caption?: boolean;
  /** `none`: show nothing at all when there's no usable image (where a tile would only fill space). */
  fallback?: 'tile' | 'none';
  /** `cover` always fills the frame: for thumbnails, where a mat would leave a speck of image. */
  fit?: 'auto' | 'cover';
  className?: string;
}) {
  const { failed, contain, attach, onLoad, onError } = useImageLoad(
    fit === 'cover' ? never : mostlyCropped,
  );
  const showImage = image && !failed;
  if (!showImage && fallback === 'none') return null;

  return (
    <figure className={cn('min-w-0', ratio === 'fill' && 'size-full', className)}>
      <div
        className={cn(
          'relative overflow-hidden bg-bone',
          // A filled image takes its corners from the frame it fills.
          ratio === 'fill' ? null : ratio === 'square' ? 'rounded-[10px]' : 'rounded-[14px]',
          RATIO[ratio],
        )}
      >
        {showImage ? (
          // eslint-disable-next-line @next/next/no-img-element -- linked publisher image; see above
          <img
            ref={attach}
            src={image.url}
            alt={image.alt ?? ''}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onLoad={onLoad}
            onError={onError}
            className={cn(
              'absolute inset-0 size-full fade-in',
              contain ? 'object-contain p-[4%]' : 'object-cover',
            )}
          />
        ) : (
          <MotifTile pillar={pillar} />
        )}
      </div>
      {caption && showImage ? (
        <figcaption className="mt-2 text-xs text-slate">{IMAGE_CREDIT(image.publisher)}</figcaption>
      ) : null}
    </figure>
  );
}

/**
 * The lead story's frame: the image at full width with a fade for the headline, or, with no usable
 * image, a black cover drawn with the subject's motif so the lead keeps its weight. `children`
 * (the subject tag and headline) sit over the lower left.
 */
export function HeroImage({
  image,
  pillar,
  children,
  className,
}: {
  image: ImageDto | null;
  pillar: string;
  children: ReactNode;
  className?: string;
}) {
  const { failed, contain, attach, onLoad, onError } = useImageLoad(upright);
  const showImage = image && !failed;
  return (
    <div
      className={cn(
        'relative h-[clamp(27.5rem,42vw,38.75rem)] overflow-hidden rounded-[18px] bg-ink sm:rounded-[20px]',
        className,
      )}
    >
      {showImage ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element -- linked publisher image; see StoryImage */}
          <img
            ref={attach}
            src={image.url}
            alt={image.alt ?? ''}
            decoding="async"
            referrerPolicy="no-referrer"
            onLoad={onLoad}
            onError={onError}
            className={cn(
              'absolute inset-0 size-full fade-in',
              contain ? 'object-contain' : 'object-cover',
            )}
          />
          <div aria-hidden className="image-scrim absolute inset-0" />
        </>
      ) : (
        <>
          <MotifCover pillar={pillar} />
          {/* The drawing stays clear of the headline: above it on a phone, to its right wider. */}
          <div
            aria-hidden
            className="absolute inset-0 bg-[linear-gradient(0deg,var(--ink)_0%,var(--ink)_46%,rgb(12_12_13/0.7)_62%,rgb(12_12_13/0)_82%)] sm:bg-[linear-gradient(90deg,var(--ink)_0%,var(--ink)_34%,rgb(12_12_13/0.72)_56%,rgb(12_12_13/0)_78%)]"
          />
        </>
      )}
      <div className="on-dark absolute inset-x-5 bottom-5 max-w-4xl text-white sm:inset-x-10 sm:bottom-9">
        {children}
      </div>
    </div>
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

function motifFor(pillar: string): Motif {
  const id = (Object.keys(PILLARS) as PillarId[]).find((key) => PILLARS[key].label === pillar);
  return id ? MOTIF[id] : 'strata';
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

/** Tile motifs, drawn on a 400 × 300 field. */
function TileLines({ motif }: { motif: Motif }) {
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

/** A wash tile with the subject's line motif in ink: drawn, never borrowed imagery. */
export function MotifTile({ pillar, className }: { pillar: string; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 400 300"
      preserveAspectRatio="xMidYMid slice"
      className={cn('absolute inset-0 size-full text-ink', className)}
    >
      <g stroke="currentColor" strokeWidth="1" fill="none" opacity="0.3">
        <TileLines motif={motifFor(pillar)} />
      </g>
    </svg>
  );
}

/** Cover motifs, drawn on a 600 × 600 field anchored to the lower right. */
function CoverLines({ motif }: { motif: Motif }) {
  switch (motif) {
    case 'arcs':
      return (
        <>
          <g fill="none" stroke="currentColor" strokeWidth="2.2" opacity="0.55">
            {range(9).map((i) => (
              <circle key={i} cx="600" cy="600" r={70 + i * 62} />
            ))}
          </g>
          <circle cx="600" cy="600" r="70" fill="currentColor" opacity="0.16" />
        </>
      );
    case 'weave':
      return (
        <g stroke="currentColor" strokeWidth="2" opacity="0.5">
          {range(14).map((i) => (
            <line key={`h${i}`} x1="0" y1={40 + i * 40} x2="600" y2={40 + i * 40} />
          ))}
          <g opacity="0.6">
            {range(10).map((i) => (
              <line key={`v${i}`} x1={40 + i * 60} y1="0" x2={40 + i * 60} y2="600" />
            ))}
          </g>
        </g>
      );
    case 'waves':
      return (
        <g fill="none" stroke="currentColor" strokeWidth="2.4" opacity="0.55">
          {range(11).map((i) => {
            const y = 60 + i * 48;
            const lift = 24 + (i % 3) * 4;
            return (
              <path
                key={i}
                d={`M0 ${y} Q 50 ${y - lift} 100 ${y} T 200 ${y} T 300 ${y} T 400 ${y} T 500 ${y} T 600 ${y}`}
              />
            );
          })}
        </g>
      );
    case 'arches':
      return (
        <g fill="none" stroke="currentColor" strokeWidth="2.4" opacity="0.6">
          {range(6).map((i) => {
            const x = 24 + i * 100;
            return <path key={`b${i}`} d={`M${x} 600 V320 A40 40 0 0 1 ${x + 80} 320 V600`} />;
          })}
          {[74, 274, 474].map((x) => (
            <path key={`t${x}`} d={`M${x} 260 V140 A40 40 0 0 1 ${x + 80} 140 V260`} />
          ))}
        </g>
      );
    case 'dots':
      return (
        <g fill="currentColor" opacity="0.6">
          {range(7).flatMap((row) =>
            range(7).map((col) => (
              <circle
                key={`${row}-${col}`}
                cx={(row % 2 ? 80 : 40) + col * 80}
                cy={60 + row * 80}
                r={row === 1 || row === 4 ? 6 : 3}
              />
            )),
          )}
        </g>
      );
    case 'strata':
      return (
        <g stroke="currentColor" strokeWidth="2.2" opacity="0.55">
          {[48, 100, 152, 180, 232, 284, 312, 364, 416, 444, 496, 548].map((y) => (
            <line key={y} x1="0" y1={y} x2="600" y2={y} />
          ))}
        </g>
      );
  }
}

/** The black cover for a lead story without a usable image: the subject's motif in white. */
export function MotifCover({ pillar, className }: { pillar: string; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 600 600"
      preserveAspectRatio="xMaxYMax slice"
      className={cn('absolute top-0 right-0 h-full w-[64%] text-white', className)}
    >
      <CoverLines motif={motifFor(pillar)} />
    </svg>
  );
}
