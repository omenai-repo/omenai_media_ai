import { cn } from '@/lib/utils';

/** The Omenai wordmark: the name in the masthead face on an ink tag, "Newsroom" in italic. */
export function Wordmark({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  return (
    <span className={cn('inline-flex items-center gap-2 sm:gap-2.5', className)}>
      <span className="masthead rounded-[7px] bg-ink px-2 pt-[6px] pb-[5px] text-[1.0625rem] leading-none tracking-[0.07em] text-white sm:px-2.5 sm:pt-[7px] sm:pb-1.5 sm:text-[1.25rem]">
        Omenai
      </span>
      {compact ? null : (
        <span className="font-serif text-[1.125rem] leading-none text-ink italic sm:text-[1.3rem]">
          Newsroom
        </span>
      )}
    </span>
  );
}
