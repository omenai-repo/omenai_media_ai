import { getRunDetail, NotFoundError, type RunDetailDto } from '@repo/core';
import { emptyFunnel, plainCheck, type RunFunnel } from '@repo/shared';
import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';

import {
  editionIntro,
  editionName,
  outcomeTone,
  runStatus,
  shortfallPlain,
} from '@/components/editorial/copy';
import { formatDateTime } from '@/components/editorial/format';
import {
  Disclosure,
  Figure,
  MetaLine,
  PageMasthead,
  Section,
  StatusLabel,
  StatusNote,
} from '@/components/editorial/primitives';
import { UsageTable } from '@/components/editorial/usage';
import { Skeleton } from '@/components/ui/skeleton';
import { requirePageUser } from '@/lib/session';

export const metadata: Metadata = { title: 'Edition details' };

const FUNNEL_ROWS: Array<[Exclude<keyof RunFunnel, 'gateRejectsByGate'>, string]> = [
  ['searchQueries', 'Searches made'],
  ['searchFailures', 'Searches that failed'],
  ['discovered', 'Articles found'],
  ['newArticles', 'New articles'],
  ['revisited', 'Earlier articles checked again'],
  ['changed', 'Earlier articles that had changed'],
  ['extractionFailures', 'Articles that couldn’t be read'],
  ['inScope', 'Within our subject areas'],
  ['candidates', 'Stories formed from them'],
  ['evaluated', 'Stories assessed'],
  ['evaluationFailures', 'Stories that couldn’t be assessed'],
  ['deferredLate', 'Carried to the next edition'],
  ['gateHolds', 'Need checking first'],
  ['gateRejects', 'Didn’t pass our editorial checks'],
  ['suppressedRepeats', 'Already covered'],
  ['belowThreshold', 'Below our bar'],
  ['qualified', 'Met our standards'],
  ['shortlisted', 'Recommended'],
];

function RunBody({ run }: { run: RunDetailDto }) {
  const funnel = run.funnel ?? emptyFunnel();
  const status = runStatus(run.status);
  const checkBreakdown = run.shortfallReasons.find((r) => r.code === 'editorial_gates')?.breakdown;

  return (
    <div className="fade-in">
      <Link
        href="/operations"
        className="meta mb-8 inline-flex items-center gap-1.5 rounded-sm hover:text-ink"
      >
        <ArrowLeft className="size-4" aria-hidden /> Operations
      </Link>
      <PageMasthead
        eyebrow={run.trigger === 'manual' ? 'Started by hand' : 'Nightly edition'}
        title={editionName(run.runKey)}
        size="md"
        aside={<StatusLabel tone={status.tone}>{status.label}</StatusLabel>}
      >
        <p>{editionIntro(run)}</p>
        <MetaLine
          className="mt-3 font-sans"
          items={[
            run.startedAt ? `Started ${formatDateTime(run.startedAt)}` : null,
            run.completedAt ? `Finished ${formatDateTime(run.completedAt)}` : null,
          ]}
        />
      </PageMasthead>

      {run.status === 'failed' ? (
        <StatusNote tone="problem" title="This search stopped before finishing." className="mt-8">
          The technical detail is under “Problems” below. The next start picks up where it left off.
        </StatusNote>
      ) : null}

      <div className="mt-10 grid max-w-3xl grid-cols-3 gap-6">
        <Figure value={run.articlesFound} label="Articles found" />
        <Figure value={run.storiesReviewed} label="Stories reviewed" />
        <Figure value={run.shortlisted} label="Recommended" />
      </div>

      {run.shortfallReasons.length ? (
        <div className="mt-8 max-w-3xl">
          <h2 className="mb-2 text-sm font-medium text-ink">Why we found fewer stories</h2>
          <ul className="grid gap-1 text-graphite">
            {run.shortfallReasons.map((reason) => (
              <li key={reason.code}>{shortfallPlain(reason)}</li>
            ))}
          </ul>
          {checkBreakdown && Object.keys(checkBreakdown).length ? (
            <p className="meta mt-2">
              Most common reasons a story didn’t pass:{' '}
              {Object.entries(checkBreakdown)
                .toSorted((a, b) => b[1] - a[1])
                .map(([gate, count]) => `${plainCheck(gate)} (${count})`)
                .join('; ')}
              .
            </p>
          ) : null}
        </div>
      ) : null}

      <Section title="Every story reviewed" className="mt-14">
        {run.outcomes.length === 0 ? (
          <p className="meta">No stories were reviewed in this edition.</p>
        ) : (
          <ul className="divide-y divide-hairline border-b border-hairline">
            {run.outcomes.map((o) => (
              <li key={o.storyId} className="grid gap-2 py-4 md:grid-cols-12 md:gap-8">
                <p className="md:col-span-7">
                  <Link
                    href={`/stories/${o.storyId}`}
                    className="headline-link font-display text-xl leading-snug text-ink"
                  >
                    {o.headline}
                  </Link>
                </p>
                <div className="md:col-span-5">
                  <StatusLabel
                    tone={
                      o.outcome === 'qualified' && !o.recommended ? 'info' : outcomeTone(o.outcome)
                    }
                  >
                    {o.reason}
                  </StatusLabel>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Technical details"
        description="For whoever looks after the newsroom’s systems."
        className="mt-14"
      >
        <Disclosure summary="Step by step" hint="From searches to recommendations">
          <dl className="max-w-md divide-y divide-hairline text-sm">
            {FUNNEL_ROWS.map(([key, label]) => (
              <div key={key} className="flex justify-between gap-4 py-1.5">
                <dt className="text-graphite">{label}</dt>
                <dd className="text-ink tabular-nums">{funnel[key]}</dd>
              </div>
            ))}
          </dl>
        </Disclosure>
        <Disclosure
          summary="Problems"
          hint={
            run.errors.length + run.failedTasks.length
              ? `${run.errors.length + run.failedTasks.length} recorded`
              : 'None recorded'
          }
        >
          {run.errors.length || run.failedTasks.length ? (
            <ul className="grid gap-2">
              {run.errors.map((e, i) => (
                <li key={`e-${i}`} className="font-mono text-xs break-words text-graphite">
                  [{e.stage}] {formatDateTime(e.at)}: {e.message}
                </li>
              ))}
              {run.failedTasks.map((t) => (
                <li key={t.key} className="font-mono text-xs break-words text-graphite">
                  {t.key} · {t.attempts} attempt(s): {t.lastError}
                </li>
              ))}
            </ul>
          ) : (
            <p className="meta">No problems were recorded.</p>
          )}
        </Disclosure>
        <Disclosure summary="Outcome codes" hint="As stored">
          <ul className="grid gap-1 font-mono text-xs text-graphite">
            {run.outcomes.map((o) => (
              <li key={o.storyId} className="break-words">
                {o.storyId} · {o.outcome}
                {o.score !== null ? ` · score ${o.score}` : ''}
                {o.detail ? ` · ${o.detail}` : ''}
              </li>
            ))}
          </ul>
        </Disclosure>
        <Disclosure summary="Timing" hint="Deadlines for this edition">
          <dl className="grid max-w-md gap-1 text-sm">
            {[
              ['Started', run.startedAt],
              ['Stopped accepting new stories', run.candidateSetClosedAt],
              ['Finished', run.completedAt],
              ['Target finish', run.deadlines.soft],
              ['Latest finish allowed', run.deadlines.hard],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4">
                <dt className="text-graphite">{label}</dt>
                <dd className="text-ink">{formatDateTime(value ?? null)}</dd>
              </div>
            ))}
          </dl>
        </Disclosure>
        <Disclosure summary="Usage for this edition" hint="Requests, tokens and credits">
          <UsageTable rows={run.usage} />
        </Disclosure>
      </Section>
    </div>
  );
}

async function Run({ params }: Pick<PageProps<'/operations/runs/[runKey]'>, 'params'>) {
  await requirePageUser('runs:read');
  const { runKey } = await params;
  const run = await getRunDetail(decodeURIComponent(runKey)).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  return <RunBody run={run} />;
}

export default function RunPage({ params }: PageProps<'/operations/runs/[runKey]'>) {
  return (
    <Suspense
      fallback={
        <div className="space-y-6" aria-busy="true" aria-label="Loading the edition details">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-12 w-1/2" />
          <Skeleton className="h-64 w-full" />
        </div>
      }
    >
      <Run params={params} />
    </Suspense>
  );
}
