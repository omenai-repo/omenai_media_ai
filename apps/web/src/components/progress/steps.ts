import {
  CHAT_STEPS,
  DRAFT_STEPS,
  RESEARCH_STEPS,
  type ChatStep,
  type DraftStep,
  type ResearchStep,
  type StepCounts,
  type StepNotice,
  type StepRecord,
} from '@repo/shared';

/**
 * Every word the progress displays use, and how a task's recorded steps become a list. Only steps
 * the work recorded are shown as done or under way (`@repo/shared` progress): a step the work went
 * past without doing is shown as skipped, and one that happens only sometimes isn't listed until it
 * does. Nothing here is invented to fill a wait.
 */

export type StepState = 'done' | 'now' | 'next' | 'skipped';

export interface StepView {
  id: string;
  state: StepState;
  label: string;
}

interface StepCopy {
  /** While it runs (with what it works from), and before it starts. */
  label: (counts: StepCounts) => string;
  /** Once it's done: what it found. */
  done: (counts: StepCounts) => string;
  /** When the work went past it without doing it. */
  skipped?: string;
  /** Listed only once reached: it happens only sometimes. */
  conditional?: boolean;
}

const count = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;

function researchCopy(lead: boolean): Record<ResearchStep, StepCopy> {
  return {
    sources: {
      label: () => 'Gathering the story’s own sources',
      done: (c) =>
        c.sources
          ? `Gathered the story’s ${count(c.sources, 'source')}`
          : 'The story had no sources of its own',
    },
    search: {
      label: () => (lead ? 'Looking for coverage of your question' : 'Looking for more coverage'),
      done: (c) => {
        if (c.reused !== undefined)
          return c.reused
            ? `Used the ${count(c.reused, 'article')} found on the last attempt`
            : 'The last attempt found nothing new';
        if (c.found)
          return `Found ${count(c.found, 'new article')}${
            c.setAside
              ? ` and set aside ${c.setAside} that ${c.setAside === 1 ? 'wasn’t' : 'weren’t'} about this story`
              : ''
          }`;
        return c.setAside
          ? `Found nothing new about this story (${count(c.setAside, 'result')} set aside)`
          : 'Found no new coverage';
      },
    },
    read: {
      label: (c) =>
        c.articles ? `Reading ${count(c.articles, 'new article')}` : 'Reading new articles',
      done: (c) => `Read ${count(c.articles ?? 0, 'new article')}`,
      skipped: 'Nothing new to read',
    },
    write: {
      label: (c) => {
        const from = c.sources ? ` from ${count(c.sources, 'source')}` : '';
        return lead ? `Answering your question${from}` : `Writing your brief${from}`;
      },
      done: () => (lead ? 'Answer written' : 'Brief written'),
    },
    check: {
      label: () => 'Checking each quote against its source',
      done: () => 'Quotes checked',
    },
  };
}

function draftCopy(unit: 'words' | 'characters'): Record<DraftStep, StepCopy> {
  return {
    research: {
      label: () => 'Gathering your research',
      done: (c) =>
        `Gathered ${count(c.briefs ?? 0, 'research brief')} and ${count(c.sources ?? 0, 'source')}`,
    },
    write: { label: () => 'Writing your draft', done: () => 'Draft written' },
    statements: {
      label: () => 'Listing its statements so they can be checked',
      done: () => 'Statements listed',
    },
    shorten: {
      label: (c) =>
        c.length && c.limit
          ? `Shortening it: it came out at ${count(c.length, unit.slice(0, -1), unit)}, and the limit is ${c.limit.toLocaleString('en-GB')}`
          : 'Shortening it to fit',
      done: () => 'Shortened to fit',
      conditional: true,
    },
    check: {
      label: () => 'Checking each statement’s quote against its source',
      done: () => 'Quotes checked',
    },
    save: { label: () => 'Saving it as a new version', done: () => 'Saved' },
  };
}

const CHAT_COPY: Record<ChatStep, StepCopy> = {
  read: {
    label: () => 'Reading the story and its research',
    done: (c) =>
      `Read ${count(c.briefs ?? 0, 'research brief')} and ${count(c.sources ?? 0, 'source')}`,
  },
  compose: { label: () => 'Putting together an answer', done: () => 'Answer under way' },
  write: { label: () => 'Writing the answer', done: () => 'Answer written' },
  check: { label: () => 'Checking each quote against its source', done: () => 'Quotes checked' },
};

/** Where the work has got to: the current step and every step it recorded in this attempt. */
export interface RecordedProgress {
  step: string | null;
  steps: ReadonlyArray<Pick<StepRecord<string>, 'step' | 'counts'>>;
}

function stepViews<S extends string>(
  order: readonly S[],
  copy: Record<S, StepCopy>,
  progress: RecordedProgress,
): StepView[] {
  const known = (step: string | null): step is S => step !== null && order.includes(step as S);
  const reached = new Map(
    progress.steps.flatMap((s) => (known(s.step) ? [[s.step, s.counts ?? {}] as const] : [])),
  );
  const furthest = Math.max(
    -1,
    ...[...reached.keys(), progress.step].filter(known).map((step) => order.indexOf(step)),
  );
  return order.flatMap((id, i): StepView[] => {
    const text = copy[id];
    const counts = reached.get(id);
    if (id === progress.step) return [{ id, state: 'now', label: text.label(counts ?? {}) }];
    if (counts) return [{ id, state: 'done', label: text.done(counts) }];
    if (text.conditional) return [];
    if (i < furthest) return [{ id, state: 'skipped', label: text.skipped ?? text.label({}) }];
    return [{ id, state: 'next', label: text.label({}) }];
  });
}

export const researchSteps = (progress: RecordedProgress, options: { lead: boolean }) =>
  stepViews(RESEARCH_STEPS, researchCopy(options.lead), progress);

export const draftSteps = (progress: RecordedProgress, unit: 'words' | 'characters') =>
  stepViews(DRAFT_STEPS, draftCopy(unit), progress);

export const chatSteps = (progress: RecordedProgress) => stepViews(CHAT_STEPS, CHAT_COPY, progress);

export const NOTICE_TEXT: Record<StepNotice, string> = {
  retrying: 'The AI service was busy, so Omenai is asking again.',
  repairing:
    'The first response wasn’t in a form we could check, so Omenai is asking for it again.',
};

/**
 * Plain words for why work stopped, from the error it recorded. The raw error stays on the
 * Operations page for diagnosis; editors see what happened and never a stack of codes.
 */
export function failureText(lastError: string | null): string {
  const error = lastError ?? '';
  if (/stopped by the editor/i.test(error)) return 'You stopped it before it finished.';
  if (/worker|background service/i.test(error))
    return 'Omenai couldn’t reach the background service.';
  if (/abandoned/i.test(error)) return 'It stopped responding partway through.';
  if (/didn.t finish within|no time left|timeout|timed out/i.test(error))
    return 'It took longer than expected, so it stopped.';
  if (/connection drop|request failed|terminated|ECONNRESET|socket/i.test(error))
    return 'The connection to the AI service dropped partway through.';
  if (/failed validation|invalid_output|token limit/i.test(error))
    return 'The response wasn’t in a form we could check, so it wasn’t kept.';
  if (/search credits/i.test(error))
    return 'Today’s search limit has been reached. It frees up as earlier searches age out.';
  if (/USAGE_LIMIT|usage limit of \d+/i.test(error))
    return 'Today’s AI usage limit has been reached. It frees up as earlier use ages out.';
  if (/unavailable|overloaded|rate|503|429/i.test(error))
    return 'The AI service was busy and didn’t respond, even after several tries.';
  if (/NO_SOURCES|no sources/i.test(error)) return 'This story has no sources to research yet.';
  return 'Something went wrong, so it stopped.';
}

/**
 * Before the first step: waiting for the background service to start the work, waiting for
 * another attempt after one failed, or started and getting going.
 */
export function waitingText(
  task: {
    status: string;
    step?: string | null;
    attempts: number;
    maxAttempts: number;
    lastError: string | null;
  },
  what: 'research' | 'draft',
): string | null {
  if (task.status === 'running' && !task.step)
    return what === 'research' ? 'Starting your research…' : 'Starting your draft…';
  if (task.status !== 'queued') return null;
  if (task.attempts > 0 && task.lastError)
    return `${failureText(task.lastError)} Omenai will try again shortly (attempt ${task.attempts + 1} of ${task.maxAttempts}).`;
  return what === 'research'
    ? 'Your research is waiting to start.'
    : 'Your draft is waiting to start.';
}

/**
 * How long a stage normally takes before a wait counts as unusual (development timings,
 * 2026-10-16): background work started 5–30 s after it was asked for; the model took 16–21 s to
 * write a brief and 9–18 s for a draft; a chat answer began 3–9 s after the question.
 */
const SLOW_AFTER_MS = {
  waiting: 45_000,
  chatCompose: 15_000,
  chatDeadlineNote: 35_000,
  working: 60_000,
} as const;

/** An honest note when the current stage has run unusually long, or null. */
export function slowText(
  kind: 'chat' | 'research' | 'draft',
  stage: 'waiting' | 'working',
  elapsedMs: number,
): string | null {
  if (kind === 'chat') {
    if (elapsedMs >= SLOW_AFTER_MS.chatDeadlineNote)
      return 'This is taking longer than usual. If no answer arrives within a minute of your question, the reply will stop and you can ask again.';
    return elapsedMs >= SLOW_AFTER_MS.chatCompose ? 'This is taking longer than usual.' : null;
  }
  if (stage === 'waiting')
    return elapsedMs >= SLOW_AFTER_MS.waiting
      ? 'This is taking longer than usual to start. It’s still waiting for the background service to pick it up.'
      : null;
  return elapsedMs >= SLOW_AFTER_MS.working
    ? 'This is taking longer than usual. It’s still running, and you can leave this page.'
    : null;
}
