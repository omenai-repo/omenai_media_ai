import type { SourceDto } from '@repo/core';
import { ArrowUpRight } from 'lucide-react';

import { cn } from '@/lib/utils';

import { READ_STATUS, reliability } from './copy';
import { formatDate } from './format';

/**
 * The articles behind a story, as retrieved and numbered in order. Links, publishers and dates
 * come from our records, never from the AI. An unverified social post is the one reliability
 * shown in colour: it changes how far anything from it can be used.
 */
export function SourceList({ sources }: { sources: SourceDto[] }) {
  if (sources.length === 0) return <p className="meta">No sources recorded.</p>;
  return (
    <ol className="border-t-2 border-ink">
      {sources.map((s, index) => {
        const readStatus = READ_STATUS[s.extractionStatus] ?? 'Full text read';
        const unverified = s.sourceQuality === 'unverified_social';
        return (
          <li
            key={s.id}
            className="grid grid-cols-[2.75rem_minmax(0,1fr)] gap-x-3.5 gap-y-1 border-b border-hairline py-4"
          >
            <span
              aria-hidden
              className="row-span-3 inline-flex h-6 w-9 items-center justify-center rounded-md border border-ink text-xs font-semibold tabular-nums"
            >
              {index + 1}
            </span>
            <p className="meta">
              {s.publisher} · {s.publishedAt ? formatDate(s.publishedAt) : 'Date not given'}
            </p>
            <a
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              className="group/source text-link inline rounded-sm font-serif text-[1.15625rem] leading-[1.35] text-ink"
            >
              {s.headline}
              <ArrowUpRight
                className="ml-1 inline size-3.5 align-baseline"
                aria-label="(opens the publisher’s site in a new tab)"
              />
            </a>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span
                className={cn(
                  'inline-flex h-6 items-center rounded-full px-2.5 text-xs font-semibold',
                  unverified ? 'bg-amber-wash text-amber' : 'border border-rule-strong text-ink',
                )}
              >
                {reliability(s.sourceQuality)}
              </span>
              <span className="text-[0.78125rem] text-slate">
                {readStatus}
                {s.origin === 'research' ? ' · Found during research' : ''}
              </span>
            </p>
          </li>
        );
      })}
    </ol>
  );
}
