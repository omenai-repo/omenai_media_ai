import { cn } from '@/lib/utils';

/** The Omenai wordmark: spaced capitals in Newsreader, with "Newsroom" in the display italic. */
export function Wordmark({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  return (
    <span className={cn('inline-flex items-baseline gap-2.5', className)}>
      <span className="font-serif text-[1.3rem] leading-none font-medium tracking-[0.2em] text-ink">
        OMENAI
      </span>
      {compact ? null : (
        <span className="font-display text-[1.15rem] leading-none text-graphite italic">
          Newsroom
        </span>
      )}
    </span>
  );
}
