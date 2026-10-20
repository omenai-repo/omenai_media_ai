import type { DraftFormatDto } from '@repo/core';
import { DRAFT_FORMATS, type DraftFormat } from '@repo/shared';

/** A format's length target: "About 150–300 words" or "Up to 280 characters". */
export function limitText(format: DraftFormat): string {
  const { limit } = DRAFT_FORMATS[format];
  return limit.unit === 'characters'
    ? `Up to ${limit.max.toLocaleString('en-GB')} characters`
    : `About ${limit.min.toLocaleString('en-GB')}–${limit.max.toLocaleString('en-GB')} words`;
}

export type FormatStatus =
  | { kind: 'empty' }
  | { kind: 'failed' }
  /** `next`: the version number being written. */
  | { kind: 'writing'; next: number }
  | {
      kind: 'drafted';
      versions: number;
      latestAt: string;
      /**
       * Whether the latest version's own statements were source-checked as it was written. An
       * edited or restored version never inherits the checks of the version it came from.
       */
      checked: boolean;
      /** A request made after the latest version didn't finish. */
      failedSince: boolean;
    };

/** Where a format stands, read only from its records. */
export function formatStatus(
  entry: Pick<DraftFormatDto, 'versions' | 'activeTask' | 'lastFailure'>,
): FormatStatus {
  const latest = entry.versions[0];
  if (entry.activeTask) return { kind: 'writing', next: (latest?.version ?? 0) + 1 };
  if (latest)
    return {
      kind: 'drafted',
      versions: entry.versions.length,
      latestAt: latest.createdAt,
      checked: latest.checksFrom === latest.version && latest.claims.length > 0,
      failedSince: entry.lastFailure !== null,
    };
  if (entry.lastFailure) return { kind: 'failed' };
  return { kind: 'empty' };
}
