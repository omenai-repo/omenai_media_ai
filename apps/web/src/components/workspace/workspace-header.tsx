import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * The header of the full-screen story workspaces (research, studio): the way back to the story,
 * which workspace this is, the story itself, then the workspace's own status and tools.
 */
export function WorkspaceHeader({
  storyId,
  eyebrow,
  headline,
  section,
  children,
}: {
  storyId: string;
  eyebrow: string;
  headline: string;
  section: string;
  children?: ReactNode;
}) {
  return (
    <header className="z-20 shrink-0 border-b border-hairline bg-paper">
      <div className="flex min-h-16 items-center gap-3 px-4 py-2 sm:px-5 lg:gap-4">
        <Link
          href={`/stories/${storyId}`}
          className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-sm text-sm font-medium text-graphite hover:text-ink"
        >
          <ArrowLeft className="size-4" aria-hidden />
          <span className="hidden sm:inline">Back to the story</span>
          <span className="sr-only sm:hidden">Back to the story</span>
        </Link>
        <span aria-hidden className="hidden h-6.5 w-px bg-hairline sm:block" />
        <div className="hidden shrink-0 items-center gap-2 md:flex">
          <span className="masthead rounded-[5px] bg-ink px-[7px] pt-[5px] pb-1 text-[0.9375rem] leading-none tracking-[0.07em] text-white">
            Omenai
          </span>
          <span className="font-serif text-[1.1875rem] leading-none italic">{section}</span>
        </div>
        <div className="min-w-0 flex-1 md:pl-2">
          <p className="truncate text-[0.71875rem] font-semibold tracking-[0.04em] text-slate uppercase">
            {eyebrow}
          </p>
          <h1
            className="truncate font-serif text-base leading-tight font-medium text-ink sm:text-lg"
            title={headline}
          >
            {headline}
          </h1>
        </div>
        {children}
      </div>
    </header>
  );
}
