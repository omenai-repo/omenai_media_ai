import { describe, expect, it } from 'vitest';

import { editionChoices, editionWhen, OUTCOME_SHORT, outcomeShort } from './copy';
import { leadStatus, planEdition } from './edition-plan';

/**
 * The Newsroom is laid out from an edition's data alone: these cover the shapes any edition can
 * take, not particular editions.
 */
const story = (id: string, image = true) => ({ id, image: image ? { url: `${id}.jpg` } : null });

describe('edition layout plan', () => {
  const edition = (n: number) => Array.from({ length: n }, (_, i) => story(`s${i + 1}`));
  const sides = (plan: ReturnType<typeof planEdition>) => plan.bands.map((b) => b.side);

  it('has no lead and no further sections for an empty edition', () => {
    expect(planEdition([])).toEqual({
      lead: null,
      bands: [],
      columns: [],
      ranked: [],
      hasMore: false,
    });
  });

  it('shows a lone story as the lead only', () => {
    const plan = planEdition([story('a')]);
    expect(plan.lead?.id).toBe('a');
    expect(plan).toMatchObject({ bands: [], columns: [], ranked: [], hasMore: false });
  });

  it('keeps rank order at every edition size', () => {
    for (let n = 2; n <= 9; n += 1) {
      const stories = edition(n);
      const plan = planEdition(stories);
      const order = [
        plan.lead,
        ...plan.bands.map((b) => b.story),
        ...plan.columns.map((c) => c.story),
        ...plan.ranked,
      ].map((s) => s?.id);
      expect(order).toEqual(stories.map((s) => s.id));
      expect(plan.hasMore).toBe(true);
    }
  });

  it('never leaves a story alone in a row of columns: fewer than three continue the bands', () => {
    for (let n = 2; n <= 9; n += 1) {
      const plan = planEdition(edition(n));
      expect([0, 3]).toContain(plan.columns.length);
    }
    expect(sides(planEdition(edition(2)))).toEqual(['left']);
    expect(sides(planEdition(edition(3)))).toEqual(['left', 'right']);
    expect(sides(planEdition(edition(4)))).toEqual(['left', 'right', 'left']);
    for (const n of [5, 6, 8]) {
      const plan = planEdition(edition(n));
      expect(sides(plan)).toEqual(['left']);
      expect(plan.columns).toHaveLength(3);
      expect(plan.ranked).toHaveLength(n - 5);
    }
  });

  it('shapes each column from its own image: text-led without one', () => {
    const plan = planEdition([story('a'), story('b'), story('c', false), story('d'), story('e')]);
    expect(plan.columns.map((c) => c.shape)).toEqual(['text', 'portrait', 'landscape']);
  });
});

describe('lead status', () => {
  const research = (state: 'none' | 'running' | 'ready' | 'failed') => ({ state });
  it('is words only: no scores, counts or numbers', () => {
    const words = leadStatus(
      { score: { total: 96, band: 'priority', confidence: 'high' }, editorialState: 'saved' },
      research('ready'),
      { writing: false, versions: 4 },
    );
    expect(words).toEqual(['priority', 'saved', 'researched', 'drafts started']);
    expect(words.join(' ')).not.toMatch(/\d/);
  });

  it('omits what the records don’t say', () => {
    expect(
      leadStatus(
        { score: { total: 70, band: 'shortlist', confidence: null }, editorialState: 'none' },
        null,
        null,
      ),
    ).toEqual([]);
    expect(
      leadStatus(
        { score: { total: null, band: null, confidence: null }, editorialState: 'skipped' },
        research('running'),
        { writing: true, versions: 2 },
      ),
    ).toEqual(['skipped', 'research in progress', 'draft under way']);
  });
});

describe('edition wording', () => {
  it('names a nightly edition by its day and ready time', () => {
    const run = {
      runKey: 'daily-discovery:2026-10-18',
      completedAt: '2026-10-18T06:07:00.000Z',
    };
    expect(editionWhen(run)).toEqual({
      day: 'Sunday, 18 October 2026',
      shortDay: '18 Oct 2026',
      time: 'ready 01:07 CDT',
      byHand: false,
    });
  });

  it('names an edition started by hand by its start, never as an "extra edition"', () => {
    const run = { runKey: 'manual:2026-10-16T15:08:00.000Z', completedAt: null };
    expect(editionWhen(run)).toEqual({
      day: 'Friday, 16 October 2026',
      shortDay: '16 Oct 2026',
      time: '10:08 CDT',
      byHand: true,
    });
  });

  it('lists each edition as its day, then its stories and time, the newest as the latest', () => {
    const choices = editionChoices([
      {
        runKey: 'daily-discovery:2026-10-18',
        completedAt: '2026-10-18T06:07:00.000Z',
        shortlisted: 8,
      },
      {
        runKey: 'daily-discovery:2026-10-17',
        completedAt: '2026-10-17T05:52:00.000Z',
        shortlisted: 1,
      },
      {
        runKey: 'manual:2026-10-16T15:08:00.000Z',
        completedAt: '2026-10-16T15:40:00.000Z',
        shortlisted: 0,
      },
    ]);
    expect(choices).toEqual([
      {
        runKey: 'daily-discovery:2026-10-18',
        day: 'Sunday 18 October',
        detail: '8 stories · ready 01:07 CDT',
        time: 'ready 01:07 CDT',
        byHand: false,
        latest: true,
      },
      {
        runKey: 'daily-discovery:2026-10-17',
        day: 'Saturday 17 October',
        detail: '1 story · ready 00:52 CDT',
        time: 'ready 00:52 CDT',
        byHand: false,
        latest: false,
      },
      {
        runKey: 'manual:2026-10-16T15:08:00.000Z',
        day: 'Friday 16 October',
        detail: 'No stories · started 10:08 CDT',
        time: 'started 10:08 CDT',
        byHand: true,
        latest: false,
      },
    ]);
    for (const choice of choices) expect(`${choice.day} ${choice.detail}`).not.toMatch(/extra/i);
  });

  it('shows the year only for an edition from another year than the latest', () => {
    const [latest, older] = editionChoices([
      { runKey: 'daily-discovery:2027-01-01', completedAt: null, shortlisted: 5 },
      { runKey: 'daily-discovery:2026-12-31', completedAt: null, shortlisted: 6 },
    ]);
    expect(latest?.day).toBe('Friday 1 January');
    expect(older?.day).toBe('Thursday 31 December 2026');
  });

  it('never invents a day or a time the records don’t give', () => {
    const [unready, unknown, unreadable] = editionChoices([
      { runKey: 'daily-discovery:2026-10-18', completedAt: null, shortlisted: 2 },
      { runKey: 'other:1', completedAt: null, shortlisted: 1 },
      { runKey: 'manual:not-a-date', completedAt: null, shortlisted: 0 },
    ]);
    expect(unready).toMatchObject({ day: 'Sunday 18 October', detail: '2 stories', time: null });
    expect(unknown).toMatchObject({ day: 'An edition', detail: '1 story', byHand: false });
    expect(unreadable).toMatchObject({ day: 'An edition', detail: 'No stories', byHand: true });
  });

  it('gives every outcome a short tag that reads as one unit', () => {
    for (const tag of Object.values(OUTCOME_SHORT)) expect(tag.length).toBeLessThanOrEqual(17);
    expect(outcomeShort('gate_hold')).toBe('Needs checking');
    expect(outcomeShort('something_new')).toBe('Reviewed');
  });
});
