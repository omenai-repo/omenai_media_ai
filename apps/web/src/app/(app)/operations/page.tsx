import {
  getOperationsOverview,
  isFixtureRuntime,
  readRuntime,
  listRuns,
  type AttentionItem,
  type OperationsOverviewDto,
  type RunSummaryDto,
} from '@repo/core';
import { ArrowRight, ChevronRight, CircleAlert, RefreshCw, TriangleAlert } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense, type ReactNode } from 'react';

import {
  attentionAction,
  attentionLink,
  attentionTitle,
  editionName,
  progressLine,
  retryProgress,
  runStatus,
  shortfallPlain,
  type Tone,
} from '@/components/editorial/copy';
import { FindStoriesButton } from '@/components/editorial/find-stories-button';
import { formatDateTime } from '@/components/editorial/format';
import { Disclosure, PageMasthead, Section, StatusLabel } from '@/components/editorial/primitives';
import { groupFigure, totalFigure, UsageSummary } from '@/components/editorial/usage';
import { Skeleton } from '@/components/ui/skeleton';
import { requirePageUser } from '@/lib/session';
import { cn } from '@/lib/utils';

export const metadata: Metadata = { title: 'Operations' };

const runHref = (runKey: string) => `/operations/runs/${encodeURIComponent(runKey)}`;
const BLOCKING = new Set(['run_failed', 'run_stuck']);

const TONE_DOT: Record<Tone, string> = {
  done: 'bg-moss',
  info: 'bg-stone',
  attention: 'bg-amber',
  problem: 'bg-oxide',
};

/** One question an owner asks, answered in a sentence, with the detail one step away. */
function Answer({
  question,
  tone,
  answer,
  children,
  link,
  className,
}: {
  question: string;
  tone: Tone;
  answer: ReactNode;
  children?: ReactNode;
  link?: { href: string; label: string };
  className?: string;
}) {
  return (
    <section aria-label={question} className={cn('surface flex flex-col p-5 sm:p-6', className)}>
      <p className="meta flex items-center gap-2">
        <span aria-hidden className={cn('size-2 rounded-full', TONE_DOT[tone])} />
        {question}
      </p>
      <p className="mt-3 font-display text-[1.5rem] leading-tight text-ink">{answer}</p>
      {children ? (
        <div className="mt-2 text-[0.9375rem] leading-relaxed text-graphite">{children}</div>
      ) : null}
      {link ? (
        <Link
          href={link.href}
          className="group/link mt-auto inline-flex items-center gap-1.5 self-start rounded-sm pt-4 text-sm font-medium text-ink"
        >
          {link.label}
          <ArrowRight
            className="size-3.5 text-ochre transition-transform group-hover/link:translate-x-0.5"
            aria-hidden
          />
        </Link>
      ) : null}
    </section>
  );
}

/**
 * Problems that need someone (most urgent first), or work that is still correcting itself. The
 * server decides which is which (`automatic`), so a retry that has run out of attempts or gone
 * quiet moves from the second list to the first on its own.
 */
function AttentionList({
  items,
  owner,
  scheduled,
}: {
  items: AttentionItem[];
  owner: boolean;
  scheduled: boolean;
}) {
  return (
    <ul className="surface divide-y divide-hairline-soft">
      {items.map((item, index) => {
        const tone: Tone = item.automatic
          ? 'info'
          : item.kind === 'run_failed'
            ? 'problem'
            : 'attention';
        const Icon = tone === 'problem' ? CircleAlert : tone === 'info' ? RefreshCw : TriangleAlert;
        const link = attentionLink(item);
        const progress = item.automatic ? retryProgress(item) : null;
        return (
          <li key={`${item.kind}-${item.runKey ?? ''}-${index}`} className="flex gap-3 px-5 py-4">
            <Icon
              aria-hidden
              className={cn(
                'mt-0.5 size-4 shrink-0',
                tone === 'problem'
                  ? 'text-oxide'
                  : tone === 'info'
                    ? 'text-graphite'
                    : 'text-amber',
              )}
            />
            <div className="min-w-0 flex-1">
              {item.automatic ? (
                <p className="mb-1 text-sm font-medium text-graphite">
                  Retrying automatically{progress ? ` · ${progress}` : ''}
                </p>
              ) : null}
              <p className="font-medium text-ink">{attentionTitle(item)}</p>
              <p className="mt-1 text-[0.9375rem] leading-relaxed text-graphite">
                {attentionAction(item, owner, scheduled)}
              </p>
              <p className="meta mt-1.5">
                {[
                  link ? (
                    <Link key="link" href={link.href} className="underline decoration-ochre">
                      {link.label}
                    </Link>
                  ) : null,
                  item.runKey ? (
                    <Link
                      key="run"
                      href={runHref(item.runKey)}
                      className="underline decoration-ochre"
                    >
                      {editionName(item.runKey)}
                    </Link>
                  ) : null,
                  item.at ? <span key="at">{formatDateTime(item.at)}</span> : null,
                ]
                  .filter(Boolean)
                  .flatMap((node, i) => (i ? [<span key={`sep-${i}`}> · </span>, node] : [node]))}
              </p>
              <details className="disclosure group mt-1">
                <summary className="meta inline-flex cursor-pointer list-none items-center gap-1 rounded-sm py-1 hover:text-ink [&::-webkit-details-marker]:hidden">
                  <ChevronRight
                    aria-hidden
                    className="size-3.5 transition-transform group-open:rotate-90"
                  />
                  Technical detail
                </summary>
                <pre className="mt-1 rounded-md bg-bone/60 p-3 font-mono text-xs leading-relaxed wrap-break-word whitespace-pre-wrap text-graphite group-open:rise-in">
                  {item.detail}
                </pre>
              </details>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function LatestEdition({
  latest,
  owner,
  scheduled,
}: {
  latest: RunSummaryDto | null;
  owner: boolean;
  scheduled: boolean;
}) {
  if (!latest)
    return (
      <Answer question="Did the latest edition finish?" tone="info" answer="No edition yet.">
        {scheduled ? (
          <>
            The first search runs at midnight, Chicago time
            {owner ? ', or start one now with “Find today’s stories”.' : '.'}
          </>
        ) : owner ? (
          'Start the first search with “Find today’s stories”.'
        ) : (
          'An owner starts searches in this development newsroom.'
        )}
      </Answer>
    );
  if (latest.status === 'completed')
    return (
      <Answer
        question="Did the latest edition finish?"
        tone="done"
        answer="Your latest edition is ready."
        link={{ href: `/?run=${encodeURIComponent(latest.runKey)}`, label: 'Read it' }}
      >
        {editionName(latest.runKey)}
        {latest.completedAt ? `, ready ${formatDateTime(latest.completedAt)}` : ''}.
      </Answer>
    );
  if (latest.status === 'failed')
    return (
      <Answer
        question="Did the latest edition finish?"
        tone="problem"
        answer="The latest search didn’t finish."
        link={{ href: runHref(latest.runKey), label: 'See what happened' }}
      >
        {editionName(latest.runKey)}. What to do is under “Needs attention” below.
      </Answer>
    );
  return (
    <Answer
      question="Did the latest edition finish?"
      tone="info"
      answer="Today’s edition is being prepared."
      link={{ href: runHref(latest.runKey), label: 'Follow its progress' }}
    >
      {progressLine(latest.progress) ?? 'Working'}
      {latest.startedAt ? `, started ${formatDateTime(latest.startedAt)}` : ''}.
    </Answer>
  );
}

function EnoughStories({ edition }: { edition: RunSummaryDto | undefined }) {
  if (!edition)
    return (
      <Answer question="Did we find enough useful stories?" tone="info" answer="Not yet known.">
        No edition has finished yet.
      </Answer>
    );
  const short = edition.shortfallReasons.length > 0;
  return (
    <Answer
      question="Did we find enough useful stories?"
      tone={edition.shortlisted === 0 ? 'attention' : short ? 'info' : 'done'}
      answer={
        edition.shortlisted === 0
          ? 'None met our standards.'
          : `${edition.shortlisted} recommended from ${edition.storiesReviewed} reviewed.`
      }
      link={{ href: runHref(edition.runKey), label: 'Every story reviewed' }}
    >
      {short ? (
        <>
          A smaller edition. {shortfallPlain(edition.shortfallReasons[0]!)} The bar is never lowered
          to fill it.
        </>
      ) : (
        <>{editionName(edition.runKey)}.</>
      )}
    </Answer>
  );
}

/**
 * The nightly schedule runs only in production. Development (live or fixtures) never searches on
 * its own, and the card says so rather than promising a midnight edition that won't come.
 */
function NextEdition({ latest, scheduled }: { latest: RunSummaryDto | null; scheduled: boolean }) {
  const running = latest?.status === 'running' || latest?.status === 'queued';
  if (!scheduled)
    return (
      <Answer
        question="Is the next edition on track?"
        tone="info"
        answer="No nightly edition here."
      >
        This is a development newsroom: searches run only when an owner starts one with “Find
        today’s stories”. English-language sources only, for now.
      </Answer>
    );
  return (
    <Answer
      question="Is the next edition on track?"
      tone={latest?.status === 'failed' ? 'attention' : 'info'}
      answer="Scheduled for midnight, Chicago time."
    >
      {running
        ? 'Today’s edition is still being prepared; the next follows at midnight.'
        : latest?.status === 'failed'
          ? 'Tonight’s run will try again.'
          : 'It runs on its own every night.'}{' '}
      English-language sources only, for now.
    </Answer>
  );
}

function Spending({ usage }: { usage: OperationsOverviewDto['usage'] }) {
  const { reported, simulated } = usage;
  return (
    <Answer
      question="What are we using?"
      tone={reported.groups.some((g) => g.unreportedCalls) ? 'attention' : 'info'}
      answer={
        reported.groups.length
          ? totalFigure(reported) === 'Not available yet'
            ? 'Cost estimate not available yet.'
            : `${totalFigure(reported)} estimated, last ${usage.days} days.`
          : `No usage reported in the last ${usage.days} days.`
      }
      link={{ href: '#usage', label: 'Usage details' }}
      className="sm:col-span-2"
    >
      {reported.groups.length ? (
        <ul className="grid gap-0.5">
          {reported.groups.map((group) => {
            const figure = groupFigure(group);
            return (
              <li key={group.group}>
                {group.label}: {figure.quiet ? figure.value.toLowerCase() : `${figure.value} est.`}
              </li>
            );
          })}
        </ul>
      ) : (
        <p>Measured usage appears here once our providers report it.</p>
      )}
      {simulated ? (
        <p className="mt-1">Simulated fixture usage is kept separate and isn’t counted.</p>
      ) : null}
    </Answer>
  );
}

async function Operations() {
  const user = await requirePageUser('runs:read');
  const owner = user.role === 'owner';
  const scheduled = readRuntime() === 'production';
  const [overview, runs] = await Promise.all([getOperationsOverview(), listRuns(30)]);
  const latest = overview.latestRun;
  const latestEdition = runs.find((run) => run.status === 'completed');
  // Needs someone: most urgent first. Self-correcting work is listed apart, never counted here.
  const actionable = [
    ...overview.attention.filter((a) => !a.automatic && BLOCKING.has(a.kind)),
    ...overview.attention.filter((a) => !a.automatic && !BLOCKING.has(a.kind)),
  ];
  const automatic = overview.attention.filter((a) => a.automatic);

  return (
    <>
      <PageMasthead
        eyebrow="Behind the edition"
        title="Operations"
        size="md"
        aside={owner ? <FindStoriesButton fixtures={isFixtureRuntime()} /> : null}
      >
        <p>Whether the newsroom is running properly, in plain words.</p>
      </PageMasthead>

      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <LatestEdition latest={latest} owner={owner} scheduled={scheduled} />
        <EnoughStories edition={latestEdition} />
        <Answer
          question="Does anything need attention?"
          tone={
            actionable.some((a) => a.kind === 'run_failed')
              ? 'problem'
              : actionable.length
                ? 'attention'
                : 'done'
          }
          answer={
            actionable.length
              ? `${actionable.length} ${actionable.length === 1 ? 'thing needs' : 'things need'} attention.`
              : 'Nothing needs your attention.'
          }
          link={
            actionable.length
              ? { href: '#attention', label: 'See what to do' }
              : automatic.length
                ? { href: '#retrying', label: 'See what’s retrying' }
                : undefined
          }
        >
          {actionable.length
            ? 'Each one is listed below with what to do about it.'
            : `Nothing has needed action in the last ${overview.usage.days} days.`}
          {automatic.length
            ? ` ${automatic.length} more ${automatic.length === 1 ? 'is' : 'are'} being retried automatically.`
            : ''}
        </Answer>
        <NextEdition latest={latest} scheduled={scheduled} />
        <Spending usage={overview.usage} />
      </div>

      {actionable.length ? (
        <Section
          id="attention"
          title="Needs attention"
          description={`Last ${overview.usage.days} days, most urgent first.`}
          className="mt-16 max-w-4xl scroll-mt-28"
        >
          <AttentionList items={actionable} owner={owner} scheduled={scheduled} />
        </Section>
      ) : null}

      {automatic.length ? (
        <Section
          id="retrying"
          title="Retrying on its own"
          description="No action needed. If the last attempt fails, or retrying stops, it moves to Needs attention."
          className={cn('max-w-4xl scroll-mt-28', actionable.length ? 'mt-12' : 'mt-16')}
        >
          <AttentionList items={automatic} owner={owner} scheduled={scheduled} />
        </Section>
      ) : null}

      <div className="mt-16 grid max-w-4xl gap-3">
        <Disclosure
          variant="card"
          id="usage"
          summary="Usage and estimated cost"
          hint={`By service, last ${overview.usage.days} days`}
        >
          <UsageSummary
            reported={overview.usage.reported}
            simulated={overview.usage.simulated}
            pricesVerifiedOn={overview.usage.pricesVerifiedOn}
          />
        </Disclosure>
        <Disclosure
          variant="card"
          summary={`Edition history (${runs.length})`}
          hint="Every search, newest first"
        >
          {runs.length ? (
            <ul className="divide-y divide-hairline-soft">
              {runs.map((run) => (
                <li
                  key={run.runKey}
                  className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-0.5 py-3"
                >
                  <Link href={runHref(run.runKey)} className="headline-link text-ink">
                    {editionName(run.runKey)}
                  </Link>
                  <span className="text-right text-sm text-ink tabular-nums">
                    {run.status === 'completed' ? `${run.shortlisted} recommended` : null}
                  </span>
                  <span>
                    <StatusLabel tone={runStatus(run.status).tone}>
                      {runStatus(run.status).label}
                    </StatusLabel>
                  </span>
                  <span className="meta text-right">
                    {formatDateTime(run.completedAt ?? run.startedAt ?? run.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="meta">No editions yet.</p>
          )}
        </Disclosure>
      </div>
    </>
  );
}

export default function OperationsPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-8" aria-busy="true" aria-label="Loading operations">
          <Skeleton className="h-14 w-1/3" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-44 rounded-lg" />
            ))}
          </div>
        </div>
      }
    >
      <Operations />
    </Suspense>
  );
}
