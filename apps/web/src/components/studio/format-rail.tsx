import type { DraftsViewDto } from '@repo/core';
import { DRAFT_FORMAT_IDS, DRAFT_FORMATS, type DraftFormat } from '@repo/shared';
import {
  ArrowRight,
  BriefcaseBusiness,
  Camera,
  FileText,
  Loader2,
  MessageSquareText,
  Newspaper,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';

import { formatDayMonth } from '@/components/editorial/format';
import { cn } from '@/lib/utils';

import { formatStatus, limitText, type FormatStatus } from './format-status';

/** Each format's mark, and its short name for the chip row on phones. */
const MARK: Record<DraftFormat, { short: string; icon: LucideIcon }> = {
  newsletter_item: { short: 'Weekly Briefing', icon: Newspaper },
  editorial_article: { short: 'Article', icon: FileText },
  linkedin_post: { short: 'LinkedIn', icon: BriefcaseBusiness },
  instagram_caption: { short: 'Instagram', icon: Camera },
  x_post: { short: 'X post', icon: MessageSquareText },
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A format's progress in a line or three: versions and their check state, or why there are none. */
function StatusLines({ status, current }: { status: FormatStatus; current: boolean }) {
  const muted = current ? 'text-white/70' : 'text-slate';
  const warning = cn(
    'flex items-center gap-1.5 font-medium',
    current ? 'text-amber-wash' : 'text-amber',
  );
  switch (status.kind) {
    case 'writing':
      return (
        <span className={cn('flex items-center gap-1.5', current ? 'text-white' : 'text-ink')}>
          <Loader2 className="size-3 animate-spin" aria-hidden />
          Writing version {status.next}…
        </span>
      );
    case 'failed':
      return (
        <span className={warning}>
          <TriangleAlert className="size-3" aria-hidden />
          Didn’t finish
        </span>
      );
    case 'empty':
      return <span className={muted}>Not started</span>;
    case 'drafted':
      return (
        <>
          <span className={muted}>
            {plural(status.versions, 'version', 'versions')} · {formatDayMonth(status.latestAt)}
          </span>
          {/* No colour: a filled dot when the latest text is the text that was checked. */}
          <span className={cn('mt-1 flex items-center gap-1.5', muted)}>
            <span
              aria-hidden
              className={cn(
                'size-[7px] shrink-0 rounded-full border-[1.5px]',
                current ? 'border-white/80' : 'border-graphite',
                status.checked && (current ? 'bg-white/80' : 'bg-graphite'),
              )}
            />
            {status.checked ? 'Sources checked' : 'Text not checked'}
          </span>
          {status.failedSince ? (
            <span className={cn('mt-1', warning)}>
              <TriangleAlert className="size-3" aria-hidden />
              Last request didn’t finish
            </span>
          ) : null}
        </>
      );
  }
}

/**
 * The Studio's formats: a chip row on phones; on wide screens a sidebar with each format's length,
 * versions and check state, then what the drafts are written from. Everything comes from the
 * drafts view already loaded for the page.
 */
export function FormatRail({
  view,
  format,
  unsaved,
  storyId,
  onSelect,
}: {
  view: DraftsViewDto;
  format: DraftFormat;
  /** Formats with edits not yet saved as a version. */
  unsaved: ReadonlySet<DraftFormat>;
  storyId: string;
  onSelect: (format: DraftFormat) => void;
}) {
  const started = DRAFT_FORMAT_IDS.filter((f) => view.formats[f].versions.length).length;
  const sources = Object.values(view.sources);
  const fromResearch = sources.filter((s) => s.origin === 'research').length;
  const toConfirm = view.research.toConfirm.length;

  return (
    <nav
      aria-label="Formats"
      className="min-w-0 border-b border-hairline bg-ivory lg:overflow-y-auto lg:overscroll-contain lg:border-r lg:border-b-0"
    >
      {/* Phones and tablets: one row of chips. */}
      <ul className="flex [scrollbar-width:none] gap-2 overflow-x-auto px-4 py-2.5 sm:px-6 lg:hidden">
        {DRAFT_FORMAT_IDS.map((f) => {
          const current = f === format;
          return (
            <li key={f} className="shrink-0">
              <button
                type="button"
                onClick={() => onSelect(f)}
                aria-current={current ? 'page' : undefined}
                className={cn(
                  'flex min-h-10 items-center gap-2 rounded-full border px-3.5 text-[0.84375rem] font-medium whitespace-nowrap transition-colors pointer-coarse:min-h-11',
                  current
                    ? 'border-ink bg-ink font-semibold text-white'
                    : 'border-hairline bg-ivory text-graphite hover:text-ink',
                )}
              >
                {MARK[f].short}
                {unsaved.has(f) ? (
                  <>
                    <span
                      aria-hidden
                      className={cn('size-2 rounded-full', current ? 'bg-signal' : 'bg-ink')}
                    />
                    <span className="sr-only">, unsaved changes</span>
                  </>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>

      {/* Wide screens: the sidebar, which scrolls on its own. */}
      <div className="hidden lg:flex lg:flex-col lg:px-3 lg:pt-6 lg:pb-8">
        <div className="flex items-baseline justify-between gap-2 px-3">
          <h2 className="masthead text-xl tracking-[0.02em]">Formats</h2>
          <p className="text-xs text-slate">
            {started} of {DRAFT_FORMAT_IDS.length} started
          </p>
        </div>
        <ul className="mt-3 grid gap-1">
          {DRAFT_FORMAT_IDS.map((f) => {
            const current = f === format;
            const Icon = MARK[f].icon;
            return (
              <li key={f}>
                <button
                  type="button"
                  onClick={() => onSelect(f)}
                  aria-current={current ? 'page' : undefined}
                  className={cn(
                    'w-full rounded-[14px] px-3 py-3 text-left transition-colors',
                    current ? 'bg-ink text-white' : 'text-ink hover:bg-bone',
                  )}
                >
                  <span className="flex items-center gap-2">
                    <Icon
                      className={cn('size-4 shrink-0', current ? 'text-white' : 'text-graphite')}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 text-sm leading-snug font-semibold">
                      {DRAFT_FORMATS[f].label}
                    </span>
                    {unsaved.has(f) ? (
                      <>
                        <span
                          aria-hidden
                          className={cn(
                            'size-2 shrink-0 rounded-full',
                            current ? 'bg-signal' : 'bg-ink',
                          )}
                        />
                        <span className="sr-only">, unsaved changes</span>
                      </>
                    ) : null}
                  </span>
                  <span
                    className={cn(
                      'mt-1 block pl-6 text-xs leading-normal',
                      current ? 'text-white/70' : 'text-slate',
                    )}
                  >
                    {limitText(f)}
                  </span>
                  <span className="mt-1.5 flex flex-col pl-6 text-xs leading-normal">
                    <StatusLines status={formatStatus(view.formats[f])} current={current} />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {unsaved.size ? (
          <p className="mt-3 flex items-center gap-2 px-3 text-xs text-slate">
            <span aria-hidden className="size-2 rounded-full bg-ink" />
            Unsaved changes
          </p>
        ) : null}

        <section
          aria-labelledby="working-from-title"
          className="mx-3 mt-6 border-t border-hairline pt-5"
        >
          <h2 id="working-from-title" className="masthead text-xl tracking-[0.02em]">
            Working from
          </h2>
          {view.research.briefs ? (
            <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-[0.8125rem] leading-snug">
              <dt className="text-slate">Research</dt>
              <dd className="text-ink">
                {plural(view.research.briefs, 'briefing', 'briefings')}
                {view.research.latestAt ? ` · ${formatDayMonth(view.research.latestAt)}` : ''}
              </dd>
              {/* The drafts view holds the sources the drafts cite, not every source the research found. */}
              <dt className="text-slate">Drafts cite</dt>
              <dd className="text-ink">
                {!started
                  ? 'No drafts yet'
                  : sources.length
                    ? `${plural(sources.length, 'source', 'sources')}${fromResearch ? `, ${fromResearch} from research` : ''}`
                    : 'No sources'}
              </dd>
              <dt className="text-slate">To confirm</dt>
              <dd className={toConfirm ? 'font-medium text-amber' : 'text-ink'}>
                {toConfirm ? plural(toConfirm, 'open point', 'open points') : 'None listed'}
              </dd>
            </dl>
          ) : (
            <p className="mt-2 text-[0.8125rem] leading-normal text-graphite">
              Not researched yet. Drafts are written from the research, so their statements can be
              traced to its sources.
            </p>
          )}
          <Link
            href={`/stories/${storyId}/research`}
            className="text-link mt-3 inline-flex min-h-9 items-center gap-1.5 rounded-sm text-[0.8125rem] font-semibold text-ink"
          >
            Open the research
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        </section>
      </div>
    </nav>
  );
}
