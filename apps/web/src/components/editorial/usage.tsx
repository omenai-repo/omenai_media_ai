import type { UsageGroupDto, UsageRowDto, UsageSummaryDto } from '@repo/core';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

import { compactNumber, formatDate } from './format';
import { Disclosure } from './primitives';

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
});

/** Estimates only: providers don't report billed amounts, so this never claims an actual cost. */
export function formatEstimate(value: number | null): string {
  if (value === null) return 'No estimate';
  if (value === 0) return '$0.00';
  if (value < 0.01) return 'Under $0.01';
  return usd.format(value);
}

/** What a group's figure means, in words: an estimate, free, or not known yet. */
export function groupFigure(group: UsageGroupDto): {
  label: string;
  value: string;
  quiet: boolean;
} {
  if (group.unreportedCalls > 0)
    return { label: 'Not available yet', value: 'Usage not reported', quiet: true };
  if (group.freeTier) return { label: 'Free allowance', value: 'No charge', quiet: true };
  if (group.estimateUsd === null)
    return { label: 'No estimate', value: 'Price not on file', quiet: true };
  return { label: 'Estimate', value: formatEstimate(group.estimateUsd), quiet: false };
}

export function totalFigure(summary: UsageSummaryDto): string {
  if (summary.freeTierOnly) return 'No charge (free allowance)';
  if (summary.estimateUsd === null) return 'Not available yet';
  return formatEstimate(summary.estimateUsd);
}

function UsageGroups({ summary }: { summary: UsageSummaryDto }) {
  return (
    <ul className="divide-y divide-hairline-soft border-y border-hairline-soft">
      {summary.groups.map((group) => {
        const figure = groupFigure(group);
        return (
          <li
            key={group.group}
            className="grid grid-cols-[1fr_auto] items-baseline gap-x-6 gap-y-1 py-4"
          >
            <div>
              <p className="text-ink">{group.label}</p>
              <p className="meta">
                {group.calls} {group.calls === 1 ? 'request' : 'requests'}
                {group.errors ? `, ${group.errors} failed` : ''}
              </p>
            </div>
            <p className="text-right">
              <span className="meta block">{figure.label}</span>
              <span
                className={
                  figure.quiet
                    ? 'text-sm text-ink'
                    : 'masthead text-[1.75rem] leading-none text-ink tabular-nums'
                }
              >
                {figure.value}
              </span>
            </p>
          </li>
        );
      })}
      <li className="grid grid-cols-[1fr_auto] items-baseline gap-x-6 py-4">
        <p className="font-medium text-ink">Total estimate</p>
        <p
          className={
            summary.estimateUsd && !summary.freeTierOnly
              ? 'masthead text-[2.25rem] leading-none text-ink tabular-nums'
              : 'text-ink'
          }
        >
          {totalFigure(summary)}
        </p>
      </li>
    </ul>
  );
}

function Workings({ summary }: { summary: UsageSummaryDto }) {
  return (
    <ul className="grid gap-4">
      {summary.groups.map((group) => (
        <li key={group.group}>
          <p className="text-sm font-medium text-ink">{group.label}</p>
          <p className="meta">
            {[
              group.credits ? `${compactNumber.format(group.credits)} search credits` : null,
              group.tokens ? `${compactNumber.format(group.tokens)} AI tokens` : null,
              group.unreportedCalls
                ? `${group.unreportedCalls} ${group.unreportedCalls === 1 ? 'request' : 'requests'} without reported usage`
                : null,
            ]
              .filter(Boolean)
              .join(' · ') || 'No measurable usage'}
          </p>
          <ul className="meta mt-1 list-disc pl-5">
            {group.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/**
 * Provider-reported usage with estimated cost, and, separately, simulated fixture usage. The two
 * are never added together. Credits, tokens and pricing notes wait behind disclosures.
 */
export function UsageSummary({
  reported,
  simulated,
  pricesVerifiedOn,
}: {
  reported: UsageSummaryDto;
  simulated: UsageSummaryDto | null;
  pricesVerifiedOn: string;
}) {
  return (
    <div className="grid gap-8">
      <div>
        <h3 className="mb-2 text-sm font-medium text-ink">Reported by our providers</h3>
        {reported.groups.length ? (
          <>
            <UsageGroups summary={reported} />
            <Disclosure
              summary="Credits, tokens and how each figure was worked out"
              className="mt-4"
            >
              <Workings summary={reported} />
            </Disclosure>
          </>
        ) : (
          <p className="meta">No usage has been reported by our providers in this period.</p>
        )}
        <p className="meta mt-3 max-w-[70ch]">
          Estimates use list prices checked on {formatDate(`${pricesVerifiedOn}T12:00:00Z`)}. Actual
          charges appear only in each provider’s billing dashboard.
        </p>
      </div>

      {simulated ? (
        <div className="rounded-[14px] border border-dashed border-amber/40 bg-amber-soft/70 p-5">
          <h3 className="text-sm font-medium text-ink">Simulated usage (development fixtures)</h3>
          <p className="meta mt-1 mb-3">
            Invented activity for testing these screens. No provider reported it, and it isn’t
            included in the figures above.
          </p>
          <UsageGroups summary={simulated} />
          <Disclosure summary="How the simulated figures were worked out" className="mt-4">
            <Workings summary={simulated} />
          </Disclosure>
        </div>
      ) : null}
    </div>
  );
}

/** Raw provider usage for one run, for the technical disclosure. */
export function UsageTable({ rows }: { rows: UsageRowDto[] }) {
  if (rows.length === 0) return <p className="meta">No usage recorded.</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Service</TableHead>
          <TableHead>Step</TableHead>
          <TableHead>Model</TableHead>
          <TableHead className="text-right">Requests</TableHead>
          <TableHead className="text-right">Failed</TableHead>
          <TableHead className="text-right">Tokens in</TableHead>
          <TableHead className="text-right">Tokens out</TableHead>
          <TableHead className="text-right">Credits</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={`${row.provider}-${row.operation}-${row.model ?? ''}`}>
            <TableCell className="capitalize">{row.provider}</TableCell>
            <TableCell className="font-mono text-xs">{row.operation}</TableCell>
            <TableCell className="font-mono text-xs">{row.model ?? '—'}</TableCell>
            <TableCell className="text-right tabular-nums">{row.calls}</TableCell>
            <TableCell className="text-right tabular-nums">{row.errors || '—'}</TableCell>
            <TableCell className="text-right tabular-nums">
              {row.inputTokens ? compactNumber.format(row.inputTokens) : '—'}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {row.outputTokens + row.reasoningTokens
                ? compactNumber.format(row.outputTokens + row.reasoningTokens)
                : '—'}
            </TableCell>
            <TableCell className="text-right tabular-nums">{row.units || '—'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
