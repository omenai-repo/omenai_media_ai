import { cn } from '@/lib/utils';

/** The Omenai wordmark. Set in the display serif; "Newsroom" marks the internal tool. */
export function Wordmark({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  return (
    <span className={cn('inline-flex items-baseline gap-2', className)}>
      <span className="font-serif text-[1.375rem] leading-none font-medium tracking-[0.18em]">
        OMENAI
      </span>
      {compact ? null : <span className="kicker">Newsroom</span>}
    </span>
  );
}
