'use client';

import type { RunSummaryDto } from '@repo/core';
import { useRouter } from 'next/navigation';

import { editionName } from './copy';

/** Switches to an earlier edition. A native select: accessible and keyboard-friendly as-is. */
export function EditionPicker({ runs, current }: { runs: RunSummaryDto[]; current: string }) {
  const router = useRouter();
  if (runs.length < 2) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="edition-picker" className="meta">
        Read an earlier edition
      </label>
      <select
        id="edition-picker"
        value={current}
        onChange={(event) => router.push(`/?run=${encodeURIComponent(event.target.value)}`)}
        className="h-10 min-w-64 rounded-md border border-input bg-ivory px-3 text-sm text-ink transition-colors hover:border-rule-strong"
      >
        {runs.map((run) => (
          <option key={run.runKey} value={run.runKey}>
            {editionName(run.runKey)} · {run.shortlisted} recommended
          </option>
        ))}
      </select>
    </div>
  );
}
