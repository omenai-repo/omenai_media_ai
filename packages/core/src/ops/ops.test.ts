import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getModels } from '../db/models.js';
import type { UsageRowDto } from '../newsroom/dto.js';
import { startTestDatabase, type TestDatabase } from '../testing/index.js';
import { seedFixtureNewsroom } from '../testing/seed.js';
import { getOperationsOverview, RUNNING_LIMIT } from './overview.js';
import { estimateRowCost, groupUsage, splitUsage } from './pricing.js';

const row = (overrides: Partial<UsageRowDto>): UsageRowDto => ({
  provider: 'anthropic',
  operation: 'discovery.evaluate',
  model: 'claude-sonnet-5-5',
  calls: 1,
  errors: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
  units: 0,
  unreportedCalls: 0,
  simulated: false,
  ...overrides,
});

describe('cost estimates (list prices, never presented as billed cost)', () => {
  it('prices Anthropic tokens, Tavily credits and the Gemini free tier', () => {
    expect(
      estimateRowCost(
        row({ inputTokens: 1_000_000, outputTokens: 100_000, cachedInputTokens: 500_000 }),
      ).usd,
    ).toBeCloseTo(2 + 1 + 0.1);
    expect(estimateRowCost(row({ provider: 'tavily', model: null, units: 25 })).usd).toBeCloseTo(
      0.2,
    );
    // Never assumed free: the app can't see whether a Gemini key is on the free tier.
    const gemini = estimateRowCost(
      row({
        provider: 'gemini',
        model: 'gemini-3.8-flash',
        inputTokens: 1e6,
        outputTokens: 100_000,
        reasoningTokens: 100_000,
      }),
    );
    expect(gemini.basis).toBe('list_price');
    expect(gemini.usd).toBeCloseTo(0.75 + 0.75);
    expect(gemini.note).toMatch(/free tier/);
    expect(estimateRowCost(row({ model: 'claude-unknown' }))).toMatchObject({
      usd: null,
      basis: 'unknown',
    });
  });

  it('groups operations into plain categories and refuses to total unknown prices', () => {
    const groups = groupUsage([
      row({ provider: 'tavily', operation: 'discovery.search', model: null, units: 2 }),
      row({ provider: 'tavily', operation: 'discovery.extract', model: null, units: 2 }),
      row({ operation: 'discovery.triage', inputTokens: 1000 }),
      row({ operation: 'discovery.evaluate', model: 'mystery-model' }),
    ]);
    expect(groups.map((g) => [g.label, g.calls])).toEqual([
      ['Finding stories', 2],
      ['Assessing stories', 2],
    ]);
    expect(groups[0]?.estimateUsd).toBeCloseTo(0.032);
    expect(groups[1]?.estimateUsd).toBeNull();
    expect(groups.map((g) => g.freeTier)).toEqual([false, false]);
    const gemini = groupUsage([
      row({
        provider: 'gemini',
        model: 'gemini-3.5-flash-lite',
        operation: 'discovery.triage',
        inputTokens: 1_000_000,
      }),
    ]);
    expect(gemini[0]).toMatchObject({ freeTier: false });
    expect(gemini[0]?.estimateUsd).toBeCloseTo(0.3);
  });

  it('gives no estimate while a provider has not reported usage, instead of a reassuring zero', () => {
    const cost = estimateRowCost(
      row({ provider: 'tavily', operation: 'discovery.search', model: null, unreportedCalls: 2 }),
    );
    expect(cost).toMatchObject({ usd: null, basis: 'unreported' });
    expect(cost.note).toMatch(/2 requests didn't report credit use/);
  });

  it('keeps simulated (fixture) usage apart from provider-reported usage', () => {
    const { reported, simulated } = splitUsage([
      row({ provider: 'tavily', operation: 'discovery.search', model: null, units: 3 }),
      row({ operation: 'discovery.evaluate', inputTokens: 1_000_000, simulated: true }),
    ]);
    expect(reported.groups.map((g) => g.label)).toEqual(['Finding stories']);
    expect(reported.estimateUsd).toBeCloseTo(0.024);
    expect(simulated?.groups.map((g) => g.label)).toEqual(['Assessing stories']);
    expect(splitUsage([]).simulated).toBeNull();
    expect(splitUsage([]).reported).toMatchObject({
      groups: [],
      estimateUsd: 0,
      freeTierOnly: false,
    });
  });
});

describe('operations overview', () => {
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

  it('reports the latest run and surfaces failures plainly, without hiding them', async () => {
    const now = new Date('2026-10-19T12:00:00Z');
    const { WorkflowRun, Task, AiUsage } = await getModels();
    // The seed's runs are stamped with the wall clock, so this one is too (a minute later): it
    // must be the newest run whatever day the test runs, not only before 06:00 on 19 October.
    await WorkflowRun.create({
      runKey: 'manual:2026-10-19T06:00:00.000Z',
      trigger: 'manual',
      status: 'failed',
      runErrors: [
        {
          stage: 'discover',
          message: 'Tavily search failed: Unauthorized',
          at: new Date('2026-10-19T06:01:00Z'),
        },
      ],
      createdAt: new Date(Date.now() + 60_000),
    });
    // Created with explicit timestamps: "retrying" versus "stalled" depends on recent activity.
    const at = (iso: string) => ({ createdAt: new Date(iso), updatedAt: new Date(iso) });
    await Task.collection.insertMany([
      {
        key: 'discovery.evaluate:x:y',
        kind: 'discovery.evaluate',
        status: 'failed',
        attempts: 5,
        lastError: 'invalid_output',
        ...at('2026-10-19T11:00:00Z'),
      },
      {
        key: 'discovery.evaluate:x:z',
        kind: 'discovery.evaluate',
        status: 'queued',
        attempts: 2,
        lastError: 'unavailable: 503',
        ...at('2026-10-19T11:58:00Z'),
      },
    ]);
    await AiUsage.create({
      provider: 'tavily',
      kind: 'search',
      operation: 'discovery.search',
      units: 2,
      outcome: 'ok',
      createdAt: now,
    });

    const overview = await getOperationsOverview(now);
    expect(overview.latestRun?.runKey).toBe('manual:2026-10-19T06:00:00.000Z');
    expect(overview.attention.map((a) => a.kind)).toEqual(
      expect.arrayContaining(['run_failed', 'task_failed', 'task_retrying']),
    );
    expect(overview.attention.find((a) => a.kind === 'task_retrying')).toMatchObject({
      automatic: true,
      attempts: { made: 2, limit: 5 },
    });
    expect(overview.attention.find((a) => a.kind === 'task_failed')).toMatchObject({
      automatic: false,
      attempts: { made: 5, limit: 5 },
    });
    expect(overview.attention.find((a) => a.kind === 'run_failed')?.detail).toContain(
      'Unauthorized',
    );
    expect(overview.usage.reported.groups[0]).toMatchObject({
      label: 'Finding stories',
      credits: 2,
    });
    expect(overview.usage.simulated).toBeNull();
    expect(overview.usage.pricesVerifiedOn).toBe('2026-10-16');
  });

  it('keeps automatic retries apart from what needs someone, and hands over when retrying stops', async () => {
    const now = new Date('2026-10-19T12:00:00Z');
    const { Task, Story, WorkflowRun } = await getModels();
    const [first, second, third] = await Story.find({}, { _id: 1, headline: 1 })
      .sort({ _id: 1 })
      .limit(3)
      .lean();
    const at = (iso: string) => ({ createdAt: new Date(iso), updatedAt: new Date(iso) });
    await Task.collection.insertMany([
      // Retrying, with recent activity: automatic, nobody needs to act yet.
      {
        key: `research:standard:${String(first!._id)}:a`,
        kind: 'research',
        storyId: first!._id,
        status: 'running',
        attempts: 2,
        lastError: 'unavailable: 503',
        ...at('2026-10-19T11:50:00Z'),
      },
      // Running on paper, but silent: a chat reply (one attempt, in a web request) that can't
      // finish any more.
      {
        key: `chat:${String(second!._id)}:b`,
        kind: 'chat',
        storyId: second!._id,
        status: 'queued',
        attempts: 1,
        lastError: 'unavailable: 503',
        ...at('2026-10-19T10:00:00Z'),
      },
      // Gave up early: the error isn't one that retrying fixes.
      {
        key: `research:standard:${String(third!._id)}:c`,
        kind: 'research',
        storyId: third!._id,
        status: 'failed',
        attempts: 1,
        lastError: 'invalid_request: prompt too long',
        ...at('2026-10-19T09:00:00Z'),
      },
      // Failed, then an editor asked again and it worked: nothing left to do.
      {
        key: `research:standard:${String(second!._id)}:d`,
        kind: 'research',
        storyId: second!._id,
        status: 'failed',
        attempts: 3,
        lastError: 'unavailable: 503',
        ...at('2026-10-19T08:00:00Z'),
      },
      {
        key: `research:standard:${String(second!._id)}:e`,
        kind: 'research',
        storyId: second!._id,
        status: 'succeeded',
        attempts: 1,
        lastError: null,
        ...at('2026-10-19T08:30:00Z'),
      },
    ]);
    // A draft that gave up stays listed until the same format is asked for again.
    await Task.collection.insertMany([
      {
        key: `generate:linkedin_post:${String(third!._id)}:f`,
        kind: 'generate',
        format: 'linkedin_post',
        storyId: third!._id,
        status: 'failed',
        attempts: 3,
        lastError: 'unavailable: 503',
        ...at('2026-10-19T09:10:00Z'),
      },
      {
        key: `generate:x_post:${String(third!._id)}:g`,
        kind: 'generate',
        format: 'x_post',
        storyId: third!._id,
        status: 'succeeded',
        attempts: 1,
        lastError: null,
        ...at('2026-10-19T09:20:00Z'),
      },
    ]);
    // A run whose lease lapsed with no attempts left: nothing will resume it.
    await WorkflowRun.create({
      runKey: 'manual:2026-10-19T07:00:00.000Z',
      trigger: 'manual',
      status: 'running',
      stage: 'evaluate',
      attempts: 3,
      leaseExpiresAt: new Date('2026-10-19T11:30:00Z'),
      createdAt: new Date('2026-10-19T07:00:00Z'),
    });

    const { attention } = await getOperationsOverview(now);
    const pick = (kind: string) => attention.filter((a) => a.kind === kind);
    expect(pick('task_retrying')).toEqual([
      expect.objectContaining({
        automatic: true,
        attempts: { made: 2, limit: 3 },
        task: {
          kind: 'research',
          status: 'running',
          storyId: String(first!._id),
          headline: first!.headline,
        },
      }),
    ]);
    expect(pick('task_stalled')).toEqual([
      expect.objectContaining({ automatic: false, attempts: { made: 1, limit: 1 } }),
    ]);
    // Newest first: the LinkedIn post wasn't superseded by the X post that followed it.
    expect(pick('task_failed').map((a) => [a.task?.kind, a.attempts])).toEqual([
      ['generate', { made: 3, limit: 3 }],
      ['research', { made: 1, limit: 3 }],
    ]);
    expect(pick('task_failed')[0]?.task?.storyId).toBe(String(third!._id));
    expect(pick('run_stuck')).toEqual([
      expect.objectContaining({ automatic: false, attempts: { made: 3, limit: 3 } }),
    ]);

    // With attempts left and a recent lapse, the orchestrator's retry is still due.
    await WorkflowRun.updateOne(
      { runKey: 'manual:2026-10-19T07:00:00.000Z' },
      { $set: { attempts: 1 } },
    );
    expect(
      (await getOperationsOverview(now)).attention.find((a) => a.kind === 'run_stuck')?.automatic,
    ).toBe(true);
  });

  it('lists only work going normally as running: never retrying, stale, stopped or finished work', async () => {
    const now = new Date('2026-10-19T12:00:00Z');
    const { Task, Story } = await getModels();
    // Two stories: normal work on the second, so it can't supersede the first's failure (a later
    // request of the same kind on the same story does that, by design).
    const [story, other] = await Story.find({}, { _id: 1, headline: 1 })
      .sort({ _id: 1 })
      .limit(2)
      .lean();
    const at = (iso: string) => ({ createdAt: new Date(iso), updatedAt: new Date(iso) });
    const task = (key: string, fields: Record<string, unknown>) => ({
      key,
      storyId: story!._id,
      attempts: 1,
      lastError: null,
      ...fields,
    });

    // Work that is someone's concern, or done: none of it may be shown as running.
    await Task.collection.insertMany([
      // Retrying after a failed attempt (listed under attention instead).
      task('research:retrying', {
        kind: 'research',
        status: 'running',
        attempts: 2,
        lastError: 'unavailable: 503',
        ...at('2026-10-19T11:58:00Z'),
      }),
      // Running on paper but quiet past its window: stalled, not running.
      task('generate:stale', {
        kind: 'generate',
        format: 'x_post',
        status: 'running',
        ...at('2026-10-19T11:00:00Z'),
      }),
      // A chat reply quiet for 3 minutes: stale for a chat (2), though fresh for anything else.
      task('chat:quiet', { kind: 'chat', status: 'running', ...at('2026-10-19T11:57:00Z') }),
      task('research:failed', {
        kind: 'research',
        status: 'failed',
        lastError: 'invalid_request: prompt too long',
        ...at('2026-10-19T11:59:00Z'),
      }),
    ]);
    const before = await getOperationsOverview(now);
    expect(before.running).toEqual([]);

    // Work going normally, plus a reply the editor is stopping and one that finished.
    await Task.collection.insertMany([
      task('research:fresh', {
        storyId: other!._id,
        kind: 'research',
        status: 'running',
        requestKind: 'lead',
        startedAt: new Date('2026-10-19T11:58:30Z'),
        progress: {
          step: 'read',
          steps: [
            {
              step: 'sources',
              startedAt: new Date('2026-10-19T11:58:31Z'),
              counts: { sources: 2 },
            },
            { step: 'search', startedAt: new Date('2026-10-19T11:58:40Z'), counts: { found: 3 } },
            { step: 'read', startedAt: new Date('2026-10-19T11:59:10Z'), counts: null },
          ],
        },
        ...at('2026-10-19T11:59:20Z'),
      }),
      task('generate:waiting', {
        storyId: other!._id,
        kind: 'generate',
        format: 'newsletter_item',
        status: 'queued',
        startedAt: null,
        ...at('2026-10-19T11:59:00Z'),
      }),
      task('chat:stopping', {
        storyId: other!._id,
        kind: 'chat',
        status: 'running',
        cancelRequested: true,
        ...at('2026-10-19T11:59:50Z'),
      }),
      task('generate:done', {
        storyId: other!._id,
        kind: 'generate',
        format: 'linkedin_post',
        status: 'succeeded',
        ...at('2026-10-19T11:59:55Z'),
      }),
    ]);
    const after = await getOperationsOverview(now);
    // Adding normal work changes nothing about what needs attention.
    expect(after.attention).toEqual(before.attention);
    expect(after.running.map((r) => [r.kind, r.status])).toEqual([
      ['research', 'running'],
      ['generate', 'queued'],
    ]);
    const [research, draft] = after.running;
    expect(research).toMatchObject({
      storyId: String(other!._id),
      headline: other!.headline,
      focused: true,
      startedAt: '2026-10-19T11:58:30.000Z',
    });
    // Exactly the steps recorded, nothing more.
    expect(research!.progress).toEqual({
      step: 'read',
      steps: [
        { step: 'sources', counts: { sources: 2 } },
        { step: 'search', counts: { found: 3 } },
        { step: 'read', counts: null },
      ],
    });
    expect(draft).toMatchObject({ format: 'newsletter_item', focused: false, progress: null });

    // Bounded however much is under way.
    await Task.collection.insertMany(
      Array.from({ length: RUNNING_LIMIT + 5 }, (_, i) =>
        task(`discovery.evaluate:many:${i}`, {
          kind: 'discovery.evaluate',
          status: 'running',
          ...at('2026-10-19T11:59:30Z'),
        }),
      ),
    );
    expect((await getOperationsOverview(now)).running).toHaveLength(RUNNING_LIMIT);
  });

  it('flags work that went quiet without an error, and stops listing a failed run once a later one completes', async () => {
    const now = new Date('2026-10-19T12:00:00Z');
    const { Task, WorkflowRun } = await getModels();
    await Task.collection.insertOne({
      key: 'generate:x_post:6ad1f0000000000000000001:6ad1f0000000000000000002',
      kind: 'generate',
      format: 'x_post',
      status: 'running',
      attempts: 1,
      lastError: null,
      createdAt: new Date('2026-10-19T11:00:00Z'),
      updatedAt: new Date('2026-10-19T11:00:00Z'),
    });
    await WorkflowRun.collection.insertMany([
      {
        runKey: 'manual:2026-10-19T09:00:00.000Z',
        trigger: 'manual',
        status: 'failed',
        runErrors: [
          { stage: 'run', message: 'Gemini API error 503', at: new Date('2026-10-19T09:05:00Z') },
        ],
        createdAt: new Date('2026-10-19T09:00:00Z'),
        updatedAt: new Date('2026-10-19T09:05:00Z'),
      },
      {
        runKey: 'manual:2026-10-19T10:00:00.000Z',
        trigger: 'manual',
        status: 'completed',
        createdAt: new Date('2026-10-19T10:00:00Z'),
        updatedAt: new Date('2026-10-19T10:05:00Z'),
      },
    ]);
    const { attention } = await getOperationsOverview(now);
    const stalled = attention.find((a) => a.kind === 'task_stalled');
    expect(stalled?.automatic).toBe(false);
    expect(stalled?.detail).toMatch(/no error recorded/);
    expect(attention.filter((a) => a.runKey === 'manual:2026-10-19T09:00:00.000Z')).toEqual([]);
  });
});
