import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getModels } from '../../db/models.js';
import { LlmError } from '../../llm/types.js';
import { createFakeSearch, DAY1 } from '../../testing/discovery-fixtures.js';
import { createFixtureLlm } from '../../testing/fixture-script.js';
import { startTestDatabase, type TestDatabase } from '../../testing/index.js';
import { readDiscoveryConfig } from '../config.js';
import { hasActiveRun } from '../runs.js';
import { runDiscoveryInline } from './run-inline.js';

/**
 * Controlled failure (simulated, not observed): a provider outage stops a run partway, the way
 * three 503s from Gemini stopped a live development run on 2026-10-16. The articles that run
 * already found, read and triaged must not be lost: the next run takes them on, once.
 */
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

const config = { ...readDiscoveryConfig({}), maxQueries: 2 };
const at = (iso: string) => () => new Date(iso);

describe('work left by a failed run', () => {
  it('is clustered and assessed by the next run, never twice, when a run fails at clustering', async () => {
    const search = createFakeSearch(Object.values(DAY1));
    const scripted = createFixtureLlm();
    scripted.failNextWithOutage('cluster');
    await expect(
      runDiscoveryInline({
        runKey: 'manual:2026-10-16T14:51:17.553Z',
        trigger: 'manual',
        owner: 'a',
        deps: { llm: scripted.llm, search: search.client, config, now: at('2026-10-16T14:51:00Z') },
      }),
    ).rejects.toBeInstanceOf(LlmError);
    const { WorkflowRun, SourceArticle, Story } = await getModels();
    expect(
      (await WorkflowRun.findOne({ runKey: 'manual:2026-10-16T14:51:17.553Z' }).lean())?.status,
    ).toBe('failed');
    const stranded = await SourceArticle.countDocuments({
      'triage.inScope': true,
      storyIds: { $size: 0 },
    });
    expect(stranded).toBeGreaterThan(0);
    expect(await Story.countDocuments()).toBe(0);

    // The next run finds nothing new (the same pages), but takes on what the failed run left.
    await runDiscoveryInline({
      runKey: 'manual:2026-10-16T15:30:00.000Z',
      trigger: 'manual',
      owner: 'b',
      deps: { llm: scripted.llm, search: search.client, config, now: at('2026-10-16T15:30:00Z') },
    });
    const next = (await WorkflowRun.findOne({ runKey: 'manual:2026-10-16T15:30:00.000Z' }).lean())!;
    expect(next.status).toBe('completed');
    expect(next.stageStats).toMatchObject({ cluster: { adopted: stranded } });
    expect(
      await SourceArticle.countDocuments({ 'triage.inScope': true, storyIds: { $size: 0 } }),
    ).toBe(0);
    expect(next.shortlist.length).toBeGreaterThan(0);
    // Every adopted article belongs to exactly one story.
    const memberships = (await Story.find({}, { sourceArticleIds: 1 }).lean()).flatMap((s) =>
      s.sourceArticleIds.map(String),
    );
    expect(new Set(memberships).size).toBe(memberships.length);

    // A third run has nothing left to adopt.
    await runDiscoveryInline({
      runKey: 'manual:2026-10-16T16:00:00.000Z',
      trigger: 'manual',
      owner: 'c',
      deps: { llm: scripted.llm, search: search.client, config, now: at('2026-10-16T16:00:00Z') },
    });
    expect(
      (await WorkflowRun.findOne({ runKey: 'manual:2026-10-16T16:00:00.000Z' }).lean())?.stageStats,
    ).toMatchObject({ cluster: { adopted: 0 } });
  });

  it('is triaged by the next run when a run fails partway through triage', async () => {
    const search = createFakeSearch(Object.values(DAY1));
    const scripted = createFixtureLlm();
    scripted.failNextWithOutage('triage');
    await expect(
      runDiscoveryInline({
        runKey: 'manual:2026-10-16T14:00:00.000Z',
        trigger: 'manual',
        owner: 'a',
        deps: {
          llm: scripted.llm,
          search: search.client,
          config: { ...config, triageBatchSize: 2 },
          now: at('2026-10-16T14:00:00Z'),
        },
      }),
    ).rejects.toBeInstanceOf(LlmError);
    const { WorkflowRun, SourceArticle } = await getModels();
    const untriaged = await SourceArticle.countDocuments({
      extractionStatus: 'extracted',
      triage: null,
    });
    expect(untriaged).toBeGreaterThan(0);

    await runDiscoveryInline({
      runKey: 'manual:2026-10-16T15:00:00.000Z',
      trigger: 'manual',
      owner: 'b',
      deps: { llm: scripted.llm, search: search.client, config, now: at('2026-10-16T15:00:00Z') },
    });
    expect(
      (await WorkflowRun.findOne({ runKey: 'manual:2026-10-16T15:00:00.000Z' }).lean())?.stageStats,
    ).toMatchObject({ triage: { adopted: untriaged } });
    expect(
      await SourceArticle.countDocuments({ extractionStatus: 'extracted', triage: null }),
    ).toBe(0);
  });

  it('counts a run waiting to retry as active, so a second search can’t start alongside it', async () => {
    const { WorkflowRun } = await getModels();
    const now = new Date('2026-10-16T15:00:00Z');
    await WorkflowRun.collection.insertOne({
      runKey: 'manual:2026-10-16T14:55:00.000Z',
      trigger: 'manual',
      status: 'queued',
      attempts: 1,
      runErrors: [{ stage: 'run', message: 'Gemini API error 503', at: now }],
      createdAt: now,
      updatedAt: new Date('2026-10-16T14:58:00Z'),
    });
    expect(await hasActiveRun(now)).toBe(true);
    // Quiet for over 45 minutes: nothing will resume it, so it no longer blocks.
    expect(await hasActiveRun(new Date('2026-10-16T15:50:00Z'))).toBe(false);
  });
});
