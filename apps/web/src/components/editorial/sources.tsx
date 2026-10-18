import type { SourceDto } from '@repo/core';
import { ArrowUpRight } from 'lucide-react';

import { READ_STATUS, reliability } from './copy';
import { formatDate } from './format';

/** The articles behind a story, as retrieved. Links come from our records, never from the AI. */
export function SourceList({ sources }: { sources: SourceDto[] }) {
  if (sources.length === 0) return <p className="meta">No sources recorded.</p>;
  return (
    <ol className="divide-y divide-hairline">
      {sources.map((s) => {
        const readStatus = READ_STATUS[s.extractionStatus];
        return (
          <li key={s.id} className="py-4 first:pt-0">
            <p className="meta mb-1">
              {s.publisher} · {s.publishedAt ? formatDate(s.publishedAt) : 'Date not given'}
            </p>
            <a
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              className="group/source inline rounded-sm font-serif text-[1.0625rem] leading-snug text-ink underline decoration-hairline underline-offset-4 hover:decoration-ochre"
            >
              {s.headline}
              <ArrowUpRight
                className="ml-1 inline size-3.5 align-baseline text-ochre"
                aria-label="(opens the publisher’s site in a new tab)"
              />
            </a>
            <p className="mt-1.5 text-xs text-graphite">
              {reliability(s.sourceQuality)}
              {readStatus ? ` · ${readStatus}` : ''}
              {s.origin === 'research' ? ' · Found during research' : ''}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
