import { isRequestConfigurationFailure } from '@repo/shared';

import { getModels } from '../db/models.js';
import type { TaskDoc } from '../db/models/task.js';
import { MAX_RUN_ATTEMPTS, RUN_QUIET_AFTER_MS } from '../discovery/runs.js';
import type { RunSummaryDto } from '../newsroom/dto.js';
import { toRunSummaryWithProgress, usageSince } from '../newsroom/queries.js';
import { TASK_MAX_ATTEMPTS } from '../tasks/contracts.js';
import {
  CHAT_STALE_MS,
  CHAT_STOPPED_MESSAGE,
  STALE_LOCK_MS,
  staleAfterMs,
} from '../tasks/service.js';
import { PRICE_TABLE, splitUsage, type UsageSummaryDto } from './pricing.js';

/**
 * The owner's at-a-glance view: did the latest discovery finish, is anything blocking the next
 * one, and what are we using. Every item is derived from stored records; nothing is softened.
 */
export type AttentionKind =
  | 'run_failed'
  | 'run_stuck'
  | 'run_retrying'
  | 'sources_failed'
  | 'assessment_failed'
  /** Assessments refused because of how the request was built: a fix is needed, not a retry. */
  | 'assessment_blocked'
  /** Failed assessments the next edition tries once more on its own. */
  | 'assessment_retry_due'
  /** A recovery of an edition's assessments (ADR-046), under way or stopped with work left. */
  | 'recovery_running'
  | 'recovery_incomplete'
  | 'task_failed'
  | 'task_stalled'
  | 'task_retrying';

export interface AttentionItem {
  kind: AttentionKind;
  /**
   * True only while the system is still correcting it on its own (another attempt is due), so
   * nobody needs to act. It turns false once the attempts run out or stop happening, and the item
   * then needs someone.
   */
  automatic: boolean;
  runKey: string | null;
  at: string | null;
  count: number;
  /** For retried work: attempts made so far, out of the most the worker will make. */
  attempts: { made: number; limit: number } | null;
  /** For a background task: what kind of work it was, its status and the story it belongs to. */
  task: {
    kind: TaskDoc['kind'];
    status: TaskDoc['status'];
    storyId: string | null;
    headline: string | null;
  } | null;
  /** Technical detail for the expandable section. */
  detail: string;
}

/**
 * Background work going normally: queued or running, no failed attempt, not stopped by an editor,
 * and active within its kind's stale window. Anything else is under `attention` (retrying,
 * stalled, failed) or finished, so nothing here is ever a problem shown as progress.
 */
export interface RunningTaskItem {
  id: string;
  kind: TaskDoc['kind'];
  status: 'queued' | 'running';
  runKey: string | null;
  storyId: string | null;
  headline: string | null;
  /** Drafts: the format being written. */
  format: string | null;
  /** Research asked about one question (a lead or a reply's own follow-up). */
  focused: boolean;
  startedAt: string | null;
  updatedAt: string | null;
  /** The steps this attempt recorded, as stored (ADR-037): never estimated. */
  progress: {
    step: string | null;
    steps: Array<{ step: string; counts: Record<string, number> | null }>;
  } | null;
}

/** At most this many running tasks are listed: the page stays light while a run fans out. */
export const RUNNING_LIMIT = 20;

export interface OperationsOverviewDto {
  latestRun: RunSummaryDto | null;
  attention: AttentionItem[];
  /** Work under way with nothing wrong, newest activity first (at most `RUNNING_LIMIT`). */
  running: RunningTaskItem[];
  usage: {
    /** Usage the providers reported. */
    reported: UsageSummaryDto;
    /** Development-fixture activity, kept apart and never totalled with real usage. */
    simulated: UsageSummaryDto | null;
    days: number;
    pricesVerifiedOn: string;
  };
}

/**
 * Retried work with no activity for this long is no longer being retried: the worker stopped
 * without recording a final failure. Well beyond the slowest attempt plus its longest backoff
 * (research: 15 minutes plus 2; a discovery run: a 5-minute backoff), and the same window after
 * which a research lock counts as abandoned.
 */
export const RETRY_STALLED_AFTER_MS = 45 * 60_000;

/** Story work that a later request of the same kind supersedes (the editor already retried). */
const STORY_TASK_KINDS = new Set<TaskDoc['kind']>(['research', 'chat', 'generate']);

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

export async function getOperationsOverview(
  now: Date = new Date(),
  days = 7,
): Promise<OperationsOverviewDto> {
  const { WorkflowRun, Task, Story } = await getModels();
  const since = new Date(now.getTime() - days * 86_400_000);
  const [latest, recentRuns, tasks, usageRows, runningTasks] = await Promise.all([
    WorkflowRun.findOne().sort({ createdAt: -1 }).lean(),
    WorkflowRun.find({ createdAt: { $gte: since } })
      .sort({ createdAt: -1 })
      .lean(),
    Task.find({
      updatedAt: { $gte: since },
      $or: [
        { status: 'failed' },
        // A failed attempt waiting for (or in) its next try.
        { status: { $in: ['queued', 'running'] }, lastError: { $ne: null } },
        // Quiet for too long without any error: a timeout or a worker that went away.
        {
          status: { $in: ['queued', 'running'] },
          updatedAt: { $lt: new Date(now.getTime() - RETRY_STALLED_AFTER_MS) },
        },
        // A chat reply runs in the web request: quiet for minutes means it can't finish.
        {
          kind: 'chat',
          status: { $in: ['queued', 'running'] },
          updatedAt: { $lt: new Date(now.getTime() - CHAT_STALE_MS) },
        },
      ],
    })
      .sort({ updatedAt: -1 })
      .limit(50)
      .lean(),
    usageSince(days, now),
    // Read-only and bounded; served by the { status, updatedAt } index.
    Task.find(
      {
        status: { $in: ['queued', 'running'] },
        lastError: null,
        cancelRequested: { $ne: true },
        $or: [
          { kind: 'chat', updatedAt: { $gte: new Date(now.getTime() - CHAT_STALE_MS) } },
          { kind: { $ne: 'chat' }, updatedAt: { $gte: new Date(now.getTime() - STALE_LOCK_MS) } },
        ],
      },
      {
        kind: 1,
        status: 1,
        runKey: 1,
        storyId: 1,
        format: 1,
        requestKind: 1,
        startedAt: 1,
        updatedAt: 1,
        'progress.step': 1,
        'progress.steps': 1,
      },
    )
      .sort({ updatedAt: -1 })
      .limit(RUNNING_LIMIT)
      .lean(),
  ]);

  const attention: AttentionItem[] = [];
  const stalledBefore = new Date(now.getTime() - RETRY_STALLED_AFTER_MS);
  const base = { automatic: false, attempts: null, task: null } as const;
  for (const run of recentRuns) {
    const lastError = run.runErrors?.at(-1);
    // A failed run is resolved once a later run has completed: that run took on whatever the
    // failed one had found. It stays in the edition history.
    const resolved =
      run.status === 'failed' &&
      recentRuns.some((later) => later.status === 'completed' && later.createdAt > run.createdAt);
    if (run.status === 'failed' && !resolved) {
      attention.push({
        ...base,
        kind: 'run_failed',
        runKey: run.runKey,
        at: iso(lastError?.at ?? run.updatedAt),
        count: 1,
        detail: lastError
          ? `[${lastError.stage}] ${lastError.message}`
          : 'No error message recorded.',
      });
    } else if (run.status === 'running' && run.leaseExpiresAt && run.leaseExpiresAt < now) {
      // The orchestrator's own retry resumes a run whose lease lapsed, but only while it has
      // attempts left and is still trying; after that nothing will pick it up.
      const made = run.attempts ?? 0;
      attention.push({
        ...base,
        kind: 'run_stuck',
        automatic: made < MAX_RUN_ATTEMPTS && run.leaseExpiresAt >= stalledBefore,
        runKey: run.runKey,
        at: iso(run.leaseExpiresAt),
        count: 1,
        attempts: { made, limit: MAX_RUN_ATTEMPTS },
        detail: `Stage "${run.stage}" stopped renewing its lease at ${iso(run.leaseExpiresAt)} (attempt ${made} of ${MAX_RUN_ATTEMPTS}).`,
      });
    } else if (run.status === 'queued') {
      // Waiting for its next attempt after a failure, or for its first start. Automatic while
      // recent; quiet for longer and nothing is going to pick it up.
      const quiet = run.updatedAt < new Date(now.getTime() - RUN_QUIET_AFTER_MS);
      const made = run.attempts ?? 0;
      if (quiet || lastError)
        attention.push({
          ...base,
          kind: quiet ? 'run_stuck' : 'run_retrying',
          automatic: !quiet,
          runKey: run.runKey,
          at: iso(lastError?.at ?? run.updatedAt),
          count: 1,
          attempts: { made, limit: MAX_RUN_ATTEMPTS },
          detail: lastError
            ? `[${lastError.stage}] ${lastError.message}`
            : `Queued since ${iso(run.updatedAt)} and never started.`,
        });
    }
    const funnel = (run.funnel ?? {}) as { searchFailures?: number; extractionFailures?: number };
    const sourceFailures = (funnel.searchFailures ?? 0) + (funnel.extractionFailures ?? 0);
    if (run.status === 'completed' && sourceFailures > 0) {
      attention.push({
        ...base,
        kind: 'sources_failed',
        runKey: run.runKey,
        at: iso(run.completedAt),
        count: sourceFailures,
        detail:
          (run.runErrors ?? []).map((e) => `[${e.stage}] ${e.message}`).join('\n') ||
          `${funnel.searchFailures ?? 0} search and ${funnel.extractionFailures ?? 0} extraction failure(s).`,
      });
    }
    const failedAssessments = (run.outcomes ?? []).filter((o) => o.outcome === 'evaluation_failed');
    if (failedAssessments.length) {
      // Split by what can fix them: a code or configuration fix, the next edition's one retry,
      // or someone's look. Stories assessed since (by that retry or a recovery) aren't counted.
      const stories = await Story.find(
        { _id: { $in: failedAssessments.flatMap((o) => (o.storyId ? [o.storyId] : [])) } },
        { evaluation: 1, editorialState: 1 },
      ).lean();
      const byId = new Map(stories.map((s) => [String(s._id), s]));
      const groups = { blocked: [], retryDue: [], failed: [] } as Record<
        'blocked' | 'retryDue' | 'failed',
        typeof failedAssessments
      >;
      for (const o of failedAssessments) {
        const story = byId.get(String(o.storyId));
        if (story && story.evaluation?.status !== 'failed') continue;
        if (isRequestConfigurationFailure(o.detail ?? '')) groups.blocked.push(o);
        else if (story?.evaluation?.failedRuns === 1 && story.editorialState !== 'skipped')
          groups.retryDue.push(o);
        else groups.failed.push(o);
      }
      const kinds = [
        ['blocked', 'assessment_blocked', false],
        ['retryDue', 'assessment_retry_due', true],
        ['failed', 'assessment_failed', false],
      ] as const;
      for (const [group, kind, automatic] of kinds) {
        const items = groups[group];
        if (!items.length) continue;
        attention.push({
          ...base,
          kind,
          automatic,
          runKey: run.runKey,
          at: iso(run.completedAt ?? run.updatedAt),
          count: items.length,
          detail: items.map((o) => o.detail || 'No detail recorded.').join('\n'),
        });
      }
    }
    const recovery = run.recovery;
    if (recovery && recovery.status !== 'completed') {
      const counts = (recovery.counts ?? {}) as {
        assessed?: number;
        eligibleAtStart?: number;
        remainingEligible?: number;
      };
      const live =
        recovery.status === 'running' &&
        recovery.updatedAt >= new Date(now.getTime() - 10 * 60_000);
      attention.push({
        ...base,
        kind: live ? 'recovery_running' : 'recovery_incomplete',
        automatic: live,
        runKey: run.runKey,
        at: iso(recovery.updatedAt),
        count:
          counts.remainingEligible ??
          Math.max(0, (counts.eligibleAtStart ?? 0) - (counts.assessed ?? 0)),
        attempts: null,
        detail: `Recovery ${recovery.id} (${recovery.status}, started ${iso(recovery.startedAt)}): ${counts.assessed ?? 0} assessed of ${counts.eligibleAtStart ?? '?'}.${recovery.note ? ` ${recovery.note}` : ''}`,
      });
    }
  }

  // An assessment that gave up is already reported with its edition (above), and so is one a
  // recovery has attempted: its edition's recovery item covers it.
  const reportedAssessments = new Set(
    recentRuns.flatMap((run) =>
      (run.outcomes ?? [])
        .filter((o) => o.outcome === 'evaluation_failed' || run.recovery)
        .map((o) => `${run.runKey}:${String(o.storyId)}`),
    ),
  );
  const storyIds = [...new Set(tasks.flatMap((t) => (t.storyId ? [String(t.storyId)] : [])))];
  // Headlines for the running list too; the attention checks below still use `storyIds` only.
  const headlineIds = [
    ...new Set([
      ...storyIds,
      ...runningTasks.flatMap((t) => (t.storyId ? [String(t.storyId)] : [])),
    ]),
  ];
  const [stories, laterStoryTasks] = await Promise.all([
    headlineIds.length ? Story.find({ _id: { $in: headlineIds } }, { headline: 1 }).lean() : [],
    storyIds.length
      ? Task.find(
          {
            storyId: { $in: storyIds },
            kind: { $in: [...STORY_TASK_KINDS] },
            status: { $ne: 'failed' },
          },
          { storyId: 1, kind: 1, format: 1, createdAt: 1 },
        ).lean()
      : [],
  ]);
  const headlines = new Map(stories.map((s) => [String(s._id), s.headline]));
  const superseded = (task: (typeof tasks)[number]) =>
    STORY_TASK_KINDS.has(task.kind) &&
    laterStoryTasks.some(
      (later) =>
        later.kind === task.kind &&
        String(later.storyId) === String(task.storyId) &&
        // A draft is only superseded by a later request for the same format.
        (later.format ?? null) === (task.format ?? null) &&
        later.createdAt > task.createdAt,
    );
  const describe = (task: (typeof tasks)[number]) => {
    const storyId = task.storyId ? String(task.storyId) : null;
    return {
      kind: task.kind,
      status: task.status,
      storyId,
      headline: storyId ? (headlines.get(storyId) ?? null) : null,
    };
  };

  for (const task of tasks) {
    // An editor stopping a reply is a choice, not a failure.
    if (task.kind === 'chat' && task.lastError === CHAT_STOPPED_MESSAGE) continue;
    const limit = TASK_MAX_ATTEMPTS[task.kind];
    const attempts = { made: task.attempts ?? 0, limit };
    if (task.status === 'failed') {
      if (
        task.kind === 'discovery.evaluate' &&
        reportedAssessments.has(`${task.runKey}:${String(task.storyId)}`)
      )
        continue;
      if (superseded(task)) continue;
      attention.push({
        kind: 'task_failed',
        automatic: false,
        runKey: task.runKey ?? null,
        at: iso(task.updatedAt),
        count: 1,
        attempts,
        task: describe(task),
        detail: `${task.key} (${attempts.made} of ${limit} attempts): ${task.lastError ?? 'no message'}`,
      });
      continue;
    }
    // Queued or running after a failed attempt: retrying, unless the retries have gone quiet.
    const stalled =
      task.kind === 'chat'
        ? task.updatedAt < new Date(now.getTime() - CHAT_STALE_MS)
        : task.updatedAt < stalledBefore;
    attention.push({
      kind: stalled ? 'task_stalled' : 'task_retrying',
      automatic: !stalled,
      runKey: task.runKey ?? null,
      at: iso(task.updatedAt),
      count: 1,
      attempts,
      task: describe(task),
      detail: task.lastError
        ? `${task.key}: attempt ${attempts.made} of ${limit}, ${task.status}; the previous attempt failed: ${task.lastError}${stalled ? `. No activity since ${iso(task.updatedAt)}.` : ''}`
        : `${task.key}: ${task.status} with no activity since ${iso(task.updatedAt)} and no error recorded (a timeout or a worker that stopped).`,
    });
  }

  // The query bounds by the longest window; each kind's own window is applied here too.
  const running: RunningTaskItem[] = runningTasks
    .filter((task) => task.updatedAt >= new Date(now.getTime() - staleAfterMs(task.kind)))
    .map((task) => {
      const storyId = task.storyId ? String(task.storyId) : null;
      // Projected by dotted path (no draft preview text is read), which the inferred type omits.
      const { progress } = task as {
        progress?: {
          step?: string | null;
          steps?: Array<{ step: string; counts?: unknown }> | null;
        } | null;
      };
      return {
        id: String(task._id),
        kind: task.kind,
        status: task.status as RunningTaskItem['status'],
        runKey: task.runKey ?? null,
        storyId,
        headline: storyId ? (headlines.get(storyId) ?? null) : null,
        format: task.format ?? null,
        focused: task.requestKind === 'lead' || task.requestKind === 'followup',
        startedAt: iso(task.startedAt),
        updatedAt: iso(task.updatedAt),
        progress: progress
          ? {
              step: progress.step ?? null,
              steps: (progress.steps ?? []).map((s) => ({
                step: s.step,
                counts: (s.counts as Record<string, number> | null | undefined) ?? null,
              })),
            }
          : null,
      };
    });

  return {
    latestRun: latest ? await toRunSummaryWithProgress(latest) : null,
    attention,
    running,
    usage: { ...splitUsage(usageRows), days, pricesVerifiedOn: PRICE_TABLE.verifiedOn },
  };
}
