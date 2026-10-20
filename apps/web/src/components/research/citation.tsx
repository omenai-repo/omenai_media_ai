'use client';

import type { BriefClaimDto, ResearchSourceDto } from '@repo/core';
import { ArrowUpRight, CircleCheck, TriangleAlert } from 'lucide-react';

import { reliability } from '@/components/editorial/copy';
import { formatDate } from '@/components/editorial/format';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export type CitationStatus = BriefClaimDto['citationStatus'];

/** Statuses that ask the editor to check before relying on the point. */
export const needsChecking = (status: CitationStatus) =>
  status !== 'verified' && status !== 'uncited';

/** What a check found, in words. Only lowers confidence: no status says a passage supports a point. */
function statusText(status: CitationStatus, hasExcerpt: boolean): string {
  switch (status) {
    case 'verified':
      return 'Found: this passage appears word for word in the source. That shows where the point comes from, not that it’s correct.';
    case 'detail_not_in_excerpt':
      return 'Found, but this passage doesn’t contain the date, figure or quoted words the point gives. Check it before relying on it.';
    case 'excerpt_unrelated':
      return 'Found, but this passage doesn’t seem to be about this point. Check that it supports the point before relying on it.';
    case 'conflicting':
      return 'Found, but another source in this research gives a different date or figure. Check which is right before relying on it.';
    default:
      return hasExcerpt
        ? 'Not found: we couldn’t find this passage in the source. Check it before relying on it.'
        : 'No passage was quoted for this point. Open the source to check it.';
  }
}

/** A source's origin and reliability, in words. */
export function sourceNote(source: ResearchSourceDto): string {
  return `${source.origin === 'research' ? 'Found during research' : 'From the original reporting'} · ${reliability(source.sourceQuality)}`;
}

function StatusLine({
  status,
  hasExcerpt,
  also,
}: {
  status: CitationStatus;
  hasExcerpt: boolean;
  also: boolean;
}) {
  const verified = status === 'verified';
  if (also)
    return (
      <p className="text-sm text-graphite">
        Also cited for this point. The quoted passage, and its check, come from the first source
        listed.
      </p>
    );
  return (
    <p className={cn('flex items-start gap-1.5 text-sm', verified ? 'text-moss' : 'text-amber')}>
      {verified ? (
        <CircleCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      ) : (
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      )}
      <span className="text-ink">{statusText(status, hasExcerpt)}</span>
    </p>
  );
}

/**
 * An inline source reference. Opens a popover with the source's title, publisher, date, the quote
 * and whether we found it, so evidence can be checked without leaving the conversation.
 */
export function Citation({
  label,
  source,
  excerpt,
  status,
  also = false,
}: {
  label: string;
  source: ResearchSourceDto | undefined;
  excerpt: string | null;
  status: CitationStatus;
  /** A further source for a point whose quote comes from the first one. */
  also?: boolean;
}) {
  const unlocated = !also && needsChecking(status);
  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          'mx-0.5 inline-flex translate-y-[-1px] items-center gap-0.5 rounded-[5px] border px-1.25 align-baseline font-sans text-[0.6875rem] leading-4 font-semibold tabular-nums transition-colors data-[state=open]:shadow-[0_0_0_3px_var(--signal)]',
          unlocated
            ? 'border-amber/50 bg-amber-wash text-amber hover:border-amber'
            : 'border-ink bg-ivory text-ink hover:bg-ink hover:text-ivory data-[state=open]:bg-ink data-[state=open]:text-ivory',
        )}
        aria-label={`Source ${label}${unlocated ? ', needs checking' : ''}. Show evidence`}
      >
        {unlocated ? <TriangleAlert className="size-2.5" aria-hidden /> : null}
        {label}
      </PopoverTrigger>
      <PopoverContent>
        {source ? (
          <>
            <p className="meta">
              {label} · {source.publisher} ·{' '}
              {source.publishedAt ? formatDate(source.publishedAt) : 'Date not given'}
            </p>
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-link mt-1 block font-serif text-[1.0625rem] leading-snug text-ink"
            >
              {source.headline}
              <ArrowUpRight
                className="ml-1 inline size-3.5"
                aria-label="(opens the publisher’s site in a new tab)"
              />
            </a>
            <p className="mt-1 text-xs text-graphite">{sourceNote(source)}</p>
          </>
        ) : (
          <p className="meta">Source {label}</p>
        )}
        {excerpt ? (
          <blockquote className="mt-3 rounded-[10px] bg-bone px-3.5 py-2.5 font-serif leading-relaxed text-ink italic">
            “{excerpt}”
          </blockquote>
        ) : null}
        <div className="mt-3">
          <StatusLine status={status} hasExcerpt={Boolean(excerpt)} also={also} />
        </div>
      </PopoverContent>
    </Popover>
  );
}
