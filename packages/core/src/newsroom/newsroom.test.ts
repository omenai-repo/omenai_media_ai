import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getModels } from '../db/models.js';
import { NotFoundError } from '../errors.js';
import { startTestDatabase, type TestDatabase } from '../testing/index.js';
import { FIXTURE_RUNS, seedFixtureNewsroom } from '../testing/seed.js';
import { decideStory } from './decisions.js';
import {
  getNewsroom,
  getRunDetail,
  getStoryDetail,
  listRuns,
  listSavedStories,
  usageSince,
} from './queries.js';

let db: TestDatabase;
beforeAll(async () => {
  db = await startTestDatabase();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  await seedFixtureNewsroom();
});

describe('newsroom read models (fixture data)', () => {
  it('shows the latest completed run’s shortlist, in rank order', async () => {
    const latest = await getNewsroom();
    expect(latest.run?.runKey).toBe(FIXTURE_RUNS.day2);
    expect(latest.shortlist.map((s) => s.rank)).toEqual([1]);
    expect(latest.shortlist[0]?.headline).toMatch(/auction record/);
    expect(latest.recentRuns.map((r) => r.runKey)).toEqual([FIXTURE_RUNS.day2, FIXTURE_RUNS.day1]);

    const day1 = await getNewsroom(FIXTURE_RUNS.day1);
    expect(day1.shortlist.map((s) => s.score.total)).toEqual([86, 74]);
    expect(day1.shortlist[1]?.publishers).toHaveLength(2);
    expect(day1.run?.shortfallReasons.map((r) => r.code)).toEqual([
      'editorial_gates',
      'below_threshold',
    ]);
  });

  it('explains every other reviewed story in plain language, and carries a representative image', async () => {
    const day1 = await getNewsroom(FIXTURE_RUNS.day1);
    expect(day1.run).toMatchObject({ storiesReviewed: 6, shortlisted: 2 });
    expect(day1.reviewed).toHaveLength(4);
    for (const story of day1.reviewed) {
      expect(story.reason).not.toMatch(/[a-z]+_[a-z]+|exclusion:|critical:/);
      expect(story.reason.length).toBeGreaterThan(10);
    }
    expect(day1.reviewed.map((r) => r.reason)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/thin list/),
        expect.stringMatching(/our bar is 65/),
      ]),
    );
    expect(day1.shortlist[0]?.image?.url).toContain('picsum.photos');
    expect(day1.shortlist[0]?.image?.publisher).toBeTruthy();
  });

  it('returns an empty newsroom for an unknown or unfinished run', async () => {
    expect((await getNewsroom('daily-discovery:2020-01-01')).run).toBeNull();
  });

  it('gives the full recommendation card for a story', async () => {
    const { shortlist } = await getNewsroom(FIXTURE_RUNS.day1);
    const story = await getStoryDetail(shortlist[0]!.id);
    expect(story.dimensions).toHaveLength(8);
    expect(story.gates.every((g) => g.outcome === 'pass')).toBe(true);
    expect(story.sources[0]?.url).toMatch(/^https:\/\//);
    expect(story.sources[0]?.publisher.length).toBeGreaterThan(0);
    expect(story.editorialTest.answer).toMatch(/^This matters/);
    expect(story.recommendations).toEqual([
      expect.objectContaining({ runKey: FIXTURE_RUNS.day1, rank: 1 }),
    ]);
    // The skipped retrospective links to its later development.
    expect(story.developments.map((d) => d.headline)).toEqual([
      expect.stringMatching(/auction record/),
    ]);
    await expect(getStoryDetail('not-an-id')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('records save and skip decisions with an audit trail', async () => {
    const { shortlist } = await getNewsroom(FIXTURE_RUNS.day1);
    const gele = shortlist[1]!;
    await decideStory({
      storyId: gele.id,
      userId: 'editor-1',
      decision: 'save',
      reason: 'Feature idea',
    });
    expect((await listSavedStories()).map((s) => s.id)).toEqual([gele.id]);

    await decideStory({ storyId: gele.id, userId: 'editor-1', decision: 'unsave' });
    expect(await listSavedStories()).toEqual([]);
    const detail = await getStoryDetail(gele.id);
    expect(detail.decisions.map((d) => d.action)).toEqual(['unsaved', 'saved']);
    expect(detail.decisions[1]?.reason).toBe('Feature idea');
    await expect(
      decideStory({ storyId: '0123456789abcdef01234567', userId: 'x', decision: 'skip' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('accounts for every candidate in the run detail, with usage', async () => {
    const { AiUsage } = await getModels();
    await AiUsage.create([
      {
        provider: 'tavily',
        kind: 'search',
        operation: 'discovery.search',
        units: 1,
        outcome: 'ok',
        runKey: FIXTURE_RUNS.day1,
      },
      {
        provider: 'gemini',
        kind: 'llm',
        operation: 'discovery.evaluate',
        model: 'm',
        inputTokens: 100,
        outputTokens: 40,
        outcome: 'ok',
        runKey: FIXTURE_RUNS.day1,
      },
      {
        provider: 'gemini',
        kind: 'llm',
        operation: 'discovery.evaluate',
        model: 'm',
        outcome: 'error',
        errorKind: 'unavailable',
        runKey: FIXTURE_RUNS.day1,
      },
    ]);
    const detail = await getRunDetail(FIXTURE_RUNS.day1);
    expect(detail.outcomes).toHaveLength(6);
    expect(detail.outcomes.every((o) => o.headline.length > 0)).toBe(true);
    expect(detail.outcomes.every((o) => o.reason.length > 10)).toBe(true);
    expect(detail.funnel?.qualified).toBe(2);
    expect(detail.usage.find((u) => u.operation === 'discovery.evaluate')).toMatchObject({
      calls: 2,
      errors: 1,
      inputTokens: 100,
    });
    expect(detail.usage.find((u) => u.provider === 'tavily')?.units).toBe(1);
    expect((await usageSince(7, new Date())).length).toBeGreaterThan(0);
    expect((await listRuns()).map((r) => r.runKey)).toContain(FIXTURE_RUNS.day1);
    await expect(getRunDetail('manual:nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});
