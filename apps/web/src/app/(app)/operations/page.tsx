import {
  getOperationsOverview,
  isFixtureRuntime,
  readRuntime,
  listRuns,
  type AttentionItem,
  type OperationsOverviewDto,
  type RunningTaskItem,
  type RunSummaryDto,
} from '@repo/core';
import { DRAFT_FORMATS, isDraftFormat } from '@repo/shared';
import {
  ArrowRight,
  ChevronRight,
  CircleAlert,
  FileText,
  Loader2,
  MessagesSquare,
  RefreshCw,
  Search,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense, type ReactNode } from 'react';

import {
  attentionAction,
  attentionLink,
  attentionTitle,
  recoveryLabel,
  editionName,
  progressLine,
  retryProgress,
  runStatus,
  shortfallPlain,
  workKind,
  workName,
  type Tone,
} from '@/components/editorial/copy';
import { FindStoriesButton } from '@/components/editorial/find-stories-button';
import { formatDateTime, formatTime } from '@/components/editorial/format';
import { PageMasthead } from '@/components/editorial/primitives';
import { RefreshButton } from '@/components/editorial/refresh-button';
import { groupFigure, totalFigure, UsageSummary } from '@/components/editorial/usage';
import { chatSteps, draftSteps, researchSteps, type StepView } from '@/components/progress/steps';
import { Skeleton } from '@/components/ui/skeleton';
import { requirePageUser } from '@/lib/session';
import { cn } from '@/lib/utils';

export const metadata: Metadata = { title: 'Operations' };

const runHref = (runKey: string) => `/operations/runs/${encodeURIComponent(runKey)}`;
const BLOCKING = new Set(['run_failed', 'run_stuck']);

/** Colour only for an outcome: done, a warning, a failure. Everything else is ink or grey. */
const TONE_DOT: Record<Tone, string> = {
  done: 'bg-moss',
  info: 'bg-stone',
  attention: 'bg-amber',
  problem: 'bg-oxide',
};
const TONE_TEXT: Record<Tone, string> = {
  done: 'text-ink',
  info: 'text-ink',
  attention: 'text-amber',
  problem: 'text-oxide',
};

/** One question an owner asks, answered in a word or two, with a sentence and the next step. */
function Glance({
  question,
  tone,
  value,
  children,
  link,
  className,
}: {
  question: string;
  tone: Tone;
  value: ReactNode;
  children?: ReactNode;
  link?: { href: string; label: string };
  className?: string;
}) {
  return (
    <section aria-label={question} className={cn('flex min-w-0 flex-col bg-ivory p-5', className)}>
      <p className="flex items-center gap-[7px] text-[0.78125rem] text-graphite">
        <span aria-hidden className={cn('size-[7px] shrink-0 rounded-full', TONE_DOT[tone])} />
        {question}
      </p>
      <p
        className={cn(
          'masthead mt-2 text-[2.125rem] leading-[0.9] [&_small]:text-xl [&_small]:text-slate',
          TONE_TEXT[tone],
        )}
      >
        {value}
      </p>
      {children ? (
        <div className="mt-1.5 text-[0.84375rem] leading-normal text-graphite">{children}</div>
      ) : null}
      {link ? (
        <Link
          href={link.href}
          className="text-link mt-auto self-start rounded-sm pt-2 text-[0.84375rem] font-semibold text-ink"
        >
          {link.label}
        </Link>
      ) : null}
    </section>
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
  const question = 'Did the latest edition finish?';
  if (!latest)
    return (
      <Glance question={question} tone="info" value="None yet">
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
      </Glance>
    );
  if (latest.status === 'completed')
    return (
      <Glance
        question={question}
        tone="done"
        value="Ready"
        link={{ href: `/?run=${encodeURIComponent(latest.runKey)}`, label: 'Read it' }}
      >
        {editionName(latest.runKey)}
        {latest.completedAt ? `, ready ${formatDateTime(latest.completedAt)}` : ''}.
      </Glance>
    );
  if (latest.status === 'failed')
    return (
      <Glance
        question={question}
        tone="problem"
        value="Stopped"
        link={{ href: runHref(latest.runKey), label: 'See what happened' }}
      >
        {editionName(latest.runKey)}. What to do is under “Needs attention” below.
      </Glance>
    );
  return (
    <Glance
      question={question}
      tone="info"
      value="In progress"
      link={{ href: runHref(latest.runKey), label: 'Follow its progress' }}
    >
      {progressLine(latest.progress) ?? 'Working'}
      {latest.startedAt ? `, started ${formatDateTime(latest.startedAt)}` : ''}.
    </Glance>
  );
}

function EnoughStories({ edition }: { edition: RunSummaryDto | undefined }) {
  const question = 'Did we find enough useful stories?';
  if (!edition)
    return (
      <Glance question={question} tone="info" value="Not yet">
        No edition has finished yet.
      </Glance>
    );
  const short = edition.shortfallReasons.length > 0;
  return (
    <Glance
      question={question}
      tone={edition.shortlisted === 0 ? 'attention' : short ? 'info' : 'done'}
      value={
        edition.shortlisted === 0 ? (
          'None'
        ) : (
          <>
            {edition.shortlisted} <small>of {edition.storiesReviewed}</small>
          </>
        )
      }
      link={{ href: runHref(edition.runKey), label: 'Every story reviewed' }}
    >
      {edition.shortlisted === 0
        ? 'None met our standards. '
        : 'Recommended from the stories reviewed. '}
      {short ? (
        <>
          A smaller edition: {shortfallPlain(edition.shortfallReasons[0]!)} The bar is never lowered
          to fill it.
        </>
      ) : (
        <>{editionName(edition.runKey)}.</>
      )}
    </Glance>
  );
}

/**
 * The nightly schedule runs only in production. Development (live or fixtures) never searches on
 * its own, and the cell says so rather than promising a midnight edition that won't come.
 */
function NextEdition({ latest, scheduled }: { latest: RunSummaryDto | null; scheduled: boolean }) {
  const question = 'Is the next edition on track?';
  const running = latest?.status === 'running' || latest?.status === 'queued';
  if (!scheduled)
    return (
      <Glance question={question} tone="info" value="By hand">
        A development newsroom: no nightly edition. Searches run when an owner starts one with “Find
        today’s stories”. English-language sources only, for now.
      </Glance>
    );
  return (
    <Glance
      question={question}
      tone={latest?.status === 'failed' ? 'attention' : 'info'}
      value="Midnight"
    >
      Scheduled for midnight, Chicago time.{' '}
      {running
        ? 'Today’s edition is still being prepared; the next follows at midnight.'
        : latest?.status === 'failed'
          ? 'Tonight’s run will try again.'
          : 'It runs on its own every night.'}{' '}
      English-language sources only, for now.
    </Glance>
  );
}

function Spending({
  usage,
  className,
}: {
  usage: OperationsOverviewDto['usage'];
  className?: string;
}) {
  const { reported, simulated } = usage;
  const total = totalFigure(reported);
  return (
    <Glance
      question="What are we using?"
      tone={reported.groups.some((g) => g.unreportedCalls) ? 'attention' : 'info'}
      value={
        !reported.groups.length ? (
          'None'
        ) : total.startsWith('$') ? (
          <>
            {total} <small>est.</small>
          </>
        ) : (
          <span className="text-2xl">{total}</span>
        )
      }
      link={{ href: '#usage', label: 'Usage details' }}
      className={className}
    >
      {reported.groups.length
        ? `Last ${usage.days} days · ${reported.groups
            .map((group) => {
              const figure = groupFigure(group);
              return `${group.label.toLowerCase()} ${figure.quiet ? figure.value.toLowerCase() : `${figure.value} est.`}`;
            })
            .join(' · ')}.`
        : `No usage reported in the last ${usage.days} days.`}
      {simulated ? ' Simulated fixture usage is kept separate and isn’t counted.' : ''}
    </Glance>
  );
}

const KIND_ICON: Record<string, LucideIcon> = {
  research: Search,
  chat: MessagesSquare,
  generate: FileText,
};

/** The kind of work, as a neutral tag with a quiet mark. */
function KindTag({ kind }: { kind: string | null | undefined }) {
  return (
    <span className="inline-flex h-6 items-center gap-1.5 justify-self-start rounded-full border border-hairline px-2.5 text-xs font-medium whitespace-nowrap text-ink">
      <span
        aria-hidden
        className={cn(
          'size-1.5 rounded-full',
          kind?.startsWith('discovery') || !kind ? 'bg-ink' : 'bg-stone',
        )}
      />
      {workKind(kind)}
    </span>
  );
}

/** "Try 2 of 4" as squares: tries used, the one under way, and those left. */
function Tries({
  attempts,
  tone,
}: {
  attempts: { made: number; limit: number };
  tone: 'retrying' | 'failed';
}) {
  const { made, limit } = attempts;
  return (
    <span className="inline-flex items-center gap-1.5 text-[0.78125rem] whitespace-nowrap text-graphite">
      <span aria-hidden className="inline-flex gap-0.5">
        {Array.from({ length: Math.max(limit, 1) }, (_, i) => (
          <span
            key={i}
            className={cn(
              'size-2 rounded-[2px]',
              tone === 'failed'
                ? i < made
                  ? 'bg-oxide'
                  : 'border border-rule-strong'
                : i < made - 1
                  ? 'bg-stone'
                  : i === made - 1
                    ? 'bg-ink'
                    : 'border border-rule-strong',
            )}
          />
        ))}
      </span>
      {tone === 'failed' ? `${made} of ${limit} tries` : `Try ${made} of ${limit}`}
    </span>
  );
}

const WORK_ROW =
  'grid grid-cols-[2.25rem_minmax(0,1fr)] items-start gap-x-3.5 gap-y-2.5 px-4 py-4 sm:px-5.5 lg:grid-cols-[2.25rem_minmax(0,1fr)_8rem_7.5rem_9rem_7rem_minmax(9rem,auto)] lg:items-center';

function RowIcon({ icon: Icon, tone }: { icon: LucideIcon; tone?: Tone }) {
  return (
    <span
      aria-hidden
      className="inline-flex size-[34px] items-center justify-center rounded-[10px] border border-hairline"
    >
      <Icon
        className={cn(
          'size-4',
          tone === 'problem' ? 'text-oxide' : tone === 'attention' ? 'text-amber' : 'text-ink',
        )}
      />
    </span>
  );
}

/** A group's band: its name, a quiet count and what it means. */
function GroupHeading({
  id,
  dot,
  title,
  count,
  note,
}: {
  id?: string;
  dot: string;
  title: string;
  count: number;
  note: string;
}) {
  return (
    <div
      id={id}
      className="flex scroll-mt-28 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-y border-hairline bg-[#f7f6f2] px-4 py-2.5 sm:px-5.5"
    >
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <span aria-hidden className={cn('size-2 rounded-full', dot)} />
        {title}
        <span className="rounded-md border border-hairline bg-ivory px-1.5 text-xs font-medium">
          {count}
        </span>
      </h3>
      <p className="text-[0.78125rem] text-slate">{note}</p>
    </div>
  );
}

/**
 * Problems that need someone (most urgent first), or work that is still correcting itself. The
 * server decides which is which (`automatic`), so a retry that has run out of attempts or gone
 * quiet moves from one group to the other on its own.
 */
function AttentionRows({
  items,
  owner,
  scheduled,
}: {
  items: AttentionItem[];
  owner: boolean;
  scheduled: boolean;
}) {
  return (
    <ul>
      {items.map((item, index) => {
        const tone: Tone = item.automatic
          ? 'info'
          : item.kind === 'run_failed'
            ? 'problem'
            : 'attention';
        const link = attentionLink(item);
        const progress = item.automatic ? retryProgress(item) : null;
        const failedTask = item.kind === 'task_failed' || item.kind === 'task_stalled';
        return (
          <li
            key={`${item.kind}-${item.runKey ?? ''}-${index}`}
            className="border-b border-hairline-soft last:border-b-0"
          >
            <div className={WORK_ROW}>
              <RowIcon
                icon={
                  tone === 'problem' ? CircleAlert : tone === 'info' ? RefreshCw : TriangleAlert
                }
                tone={tone}
              />
              <div className="min-w-0">
                <p className="text-[0.90625rem] font-semibold text-ink">{attentionTitle(item)}</p>
                <p className="mt-0.5 text-[0.8125rem] leading-normal text-graphite">
                  {item.automatic && progress ? `${progress}. ` : ''}
                  {attentionAction(item, owner, scheduled)}
                </p>
              </div>
              <div className="col-start-2 flex flex-wrap items-center gap-x-3 gap-y-2 lg:contents">
                <KindTag kind={item.task?.kind} />
                <span className="text-xs whitespace-nowrap text-graphite">
                  {item.at ? formatDateTime(item.at) : '—'}
                </span>
                <span>
                  {item.attempts && (item.automatic || failedTask) ? (
                    <Tries attempts={item.attempts} tone={item.automatic ? 'retrying' : 'failed'} />
                  ) : item.count > 1 ? (
                    <span className="text-[0.78125rem] text-graphite">{item.count} affected</span>
                  ) : null}
                </span>
                <span
                  className={cn(
                    'text-[0.78125rem] font-semibold',
                    item.automatic
                      ? 'text-graphite'
                      : tone === 'problem' || failedTask
                        ? 'text-oxide'
                        : 'text-amber',
                  )}
                >
                  {item.automatic
                    ? 'Retrying'
                    : item.kind === 'task_failed'
                      ? 'Given up'
                      : item.kind === 'task_stalled' || item.kind === 'run_stuck'
                        ? 'Stopped'
                        : item.kind === 'run_failed'
                          ? 'Stopped'
                          : 'Needs a look'}
                </span>
                <span className="lg:justify-self-end">
                  {item.automatic ? (
                    <span className="text-[0.78125rem] text-slate">Nothing to do</span>
                  ) : link ? (
                    <Link
                      href={link.href}
                      className="inline-flex min-h-9.5 items-center gap-1.5 rounded-full bg-ink px-3.5 text-[0.8125rem] font-semibold whitespace-nowrap text-white hover:bg-graphite"
                    >
                      {link.label} <ArrowRight className="size-3.5" aria-hidden />
                    </Link>
                  ) : item.runKey ? (
                    <Link
                      href={runHref(item.runKey)}
                      className="inline-flex min-h-9.5 items-center rounded-full border border-ink px-3.5 text-[0.8125rem] font-semibold whitespace-nowrap"
                    >
                      See what happened
                    </Link>
                  ) : null}
                </span>
              </div>
            </div>
            <details className="disclosure group px-4 pb-3.5 sm:pr-5.5 sm:pl-[4.75rem]">
              <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-sm text-[0.78125rem] font-medium text-graphite hover:text-ink [&::-webkit-details-marker]:hidden">
                <ChevronRight
                  aria-hidden
                  className="size-3.5 transition-transform group-open:rotate-90"
                />
                Technical detail
                {item.runKey ? (
                  <span className="font-normal text-slate">· {editionName(item.runKey)}</span>
                ) : null}
              </summary>
              <pre className="mt-1 max-w-[51rem] rounded-[10px] bg-[#f5f4f0] px-3.5 py-3 font-mono text-xs leading-relaxed wrap-break-word whitespace-pre-wrap text-graphite group-open:rise-in">
                {item.detail}
              </pre>
            </details>
          </li>
        );
      })}
    </ul>
  );
}

/** The steps a running task recorded, as the progress views describe them (ADR-037). */
function recordedSteps(task: RunningTaskItem): StepView[] {
  if (!task.progress) return [];
  if (task.kind === 'research') return researchSteps(task.progress, { lead: task.focused });
  if (task.kind === 'chat') return chatSteps(task.progress);
  if (task.kind === 'generate' && isDraftFormat(task.format))
    return draftSteps(task.progress, DRAFT_FORMATS[task.format].limit.unit);
  return [];
}

function RunningRows({ tasks }: { tasks: RunningTaskItem[] }) {
  return (
    <ul>
      {tasks.map((task) => {
        const steps = recordedSteps(task);
        const now = steps.findIndex((s) => s.state === 'now');
        const waiting = task.status === 'queued';
        const link = task.storyId
          ? task.kind === 'generate'
            ? `/stories/${task.storyId}/studio`
            : task.kind === 'research' || task.kind === 'chat'
              ? `/stories/${task.storyId}/research`
              : `/stories/${task.storyId}`
          : task.runKey
            ? runHref(task.runKey)
            : null;
        return (
          <li
            key={task.id}
            className={cn(WORK_ROW, 'border-b border-hairline-soft last:border-b-0')}
          >
            <RowIcon icon={KIND_ICON[task.kind] ?? Search} />
            <div className="min-w-0">
              <p className="truncate text-[0.90625rem] font-semibold text-ink">{workName(task)}</p>
              <p className="mt-0.5 text-[0.8125rem] text-graphite">
                {waiting
                  ? 'Waiting for the background service to start it'
                  : now >= 0
                    ? `Step ${now + 1} of ${steps.length} · ${steps[now]!.label}`
                    : 'Under way'}
              </p>
            </div>
            <div className="col-start-2 flex flex-wrap items-center gap-x-3 gap-y-2 lg:contents">
              <KindTag kind={task.kind} />
              <span className="text-xs whitespace-nowrap text-graphite">
                {task.updatedAt ? `Active ${formatTime(task.updatedAt)}` : '—'}
              </span>
              <span>
                {steps.length ? (
                  <span
                    role="img"
                    aria-label={now >= 0 ? `Step ${now + 1} of ${steps.length}` : 'Not started'}
                    className="inline-flex gap-[3px]"
                  >
                    {steps.map((step) => (
                      <span
                        key={step.id}
                        className={cn(
                          'h-1.5 w-4 rounded-full',
                          step.state === 'done'
                            ? 'bg-ink'
                            : step.state === 'now'
                              ? 'bg-stone'
                              : 'bg-hairline',
                        )}
                      />
                    ))}
                  </span>
                ) : null}
              </span>
              <span className="inline-flex items-center gap-1.5 text-[0.78125rem] font-semibold text-graphite">
                {waiting ? null : <Loader2 className="size-3 animate-spin" aria-hidden />}
                {waiting ? 'Waiting' : 'In progress'}
              </span>
              <span className="lg:justify-self-end">
                {link ? (
                  <Link
                    href={link}
                    className="inline-flex min-h-9.5 items-center rounded-full border border-rule-strong px-3.5 text-[0.8125rem] font-medium whitespace-nowrap hover:border-ink"
                  >
                    Follow it
                  </Link>
                ) : null}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
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
  const attentionTone: Tone = actionable.some((a) => a.kind === 'run_failed')
    ? 'problem'
    : actionable.length
      ? 'attention'
      : 'done';

  return (
    <>
      <PageMasthead
        eyebrow="Behind the edition"
        title="Operations"
        size="masthead"
        className="pt-2 sm:pt-4"
        aside={
          <>
            <span className="text-[0.8125rem] text-slate">
              Updated {formatTime(new Date().toISOString())}
            </span>
            <RefreshButton />
            {owner ? <FindStoriesButton fixtures={isFixtureRuntime()} /> : null}
          </>
        }
      >
        <p>Whether the newsroom is running properly, in plain words.</p>
      </PageMasthead>

      <div
        aria-label="At a glance"
        role="group"
        className="mt-7 grid gap-px overflow-hidden rounded-[18px] border border-hairline bg-hairline sm:grid-cols-2 xl:grid-cols-5"
      >
        <LatestEdition latest={latest} owner={owner} scheduled={scheduled} />
        <EnoughStories edition={latestEdition} />
        <Glance
          question="Does anything need attention?"
          tone={attentionTone}
          value={
            actionable.length ? (
              <>
                {actionable.length}{' '}
                <small className="text-current!">
                  {actionable.length === 1 ? 'thing' : 'things'}
                </small>
              </>
            ) : (
              'Nothing'
            )
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
        </Glance>
        <NextEdition latest={latest} scheduled={scheduled} />
        <Spending usage={overview.usage} className="sm:col-span-2 xl:col-span-1" />
      </div>

      <section
        aria-labelledby="work-title"
        className="mt-7 overflow-hidden rounded-[18px] border border-hairline"
      >
        <div className="flex flex-wrap items-center justify-between gap-4 px-4 pt-5 pb-4 sm:px-5.5">
          <div>
            <h2 id="work-title" className="masthead text-[1.875rem] leading-[0.95]">
              Background work
            </h2>
            <p className="mt-1 text-[0.84375rem] text-graphite">
              Searches, research, replies and drafts, last {overview.usage.days} days. Steps come
              only from what the work recorded.
            </p>
          </div>
          <ul className="flex flex-wrap items-center gap-1.5 text-[0.78125rem]">
            {[
              { label: 'Needs attention', count: actionable.length, alert: actionable.length > 0 },
              { label: 'Retrying', count: automatic.length, alert: false },
              { label: 'Running', count: overview.running.length, alert: false },
            ].map((chip) => (
              <li
                key={chip.label}
                className="inline-flex items-center gap-1.5 rounded-full border border-hairline px-2.5 py-1"
              >
                {chip.label}
                <strong
                  className={cn(
                    'rounded-full px-1.5 font-semibold',
                    chip.alert ? 'bg-oxide-wash text-oxide' : 'bg-[#f1f0ec] text-graphite',
                  )}
                >
                  {chip.count}
                </strong>
              </li>
            ))}
          </ul>
        </div>

        {actionable.length ? (
          <>
            <GroupHeading
              id="attention"
              dot="bg-oxide"
              title="Needs attention"
              count={actionable.length}
              note="Most urgent first. Each says what to do."
            />
            <AttentionRows items={actionable} owner={owner} scheduled={scheduled} />
          </>
        ) : null}
        {automatic.length ? (
          <>
            <GroupHeading
              id="retrying"
              dot="bg-graphite"
              title="Retrying on its own"
              count={automatic.length}
              note="No action needed. If the last attempt fails, or retrying stops, it moves to Needs attention."
            />
            <AttentionRows items={automatic} owner={owner} scheduled={scheduled} />
          </>
        ) : null}
        {overview.running.length ? (
          <>
            <GroupHeading
              dot="bg-graphite"
              title="Running now"
              count={overview.running.length}
              note="The step each piece of work last recorded."
            />
            <RunningRows tasks={overview.running} />
          </>
        ) : null}
        {!actionable.length && !automatic.length && !overview.running.length ? (
          <p className="border-t border-hairline px-4 py-5 text-sm text-graphite sm:px-5.5">
            Nothing is running, retrying or waiting for anyone right now.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="history-title" className="mt-12">
        <div className="flex flex-wrap items-baseline justify-between gap-3 border-b-2 border-ink pb-3">
          <h2 id="history-title" className="masthead text-[1.625rem] leading-[0.95]">
            Edition history
          </h2>
          <p className="text-[0.8125rem] text-slate">Every search, newest first</p>
        </div>
        {runs.length ? (
          <ul>
            {runs.map((run) => {
              const status = runStatus(run.status);
              return (
                <li
                  key={run.runKey}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-6 gap-y-1 border-b border-hairline-soft py-3 sm:grid-cols-[minmax(0,1fr)_10rem_9rem_11rem]"
                >
                  <Link
                    href={runHref(run.runKey)}
                    className="headline-link rounded-sm font-serif text-[1.0625rem] text-ink"
                  >
                    {editionName(run.runKey)}
                  </Link>
                  <span
                    className={cn(
                      'text-[0.8125rem] font-semibold',
                      status.tone === 'problem'
                        ? 'text-oxide'
                        : status.tone === 'attention'
                          ? 'text-amber'
                          : 'text-graphite',
                    )}
                  >
                    {run.status === 'completed' && run.sourceFailures > 0
                      ? `${run.sourceFailures} ${run.sourceFailures === 1 ? 'source' : 'sources'} unreadable`
                      : status.label}
                    {run.recovery ? (
                      <span className="block font-normal text-slate">
                        {recoveryLabel(run.recovery)}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-[0.8125rem] text-ink tabular-nums">
                    {run.status === 'completed' ? `${run.shortlisted} recommended` : null}
                  </span>
                  <span className="meta sm:text-right">
                    {formatDateTime(run.completedAt ?? run.startedAt ?? run.createdAt)}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="meta mt-3">No editions yet.</p>
        )}
      </section>

      <section id="usage" aria-labelledby="usage-title" className="mt-12 scroll-mt-28">
        <div className="flex flex-wrap items-baseline justify-between gap-3 border-b-2 border-ink pb-3">
          <h2 id="usage-title" className="masthead text-[1.625rem] leading-[0.95]">
            Usage and estimated cost
          </h2>
          <p className="text-[0.8125rem] text-slate">By service, last {overview.usage.days} days</p>
        </div>
        <div className="mt-5 max-w-4xl">
          <UsageSummary
            reported={overview.usage.reported}
            simulated={overview.usage.simulated}
            pricesVerifiedOn={overview.usage.pricesVerifiedOn}
          />
        </div>
      </section>
    </>
  );
}

export default function OperationsPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-8 pt-4" aria-busy="true" aria-label="Loading operations">
          <Skeleton className="h-24 w-1/2 max-w-xl" />
          <Skeleton className="h-44 rounded-[18px]" />
          <Skeleton className="h-72 rounded-[18px]" />
        </div>
      }
    >
      <Operations />
    </Suspense>
  );
}
