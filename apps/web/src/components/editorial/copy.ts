import {
  SCORE_THRESHOLDS,
  type CandidateOutcome,
  type RecommendedAction,
  type ShortfallReason,
} from '@repo/shared';

import { formatDateTime, formatDay, formatLongDay } from './format';

/**
 * Every editor-facing word for an internal state, in one place. Editors read "stories reviewed"
 * and "editorial checks", never "candidates" or "gates"; the system's ids stay in the database.
 */

export const STANDARD = SCORE_THRESHOLDS.shortlist;

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

// ── Editions (discovery runs) ────────────────────────────────────────────────

const DAILY = 'daily-discovery:';
const MANUAL = 'manual:';

/** The edition's headline date: "Thursday 15 October 2026", or "Extra edition". */
export function editionTitle(runKey: string): string {
  if (runKey.startsWith(DAILY)) return formatLongDay(runKey.slice(DAILY.length));
  if (runKey.startsWith(MANUAL)) return 'Extra edition';
  return 'Edition';
}

/** Short label for lists: "Edition of 15 Oct 2026" or "Extra edition, 15 Oct, 06:14 CDT". */
export function editionName(runKey: string): string {
  if (runKey.startsWith(DAILY)) return `Edition of ${formatDay(runKey.slice(DAILY.length))}`;
  if (runKey.startsWith(MANUAL))
    return `Extra edition, ${formatDateTime(runKey.slice(MANUAL.length))}`;
  return 'Edition';
}

const STAGE: Record<string, string> = {
  queued: 'Waiting to start',
  discover: 'Searching for stories',
  revisit: 'Checking earlier stories for news',
  extract: 'Reading articles',
  triage: 'Sorting what’s in scope',
  cluster: 'Grouping reports of the same story',
  evaluate: 'Assessing stories',
  rank: 'Choosing the edition',
  done: 'Finishing',
};

/** "Assessing stories: 2 of 6 done" for a run that hasn't finished. */
export function progressLine(
  progress: { stage: string; done: number | null; total: number | null } | null,
): string | null {
  if (!progress) return null;
  const step = STAGE[progress.stage] ?? 'Working';
  return progress.done !== null && progress.total
    ? `${step}: ${progress.done} of ${progress.total} done`
    : step;
}

/** Turns a stored run error into a sentence an owner can act on, naming the service involved. */
export function failureReason(detail: string): string {
  if (/USAGE_LIMIT|usage limit of \d+/i.test(detail))
    return 'Today’s usage limit has been reached. It frees up as earlier use ages out.';
  const service = /gemini|anthropic/i.test(detail) ? 'The AI service' : 'The search service';
  if (/unauthori[sz]ed|api key|forbidden|\b40[13]\b/i.test(detail))
    return `${service} refused our access key.`;
  if (/quota|usage limit|credits|\b43[23]\b|resource.?exhausted/i.test(detail))
    return `${service}’s usage limit was reached.`;
  if (/rate limit|\b429\b/i.test(detail)) return `${service} asked us to slow down.`;
  if (/high demand|overloaded|unavailable|\b50[0-9]\b/i.test(detail))
    return `${service} was overloaded and didn’t respond after several tries.`;
  return 'Something went wrong, so it stopped.';
}

export const RUN_STATUS: Record<string, { label: string; tone: Tone }> = {
  completed: { label: 'Completed', tone: 'done' },
  running: { label: 'In progress', tone: 'info' },
  queued: { label: 'Waiting to start', tone: 'info' },
  failed: { label: 'Needs attention', tone: 'problem' },
};
export const runStatus = (status: string) =>
  RUN_STATUS[status] ?? { label: 'Unknown', tone: 'attention' as Tone };

export type Tone = 'done' | 'info' | 'attention' | 'problem';

/** "We reviewed 6 stories overnight; 2 met our standards." Built only from stored counts. */
export function editionIntro(input: {
  storiesReviewed: number;
  shortlisted: number;
  qualified: number;
  trigger: 'schedule' | 'manual';
}): string {
  const when = input.trigger === 'schedule' ? ' overnight' : '';
  const reviewed = `We reviewed ${plural(input.storiesReviewed, 'story', 'stories')}${when}`;
  if (input.storiesReviewed === 0) return `We found no stories to review${when}.`;
  if (input.shortlisted === 0) return `${reviewed}; none met our standards.`;
  if (input.qualified > input.shortlisted)
    return `${reviewed}; ${input.qualified} met our standards, and we recommend the strongest ${input.shortlisted}.`;
  if (input.shortlisted === input.storiesReviewed)
    return `${reviewed}; all of them met our standards.`;
  return `${reviewed}; ${input.shortlisted} met our standards.`;
}

/** The small-edition note. The bar is never lowered to fill the edition. */
export function smallEditionNote(shortlisted: number): string {
  const lead =
    shortlisted === 0
      ? 'No story met our standards in this edition.'
      : shortlisted === 1
        ? 'Only one story met our standards in this edition.'
        : `Only ${shortlisted} stories met our standards in this edition.`;
  return `${lead} We won’t lower the bar just to fill the edition.`;
}

/** One plain sentence per recorded reason the edition is smaller. */
export function shortfallPlain(reason: ShortfallReason): string {
  const n = reason.count;
  switch (reason.code) {
    case 'insufficient_candidates':
      return `Only ${plural(n, 'story was', 'stories were')} ready to be assessed.`;
    case 'source_failures':
      return `${plural(n, 'source')} couldn’t be reached or read.`;
    case 'evaluation_failures':
      return `${plural(n, 'story', 'stories')} couldn’t be assessed because of a technical problem.`;
    case 'editorial_gates':
      return `${plural(n, 'story', 'stories')} didn’t pass our editorial checks or need checking first.`;
    case 'below_threshold':
      return `${plural(n, 'story', 'stories')} scored below our bar of ${STANDARD}.`;
    case 'suppressed_repeats':
      return `${plural(n, 'story', 'stories')} repeated something we’d already covered.`;
    case 'deferred_late':
      return `${plural(n, 'story', 'stories')} will be considered in the next edition.`;
    default:
      return reason.message;
  }
}

// ── Stories ──────────────────────────────────────────────────────────────────

export const OUTCOME: Record<CandidateOutcome, string> = {
  qualified: 'Recommended',
  below_threshold: 'Didn’t meet our standard',
  gate_hold: 'Needs checking first',
  gate_reject: 'Didn’t pass our editorial checks',
  suppressed_repeat: 'Already covered, nothing new',
  evaluation_failed: 'Couldn’t be assessed',
  source_failed: 'Source couldn’t be read',
  deferred_late: 'Carried to the next edition',
};
export const outcomeLabel = (id: string | null) =>
  id ? ((OUTCOME as Record<string, string>)[id] ?? 'Reviewed') : 'Not assessed yet';

export const OUTCOME_TONE: Record<string, Tone> = {
  qualified: 'done',
  below_threshold: 'attention',
  gate_hold: 'attention',
  suppressed_repeat: 'info',
  deferred_late: 'info',
  gate_reject: 'problem',
  evaluation_failed: 'problem',
  source_failed: 'problem',
};
export const outcomeTone = (id: string | null): Tone => OUTCOME_TONE[id ?? ''] ?? 'info';

export const NEXT_STEP: Record<RecommendedAction, string> = {
  reject: 'Leave it',
  monitor: 'Keep an eye on it',
  research: 'Look into it further',
  shortlist: 'Worth considering',
  pitch: 'Pitch it',
  urgent_review: 'Editor’s attention needed',
};
export const nextStep = (id: string | null) =>
  id ? ((NEXT_STEP as Record<string, string>)[id] ?? null) : null;

export const CONFIDENCE: Record<string, string> = {
  high: 'High confidence',
  medium: 'Moderate confidence',
  low: 'Low confidence',
};

/** How far a source can be relied on, in words. */
export const RELIABILITY: Record<string, string> = {
  primary: 'Original source',
  reputable_secondary: 'Established publication',
  specialist: 'Specialist publication',
  unknown: 'Reliability not yet assessed',
  unverified_social: 'Unverified social post',
};
export const reliability = (id: string) => RELIABILITY[id] ?? RELIABILITY.unknown!;

export const READ_STATUS: Record<string, string | null> = {
  extracted: null,
  pending: 'Full text not read yet',
  failed: 'Full text couldn’t be read; summary only',
  skipped: 'Summary only',
};

export const DECISION_ACTION: Record<string, string> = {
  saved: 'Saved',
  unsaved: 'Removed from reading list',
  skipped: 'Skipped',
  unskipped: 'Skip undone',
};

/** We know where an image was found, never who holds its rights. */
export const IMAGE_CREDIT = (publisher: string) =>
  `Image via ${publisher} · credit and rights not confirmed`;

// ── Team ─────────────────────────────────────────────────────────────────────

export const ROLE: Record<string, { label: string; description: string }> = {
  owner: {
    label: 'Owner',
    description:
      'Everything an editor can do, plus inviting people, changing roles and starting a search for stories.',
  },
  editor: {
    label: 'Editor',
    description:
      'Reads each edition, saves or skips stories, researches them with Omenai, and sees how the newsroom is running.',
  },
};
export const roleLabel = (role: string) => ROLE[role]?.label ?? role;

export const INVITATION_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'Waiting to be accepted', tone: 'info' },
  claimed: { label: 'Being accepted', tone: 'info' },
  accepted: { label: 'Accepted', tone: 'done' },
  expired: { label: 'Expired', tone: 'attention' },
  revoked: { label: 'Withdrawn', tone: 'attention' },
};

// ── Operations ───────────────────────────────────────────────────────────────

/** The structural shape of an operations attention item (kept here so copy stays browser-safe). */
export interface AttentionCopyInput {
  kind: string;
  automatic: boolean;
  count: number;
  detail: string;
  attempts: { made: number; limit: number } | null;
  task: { kind: string; status: string; storyId: string | null; headline: string | null } | null;
}

const quoted = (headline: string | null) => (headline ? `“${headline}”` : null);

/** The piece of work a background task was doing, as a noun phrase. */
function workName(task: NonNullable<AttentionCopyInput['task']>): string {
  const story = quoted(task.headline);
  switch (task.kind) {
    case 'discovery.evaluate':
      return story ? `The assessment of ${story}` : 'A story’s assessment';
    case 'research':
      return story ? `Research on ${story}` : 'Research on a story';
    case 'chat':
      return story ? `A reply about ${story}` : 'A reply in a research conversation';
    case 'generate':
      return story ? `A draft for ${story}` : 'A draft';
    default:
      return 'A step of the search for stories';
  }
}

/** One sentence saying what happened. */
export function attentionTitle(item: AttentionCopyInput): string {
  const n = item.count;
  switch (item.kind) {
    case 'run_failed':
      return 'A search for stories stopped before finishing.';
    case 'run_stuck':
      return item.automatic
        ? 'A search for stories stopped responding and is due to be resumed.'
        : 'A search for stories stopped and won’t resume on its own.';
    case 'run_retrying':
      return 'A search for stories hit a temporary problem and will try again on its own.';
    case 'sources_failed':
      return `The edition completed, but ${plural(n, 'source')} couldn’t be searched or read.`;
    case 'assessment_failed':
      return `${plural(n, 'story', 'stories')} couldn’t be assessed because of a technical problem.`;
    case 'task_retrying':
      return item.task ? `${workName(item.task)} failed and is being tried again.` : 'Retrying.';
    case 'task_stalled':
      return item.task
        ? `${workName(item.task)} stopped retrying before it finished.`
        : 'A retry stopped before it finished.';
    case 'task_failed': {
      if (!item.task) return 'A background step failed.';
      const made = item.attempts?.made ?? 1;
      return item.attempts && made < item.attempts.limit
        ? `${workName(item.task)} failed, and trying again wouldn’t fix it.`
        : `${workName(item.task)} failed ${made === 1 ? 'once' : `${made} times`} and was given up.`;
    }
    default:
      return 'Something needs a look.';
  }
}

/** "Attempt 2 of 5 under way" or "Attempt 3 of 5 due shortly", for work being retried. */
export function retryProgress(item: AttentionCopyInput): string | null {
  if (!item.attempts) return null;
  const { made, limit } = item.attempts;
  if (item.kind === 'run_stuck') return `Attempt ${made} of ${limit} lapsed`;
  if (item.kind === 'run_retrying')
    return `Attempt ${Math.min(made + 1, limit)} of ${limit} due shortly`;
  return item.task?.status === 'queued'
    ? `Attempt ${Math.min(made + 1, limit)} of ${limit} due shortly`
    : `Attempt ${made} of ${limit} under way`;
}

/**
 * What someone can do about it, in a sentence or two. Self-correcting items say so. `scheduled`
 * is false in development, where no nightly edition will come along to try again.
 */
export function attentionAction(
  item: AttentionCopyInput,
  owner: boolean,
  scheduled = true,
): string {
  const tonight = scheduled ? ', or wait for tonight’s edition' : '';
  const tellOwner = owner ? '' : ' Let the newsroom’s owner know if it keeps happening.';
  switch (item.kind) {
    case 'run_failed':
      return `${failureReason(item.detail)} ${
        owner
          ? `Once that’s fixed, start a new search with “Find today’s stories”${tonight}. Articles it had already found are picked up by the next search.`
          : `The owner can start a new search once it’s fixed${scheduled ? '; otherwise tonight’s edition tries again' : ''}.`
      }`;
    case 'run_retrying':
      return `${failureReason(item.detail)} Nothing to do yet: the next attempt resumes where it stopped, without searching again. If the last attempt fails, this moves to Needs attention.`;
    case 'run_stuck':
      return item.automatic
        ? 'Nothing to do yet: an automatic retry should pick it up where it stopped. If it doesn’t, this moves to Needs attention.'
        : owner
          ? `Start a new search with “Find today’s stories”${tonight}. If searches keep stopping, check the background worker (Trigger.dev).`
          : `The owner can start a new search${scheduled ? '; otherwise tonight’s edition runs as usual' : ''}.`;
    case 'sources_failed':
      return 'Usually temporary, and the stories were assessed from what could be read. Worth a look only if it happens every night.';
    case 'assessment_failed':
      return 'Those stories weren’t included in the edition. If it keeps happening, check the AI service.';
    case 'task_retrying':
      return 'Nothing to do: it’s being retried automatically. If the last attempt fails, or retrying stops, it moves to Needs attention.';
    case 'task_stalled':
    case 'task_failed': {
      const stalled = item.kind === 'task_stalled';
      const lead = stalled ? 'The earlier attempt won’t continue. ' : '';
      switch (item.task?.kind) {
        case 'research':
          return `${lead}Open the story’s research and choose “Try again”.`;
        case 'chat':
          return `${lead}Ask the question again in the story’s research conversation.`;
        case 'generate':
          return `${lead}Open the story’s drafts and generate it again.`;
        case 'discovery.evaluate':
          return `${lead}The story is left out of its edition.${
            owner
              ? ' If it keeps happening, check the AI service and the background worker.'
              : tellOwner
          }`;
        default:
          return owner
            ? `${lead}Open the technical detail, or pass it to whoever looks after the newsroom’s systems.`
            : `${lead}${tellOwner.trim()}`;
      }
    }
    default:
      return 'Open the technical detail, or pass it to whoever looks after the newsroom’s systems.';
  }
}

/** Where to go to act on it: the story's research for story work, otherwise the edition. */
export function attentionLink(item: AttentionCopyInput): { href: string; label: string } | null {
  const storyId = item.task?.storyId;
  if (!storyId || item.automatic) return null;
  if (item.task?.kind === 'research' || item.task?.kind === 'chat')
    return { href: `/stories/${storyId}/research`, label: 'Open the research' };
  if (item.task?.kind === 'generate')
    return { href: `/stories/${storyId}/studio`, label: 'Open the drafts' };
  return { href: `/stories/${storyId}`, label: 'Open the story' };
}
