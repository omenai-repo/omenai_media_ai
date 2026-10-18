import { describe, expect, it } from 'vitest';

import {
  chatSteps,
  draftSteps,
  failureText,
  researchSteps,
  slowText,
  waitingText,
  type RecordedProgress,
} from './steps';

const progress = (
  step: string | null,
  steps: Array<[string, Record<string, number> | null]>,
): RecordedProgress => ({ step, steps: steps.map(([s, counts]) => ({ step: s, counts })) });

const view = (steps: ReturnType<typeof researchSteps>) =>
  steps.map((s) => `${s.state}: ${s.label}`);

describe('research progress', () => {
  it('lists only what happened as done, with what each step found', () => {
    const steps = researchSteps(
      progress('write', [
        ['sources', { sources: 3 }],
        ['search', { found: 2, setAside: 1 }],
        ['read', { articles: 2 }],
        ['write', { sources: 5 }],
      ]),
      { lead: false },
    );
    expect(view(steps)).toEqual([
      'done: Gathered the story’s 3 sources',
      'done: Found 2 new articles and set aside 1 that wasn’t about this story',
      'done: Read 2 new articles',
      'now: Writing your brief from 5 sources',
      'next: Checking each quote against its source',
    ]);
  });

  it('shows reading as skipped when nothing new was found, never as done', () => {
    const steps = researchSteps(
      progress('write', [
        ['sources', { sources: 1 }],
        ['search', { found: 0, setAside: 0 }],
        ['write', { sources: 1 }],
      ]),
      { lead: true },
    );
    expect(view(steps)).toEqual([
      'done: Gathered the story’s 1 source',
      'done: Found no new coverage',
      'skipped: Nothing new to read',
      'now: Answering your question from 1 source',
      'next: Checking each quote against its source',
    ]);
  });

  it('says when a retry reused what the first attempt found', () => {
    const steps = researchSteps(
      progress('search', [
        ['sources', { sources: 2 }],
        ['search', { reused: 3 }],
      ]),
      { lead: false },
    );
    expect(steps[1]).toMatchObject({ state: 'now', label: 'Looking for more coverage' });
    const after = researchSteps(
      progress('write', [
        ['sources', { sources: 2 }],
        ['search', { reused: 3 }],
        ['write', { sources: 5 }],
      ]),
      { lead: false },
    );
    expect(after[1]!.label).toBe('Used the 3 articles found on the last attempt');
  });

  it('shows every step as still to come while waiting to start', () => {
    expect(
      researchSteps(progress(null, []), { lead: false }).every((s) => s.state === 'next'),
    ).toBe(true);
  });
});

describe('draft progress', () => {
  it('lists shortening only when it happened, with the real length and limit', () => {
    const plain = draftSteps(
      progress('check', [
        ['research', { briefs: 2, sources: 9 }],
        ['write', null],
        ['statements', null],
        ['check', null],
      ]),
      'characters',
    );
    expect(plain.map((s) => s.id)).not.toContain('shorten');
    expect(plain[0]!.label).toBe('Gathered 2 research briefs and 9 sources');

    const shortened = draftSteps(
      progress('shorten', [
        ['research', { briefs: 1, sources: 4 }],
        ['write', null],
        ['statements', null],
        ['shorten', { length: 312, limit: 280 }],
      ]),
      'characters',
    );
    expect(shortened.find((s) => s.id === 'shorten')).toEqual({
      id: 'shorten',
      state: 'now',
      label: 'Shortening it: it came out at 312 characters, and the limit is 280',
    });
  });

  it('never claims a fact-check: the check is of quotes against sources', () => {
    const labels = draftSteps(progress(null, []), 'words').map((s) => s.label.toLowerCase());
    expect(labels.join(' ')).not.toMatch(/fact|verif/);
  });
});

describe('chat progress', () => {
  it('reads the research first, then puts the answer together', () => {
    expect(
      view(
        chatSteps(
          progress('compose', [
            ['read', { briefs: 2, sources: 12 }],
            ['compose', null],
          ]),
        ),
      ),
    ).toEqual([
      'done: Read 2 research briefs and 12 sources',
      'now: Putting together an answer',
      'next: Writing the answer',
      'next: Checking each quote against its source',
    ]);
  });
});

describe('waiting, slow and failed work', () => {
  const queued = { status: 'queued', attempts: 0, maxAttempts: 3, lastError: null };

  it('tells waiting to start apart from waiting to try again', () => {
    expect(waitingText(queued, 'research')).toBe('Your research is waiting to start.');
    expect(waitingText({ ...queued, attempts: 1, lastError: 'unavailable: 503' }, 'draft')).toBe(
      'The AI service was busy and didn’t respond, even after several tries. Omenai will try again shortly (attempt 2 of 3).',
    );
    // Started, but its first step isn't on record yet: say so rather than show nothing under way.
    expect(waitingText({ ...queued, status: 'running' }, 'draft')).toBe('Starting your draft…');
    expect(waitingText({ ...queued, status: 'running', step: 'write' }, 'draft')).toBeNull();
  });

  it('says a stage is slow only after it has run unusually long', () => {
    expect(slowText('research', 'waiting', 10_000)).toBeNull();
    expect(slowText('research', 'waiting', 50_000)).toMatch(/longer than usual to start/);
    expect(slowText('draft', 'working', 30_000)).toBeNull();
    expect(slowText('draft', 'working', 70_000)).toMatch(/still running/);
    expect(slowText('chat', 'working', 5_000)).toBeNull();
    expect(slowText('chat', 'working', 20_000)).toBe('This is taking longer than usual.');
    expect(slowText('chat', 'working', 40_000)).toMatch(/within a minute of your question/);
  });

  it('explains failures in plain words, keeping the difference between limits', () => {
    expect(failureText('chat.reply: the AI service didn’t finish within 55 s.')).toBe(
      'It took longer than expected, so it stopped.',
    );
    expect(
      failureText(
        'The usage limit of 20 search credits in 24 hours would be passed (SEARCH_DAILY_CREDIT_LIMIT; 20 used).',
      ),
    ).toMatch(/search limit/);
    expect(failureText('The usage limit of 60 AI calls in 24 hours has been reached')).toMatch(
      /AI usage limit/,
    );
    expect(failureText('draft.generate: output failed validation after a repair attempt.')).toBe(
      'The response wasn’t in a form we could check, so it wasn’t kept.',
    );
    expect(failureText('TypeError: x is undefined')).toBe('Something went wrong, so it stopped.');
  });
});
