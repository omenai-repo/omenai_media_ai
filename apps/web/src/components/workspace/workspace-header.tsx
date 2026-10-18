import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Wordmark } from '@/components/brand/wordmark';

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
    <header className="z-20 shrink-0 border-b border-hairline bg-paper/95 backdrop-blur-sm">
      <div className="mx-auto flex max-w-[90rem] items-center gap-3 px-4 py-3 sm:px-6 lg:gap-6">
        <Link
          href={`/stories/${storyId}`}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-sm text-sm text-graphite hover:text-ink"
        >
          <ArrowLeft className="size-4" aria-hidden />
          <span className="hidden sm:inline">Back to the story</span>
          <span className="sr-only sm:hidden">Back to the story</span>
        </Link>
        <span aria-hidden className="hidden h-5 w-px bg-hairline sm:block" />
        <div className="hidden shrink-0 items-baseline gap-2 md:flex">
          <Wordmark compact />
          <span className="font-display text-[1.05rem] text-graphite italic">{section}</span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[0.7rem] font-medium tracking-[0.06em] text-ochre uppercase">
            {eyebrow}
          </p>
          <h1
            className="truncate font-display text-[1.05rem] leading-tight text-ink sm:text-[1.2rem]"
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
