'use client';

import type { DraftVersionDto, DraftsViewDto } from '@repo/core';
import { Lightbulb, TextQuote, TriangleAlert } from 'lucide-react';

import { formatDateTime } from '@/components/editorial/format';
import { Citation } from '@/components/research/citation';
import { cn } from '@/lib/utils';

/** "Written by Omenai", "Edited by Ifeoma Bello", "Restored version 1". */
export function versionOrigin(version: DraftVersionDto): string {
  if (version.restoredFrom !== null) return `Version ${version.restoredFrom} restored`;
  if (version.origin === 'edited') return `Edited by ${version.author}`;
  return version.basedOnVersion !== null
    ? `Revised by Omenai for ${version.author}`
    : `Written by Omenai for ${version.author}`;
}

/**
 * What each status actually establishes. "Found" means the quoted passage is in the stored source
 * word for word: it shows where a statement came from, not that it is true or that the passage
 * supports it, so it never gets a tick or the word "verified".
 */
const CHECK = {
  verified: {
    icon: TextQuote,
    tone: 'text-moss',
    label: 'Quoted passage found in the source. Read it to confirm it supports this.',
  },
  excerpt_not_located: {
    icon: TriangleAlert,
    tone: 'text-amber',
    label: 'Quoted passage not found in the source. Treat this as unconfirmed until you check it.',
  },
  detail_not_in_excerpt: {
    icon: TriangleAlert,
    tone: 'text-amber',
    label:
      'Quoted passage found, but it doesn’t contain the date, figure or quoted words in this statement. Check it before you use it.',
  },
  excerpt_unrelated: {
    icon: TriangleAlert,
    tone: 'text-amber',
    label:
      'Quoted passage found, but it doesn’t seem to be about this statement. Check that it supports it before you use it.',
  },
  conflicting: {
    icon: TriangleAlert,
    tone: 'text-amber',
    label:
      'Quoted passage found, but another statement’s source gives a different date or figure. Check which is right before you use it.',
  },
  uncited: {
    icon: Lightbulb,
    tone: 'text-graphite',
    label: 'Omenai’s interpretation. It cites no source.',
  },
} as const;

/**
 * What to check before using the draft. This is a source check, not a fact-check: for each
 * statement Omenai listed, whether the passage it quoted is in the stored source. Statements it
 * didn't list aren't checked at all, and the panel says so first. An edited version has no checks
 * of its own, so it shows those of the version it came from, and says that too.
 */
export function ChecksPanel({
  shown,
  checked,
  view,
}: {
  shown: DraftVersionDto;
  checked: DraftVersionDto | null;
  view: DraftsViewDto;
}) {
  const claims = checked?.claims ?? [];
  const sourceFor = (label: string) => checked?.sources.find((s) => s.label === label)?.sourceId;
  const sourced = claims.filter((c) => c.citationStatus !== 'uncited').length;
  const located = claims.filter((c) => c.citationStatus === 'verified').length;
  const count = (status: (typeof claims)[number]['citationStatus']) =>
    claims.filter((c) => c.citationStatus === status).length;
  const notFound = count('excerpt_not_located');
  const missingDetail = count('detail_not_in_excerpt');
  const unrelated = count('excerpt_unrelated');
  const conflicting = count('conflicting');
  // An edited version has no checks of its own: those shown belong to the text it came from.
  const earlier = checked !== null && checked.version !== shown.version;
  return (
    <div className="space-y-5 text-[0.9375rem] leading-relaxed">
      {earlier ? (
        <p className="rounded-md bg-amber-wash/70 px-3 py-2.5 text-sm text-ink">
          This version’s text hasn’t been checked. The checks below belong to version{' '}
          {checked.version}, which this one comes from; anything changed since then hasn’t been
          checked.
        </p>
      ) : null}
      <p className="rounded-md bg-bone/60 px-3 py-2.5 text-sm text-ink">
        <span className="font-semibold">A source check, not a fact-check.</span> For each statement
        Omenai listed, we looked for the passage it quoted in the stored source. A match shows where
        the statement came from, not that it’s correct. Anything in the draft that isn’t listed here
        hasn’t been checked at all.
      </p>
      {claims.length ? (
        <section
          aria-label={earlier ? `Checks for version ${checked.version}` : 'Checks'}
          className={cn('space-y-5', earlier && 'rounded-md border border-hairline p-3')}
        >
          {earlier ? (
            <h3 className="text-sm font-semibold text-ink">
              Checks for version {checked.version}, as first written
            </h3>
          ) : null}
          <p className="text-graphite">
            {located < sourced ? (
              <span className="font-medium text-ink">
                Some details still need to be confirmed.{' '}
              </span>
            ) : null}
            {sourced
              ? `Quoted passage found for ${located} of ${sourced} sourced ${sourced === 1 ? 'statement' : 'statements'}${notFound ? `; not found for ${notFound}` : ''}${missingDetail ? `; found without its date, figure or quoted words for ${missingDetail}` : ''}${unrelated ? `; found but about something else for ${unrelated}` : ''}${conflicting ? `; contradicted by another source for ${conflicting}` : ''}.`
              : 'None of the listed statements cites a source.'}
          </p>
          <ol className="space-y-3">
            {claims.map((claim, i) => {
              const check = CHECK[claim.citationStatus];
              const Icon = check.icon;
              return (
                <li key={i} className="flex gap-2.5">
                  <Icon className={cn('mt-1 size-3.5 shrink-0', check.tone)} aria-hidden />
                  <div className="min-w-0">
                    <p className="font-serif text-ink">
                      {claim.text}
                      {claim.sourceLabels.map((label, j) => (
                        <Citation
                          key={label}
                          label={label}
                          source={(() => {
                            const id = sourceFor(label);
                            return id ? view.sources[id] : undefined;
                          })()}
                          excerpt={j === 0 ? claim.excerpt : null}
                          status={claim.citationStatus}
                          also={j > 0}
                        />
                      ))}
                    </p>
                    <p className="mt-0.5 text-xs text-graphite">{check.label}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ) : (
        <p className="text-graphite">
          Omenai listed no statements for this version, so nothing in it has been checked. Check its
          facts against the research before using it.
        </p>
      )}
      {checked?.droppedClaims ? (
        <p className="flex gap-2 text-sm text-ink">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber" aria-hidden />
          {checked.droppedClaims === 1
            ? 'One statement cited a source we don’t hold and was left out of these checks. Look for it in the draft.'
            : `${checked.droppedClaims} statements cited sources we don’t hold and were left out of these checks. Look for them in the draft.`}
        </p>
      ) : null}

      {view.research.toConfirm.length ? (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-ink">
            Still to confirm from the research
          </h3>
          <ul className="list-disc space-y-1 pl-5 text-graphite marker:text-amber">
            {view.research.toConfirm.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="border-t border-hairline-soft pt-4 text-sm text-graphite">
        Nothing is published from here. Image credit and rights aren’t confirmed; check them before
        using a picture.
      </p>
    </div>
  );
}

/** Every version, newest first. Choosing one shows it in the editor; nothing is ever deleted. */
export function VersionHistory({
  versions,
  shown,
  onSelect,
}: {
  versions: DraftVersionDto[];
  shown: number | null;
  onSelect: (version: number) => void;
}) {
  return (
    <ol className="divide-y divide-hairline-soft">
      {versions.map((version) => {
        const current = version.version === shown;
        return (
          <li key={version.id}>
            <button
              type="button"
              onClick={() => onSelect(version.version)}
              aria-current={current ? 'true' : undefined}
              className={cn(
                '-mx-2 block w-[calc(100%+1rem)] rounded-md px-2 py-3 text-left transition-colors hover:bg-bone/50',
                current && 'bg-bone/60',
              )}
            >
              <span className="flex items-baseline justify-between gap-3">
                <span className="font-medium text-ink">
                  Version {version.version}
                  {version === versions[0] ? (
                    <span className="ml-2 text-xs font-normal text-moss">Latest</span>
                  ) : null}
                </span>
                <span className="meta shrink-0">{formatDateTime(version.createdAt)}</span>
              </span>
              <span className="mt-0.5 block text-sm text-graphite">
                {versionOrigin(version)}
                {version.origin === 'edited' &&
                version.restoredFrom === null &&
                version.basedOnVersion !== null
                  ? `, from version ${version.basedOnVersion}`
                  : ''}
                {version.origin === 'generated' && version.basedOnVersion !== null
                  ? `, from version ${version.basedOnVersion}`
                  : ''}
              </span>
              {version.instructions ? (
                <span className="mt-1 block text-sm text-ink italic">“{version.instructions}”</span>
              ) : null}
              {version.shortened ? (
                <span className="mt-1 block text-xs text-graphite">Shortened to fit</span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
