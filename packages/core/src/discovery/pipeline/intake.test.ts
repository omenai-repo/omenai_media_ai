/**
 * Fair, bounded intake (ADR-042), across extraction, triage, clustering and evaluation. Fixtures
 * only (fake search, scripted model, in-memory MongoDB). Each cap still bounds a run's work; what
 * these tests pin is that over-cap work waits instead of being dropped, that queries take turns,
 * that nothing is processed twice, and that every article and story is accounted for.
 */
import type { RunFunnel } from '@repo/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getModels } from '../../db/models.js';
import { intakeHit as hit, intakeLlm, queryAwareSearch } from '../../testing/intake-fixtures.js';
import { startTestDatabase, type TestDatabase } from '../../testing/index.js';
import { readDiscoveryConfig, type DiscoveryConfig } from '../config.js';
import { getRun } from '../runs.js';
import { markEvaluationFailed } from './evaluate.js';
import { runDiscoveryInline } from './run-inline.js';
import type { DiscoveryDeps } from './context.js';

let db: TestDatabase;
beforeAll(async () => {
  db = await startTestDatabase();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
});

const base = readDiscoveryConfig({});
const day = (d: string) => `daily-discovery:${d}`;

function deps(
  llm: DiscoveryDeps['llm'],
  search: DiscoveryDeps['search'],
  config: Partial<DiscoveryConfig>,
  iso: string,
): DiscoveryDeps {
  return { llm, search, config: { ...base, ...config }, now: () => new Date(iso) };
}

const run = (runKey: string, d: DiscoveryDeps) =>
  runDiscoveryInline({ runKey, trigger: 'schedule', owner: 'w', deps: d });

/**
 * Every discovery article in exactly one state, and every story in exactly one state. Throws if
 * anything is in none (lost) or in two (double-counted).
 */
async function ledger() {
  const { SourceArticle, Story } = await getModels();
  const articles = await SourceArticle.find({ origin: 'discovery' }).lean();
  const articleStates = {
    waitingToExtract: (a: (typeof articles)[number]) => a.extractionStatus === 'pending',
    expiredBeforeExtract: (a: (typeof articles)[number]) => a.extractionStatus === 'expired',
    readNotTriaged: (a: (typeof articles)[number]) =>
      ['extracted', 'failed'].includes(a.extractionStatus) && !a.triage,
    outOfScope: (a: (typeof articles)[number]) => a.triage?.inScope === false,
    inStory: (a: (typeof articles)[number]) => a.storyIds.length > 0,
    waitingToCluster: (a: (typeof articles)[number]) =>
      a.triage?.inScope === true && a.storyIds.length === 0 && !a.expiredAt,
    expiredBeforeCluster: (a: (typeof articles)[number]) =>
      a.triage?.inScope === true && a.storyIds.length === 0 && !!a.expiredAt,
  };
  const counts = Object.fromEntries(Object.keys(articleStates).map((k) => [k, 0])) as Record<
    keyof typeof articleStates,
    number
  >;
  for (const article of articles) {
    const states = Object.entries(articleStates).filter(([, is]) => is(article));
    expect(
      states.map(([k]) => k),
      article.originalHeadline,
    ).toHaveLength(1);
    counts[states[0]![0] as keyof typeof articleStates] += 1;
  }
  const stories = await Story.find().lean();
  const storyStates: Record<string, number> = {};
  for (const story of stories) {
    const state = story.evaluation?.status ?? 'missing';
    expect(['evaluated', 'pending', 'failed', 'expired']).toContain(state);
    storyStates[state] = (storyStates[state] ?? 0) + 1;
  }
  return { articles: counts, stories: storyStates, total: articles.length };
}

describe('extraction', () => {
  it('keeps over-cap articles waiting and reads them in a later run, oldest first', async () => {
    const search = queryAwareSearch([
      [0.9, 0.8, 0.7, 0.6].map((s, i) => hit(`a${i}`, `Article ${i}`, s)),
    ]);
    const { llm } = intakeLlm();
    const config = { maxQueries: 1, maxExtract: 2 };
    await run(day('2026-10-15'), deps(llm, search.client, config, '2026-10-15T05:00:00Z'));
    expect((await getRun(day('2026-10-15')))?.funnel).toMatchObject({ waitingToExtract: 2 });

    search.setLists([[hit('fresh', 'Fresh article', 0.99)]]);
    await run(day('2026-10-16'), deps(llm, search.client, config, '2026-10-16T05:00:00Z'));
    const { SourceArticle } = await getModels();
    // Day 1's backlog went first, even though the new article scored higher.
    const day2 = await SourceArticle.find({ intakeRunKey: day('2026-10-16') }).lean();
    expect(day2.map((a) => a.originalHeadline).sort()).toEqual(['Article 2', 'Article 3']);
    expect(
      (await SourceArticle.findOne({ originalHeadline: 'Fresh article' }).lean())?.extractionStatus,
    ).toBe('pending');
    expect(new Set(search.extractedUrls).size).toBe(search.extractedUrls.length);
  });

  it('lets each query take turns instead of comparing scores across queries', async () => {
    const strong = [0.95, 0.94, 0.93].map((s, i) => hit(`q1-${i}`, `First query ${i}`, s));
    const weak = [0.41, 0.4, 0.39].map((s, i) => hit(`q2-${i}`, `Second query ${i}`, s));
    const search = queryAwareSearch([strong, weak]);
    const { llm } = intakeLlm();
    await run(
      day('2026-10-15'),
      deps(llm, search.client, { maxQueries: 2, maxExtract: 4 }, '2026-10-15T05:00:00Z'),
    );
    const { SourceArticle } = await getModels();
    const extracted = await SourceArticle.find({ extractionStatus: 'extracted' }).lean();
    const lanes = extracted.map((a) => a.originalHeadline.split(' ')[0]);
    expect(lanes.filter((l) => l === 'First')).toHaveLength(2);
    expect(lanes.filter((l) => l === 'Second')).toHaveLength(2);
  });

  it('marks a waiting article expired once it ages past the freshness window, and counts it', async () => {
    const search = queryAwareSearch([
      [0.9, 0.8, 0.7].map((s, i) => hit(`e${i}`, `Ageing ${i}`, s)),
    ]);
    const { llm } = intakeLlm();
    const config = { maxQueries: 1, maxExtract: 1 };
    await run(day('2026-10-15'), deps(llm, search.client, config, '2026-10-15T05:00:00Z'));
    search.setLists([[]]);
    // 20 days later: the two that waited are older than the 14-day window.
    await run(
      day('2026-11-04'),
      deps(llm, search.client, { ...config, maxExtract: 0 }, '2026-11-04T05:00:00Z'),
    );
    expect((await getRun(day('2026-11-04')))?.funnel).toMatchObject({ expiredBeforeExtract: 2 });
    expect((await getRun(day('2026-11-04')))?.shortfallReasons.map((r) => r.code)).toContain(
      'expired_unprocessed',
    );
    expect((await ledger()).articles.expiredBeforeExtract).toBe(2);
  });
});

describe('clustering', () => {
  it('groups over-cap in-scope articles in a later run instead of dropping them', async () => {
    const search = queryAwareSearch([
      [0.9, 0.8, 0.7, 0.6].map((s, i) => hit(`c${i}`, `Piece ${i}`, s)),
    ]);
    const { llm } = intakeLlm();
    const config = { maxQueries: 1, clusterMaxItems: 2 };
    await run(day('2026-10-15'), deps(llm, search.client, config, '2026-10-15T05:00:00Z'));
    expect((await getRun(day('2026-10-15')))?.funnel).toMatchObject({ waitingToCluster: 2 });
    search.setLists([[]]);
    await run(day('2026-10-16'), deps(llm, search.client, config, '2026-10-16T05:00:00Z'));
    const { SourceArticle } = await getModels();
    expect(
      await SourceArticle.countDocuments({ 'triage.inScope': true, storyIds: { $size: 0 } }),
    ).toBe(0);
  });
});

describe('evaluation', () => {
  it('never lets newer multi-source stories overtake a waiting single-source one', async () => {
    const topic = (tag: string) =>
      Array.from({ length: 2 }, (_, i) =>
        hit(`${tag}-${i}`, `Topic-${tag} report ${i}`, 0.9 - i / 10),
      );
    const search = queryAwareSearch([
      [...topic('B'), hit('solo', 'Topic-Solo single report', 0.5)],
    ]);
    const { llm } = intakeLlm();
    const config = { maxQueries: 1, maxEvaluations: 1 };
    await run(day('2026-10-15'), deps(llm, search.client, config, '2026-10-15T05:00:00Z'));
    search.setLists([topic('C')]);
    await run(day('2026-10-16'), deps(llm, search.client, config, '2026-10-16T05:00:00Z'));
    const { Story } = await getModels();
    const solo = await Story.findOne({ headline: /Topic-Solo/ }).lean();
    // Day 1 assessed B (the higher-ranked lead in the same batch); day 2 took the waiting solo
    // story before the newer C, whatever their article counts.
    expect(solo?.evaluation).toMatchObject({ status: 'evaluated', runKey: day('2026-10-16') });
    expect((await Story.findOne({ headline: /Topic-C/ }).lean())?.evaluation?.status).toBe(
      'pending',
    );
  });

  it('retries a failed assessment once in the next run, then stops', async () => {
    const search = queryAwareSearch([[hit('fragile', 'Fragile development', 0.9)]]);
    const { llm, calls } = intakeLlm({ failEvaluationFor: /Fragile/ });
    const config = { maxQueries: 1 };
    const evaluations = () => calls.filter((c) => c.operation === 'evaluate').length;
    await run(day('2026-10-15'), deps(llm, search.client, config, '2026-10-15T05:00:00Z'));
    const first = evaluations();
    search.setLists([[]]);
    await run(day('2026-10-16'), deps(llm, search.client, config, '2026-10-16T05:00:00Z'));
    expect(evaluations()).toBeGreaterThan(first);
    const second = evaluations();
    await run(day('2026-10-17'), deps(llm, search.client, config, '2026-10-17T05:00:00Z'));
    expect(evaluations()).toBe(second);
    const { Story } = await getModels();
    expect((await Story.findOne({ headline: /Fragile/ }).lean())?.evaluation).toMatchObject({
      status: 'failed',
      failedRuns: 2,
    });
  });
});

it('records the thresholds, caps and models a run used, once, at its start', async () => {
  const search = queryAwareSearch([[hit('x', 'Topic-X report', 0.9)]]);
  const { llm, failNextWithOutage } = intakeLlm();
  failNextWithOutage('triage');
  await expect(
    run(
      day('2026-10-15'),
      deps(llm, search.client, { maxQueries: 1, maxExtract: 7 }, '2026-10-15T05:00:00Z'),
    ),
  ).rejects.toThrow(/outage/);
  // The resumed attempt runs with other settings; the record keeps the first.
  await run(
    day('2026-10-15'),
    deps(llm, search.client, { maxQueries: 1, maxExtract: 9 }, '2026-10-15T06:00:00Z'),
  );
  expect((await getRun(day('2026-10-15')))?.config).toMatchObject({
    shortlistThreshold: 65,
    priorityThreshold: 80,
    maxExtract: 7,
    models: { triage: 'fake-triage', primary: 'fake-primary', escalation: 'fake-escalation' },
  });
});

it('counts a failure once per run, however often it is reported', async () => {
  const { Story } = await getModels();
  const story = await Story.create({
    headline: 'Topic-F',
    firstSeenRunKey: day('2026-10-15'),
    lastCandidateRunKey: day('2026-10-15'),
  });
  // A worker's final attempt and a resumed run can both report the same failure.
  await markEvaluationFailed(day('2026-10-15'), String(story._id), 'outage');
  await markEvaluationFailed(day('2026-10-15'), String(story._id), 'outage');
  expect((await Story.findById(story._id).lean())?.evaluation?.failedRuns).toBe(1);
  await markEvaluationFailed(day('2026-10-16'), String(story._id), 'outage');
  expect((await Story.findById(story._id).lean())?.evaluation?.failedRuns).toBe(2);
});

describe('the whole bounded flow, over several runs', () => {
  it('accounts for every article and story through interruptions, retries, duplicates and expiry', async () => {
    const q1 = [
      hit('a', 'Topic-A first', 0.9),
      hit('b', 'Topic-B first', 0.8),
      hit('shared', 'Topic-S shared', 0.7),
    ];
    const q2 = [
      hit('c', 'Topic-C second', 0.95),
      hit('shared', 'Topic-S shared', 0.6),
      hit('d', 'Off-topic listing', 0.5),
    ];
    const search = queryAwareSearch([q1, q2]);
    const { llm, calls, failNextWithOutage } = intakeLlm();
    const config = { maxQueries: 2, maxExtract: 2, clusterMaxItems: 2, maxEvaluations: 1 };
    const check = async (runKey: string) => {
      const books = await ledger();
      const funnel = (await getRun(runKey))?.funnel as RunFunnel | undefined;
      expect(funnel?.waitingToExtract).toBe(books.articles.waitingToExtract);
      expect(books.articles.readNotTriaged).toBe(0);
      return books;
    };

    // Day 1: one URL from two queries is stored once and keeps both queries.
    await run(day('2026-10-15'), deps(llm, search.client, config, '2026-10-15T05:00:00Z'));
    const { SourceArticle, Story } = await getModels();
    const shared = await SourceArticle.find({ canonicalUrl: /shared/ }).lean();
    expect(shared).toHaveLength(1);
    expect(shared[0]?.seenQueries).toHaveLength(2);
    // The two read first come from different queries.
    const firstRead = await SourceArticle.find({ intakeRunKey: day('2026-10-15') }).lean();
    expect(new Set(firstRead.map((a) => a.searchQuery)).size).toBe(2);
    let books = await check(day('2026-10-15'));
    expect(books.total).toBe(5);

    // Day 2: interrupted at triage, then resumed under the same run key.
    search.setLists([[]]);
    failNextWithOutage('triage');
    await expect(
      run(day('2026-10-16'), deps(llm, search.client, config, '2026-10-16T05:00:00Z')),
    ).rejects.toThrow(/outage/);
    expect((await getRun(day('2026-10-16')))?.status).toBe('failed');
    await run(day('2026-10-16'), deps(llm, search.client, config, '2026-10-16T06:00:00Z'));
    expect((await getRun(day('2026-10-16')))?.status).toBe('completed');
    books = await check(day('2026-10-16'));

    // Day 3: the shared URL is found again (not stored or read twice); a duplicate trigger for the
    // same day does nothing.
    search.setLists([[hit('shared', 'Topic-S shared', 0.7), hit('e', 'Topic-E third', 0.8)]]);
    // Room to read only one: the older backlog goes first, the new article waits.
    await run(
      day('2026-10-17'),
      deps(llm, search.client, { ...config, maxExtract: 1 }, '2026-10-17T05:00:00Z'),
    );
    expect((await SourceArticle.findOne({ canonicalUrl: /\/e$/ }).lean())?.extractionStatus).toBe(
      'pending',
    );
    const callsBefore = calls.length;
    expect(
      await run(day('2026-10-17'), deps(llm, search.client, config, '2026-10-17T07:00:00Z')),
    ).toBeNull();
    expect(calls.length).toBe(callsBefore);
    expect(await SourceArticle.countDocuments({ canonicalUrl: /shared/ })).toBe(1);
    books = await check(day('2026-10-17'));
    expect(books.total).toBe(6);

    // Nothing was read or assessed twice (an escalation re-asks the same assessment by design,
    // so only first-pass assessments are counted).
    expect(new Set(search.extractedUrls).size).toBe(search.extractedUrls.length);
    const assessed = await Story.find({ 'evaluation.status': 'evaluated' }).lean();
    const leads = calls
      .filter((c) => c.operation === 'evaluate' && c.tier === 'primary')
      .map((c) => /^A1 \| [^|]+\| [^|]+\| (.+)$/m.exec(c.prompt)?.[1]);
    expect(new Set(leads).size).toBe(leads.length);
    expect(assessed.length).toBe(leads.length);

    // Three weeks later, with no capacity left: whatever still waits expires, and is counted.
    search.setLists([[]]);
    const late = { ...config, maxExtract: 0, maxEvaluations: 1 };
    await run(day('2026-11-08'), deps(llm, search.client, late, '2026-11-08T05:00:00Z'));
    books = await check(day('2026-11-08'));
    const funnel = (await getRun(day('2026-11-08')))?.funnel as RunFunnel | undefined;
    expect(books.articles.waitingToExtract + books.articles.waitingToCluster).toBe(0);
    expect(books.stories.pending ?? 0).toBe(0);
    // Both kinds of expiry happened, so the reconciliation below is not trivially zero.
    expect(books.articles.expiredBeforeExtract).toBeGreaterThan(0);
    expect(books.stories.expired ?? 0).toBeGreaterThan(0);
    expect(
      (funnel?.expiredBeforeExtract ?? 0) +
        (funnel?.expiredBeforeCluster ?? 0) +
        (funnel?.expiredBeforeEvaluation ?? 0),
    ).toBe(
      books.articles.expiredBeforeExtract +
        books.articles.expiredBeforeCluster +
        (books.stories.expired ?? 0),
    );
  });
});
