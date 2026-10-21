/**
 * Search-credit budgeting for discovery (ADR-042). The rates follow Tavily's published table
 * (checked 2026-10-20). Fixtures only: no search is made.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getModels } from '../db/models.js';
import type { SearchClient } from '../search/types.js';
import { createScriptedLlm } from '../testing/fake-llm.js';
import { startTestDatabase, type TestDatabase } from '../testing/index.js';
import { RESEARCH_CREDIT_RESERVE, searchBudgetFit, worstCaseRunCredits } from './budget.js';
import { readDiscoveryConfig } from './config.js';
import { getRun } from './runs.js';
import { runDiscoveryInline } from './pipeline/run-inline.js';

describe('worst-case credits per run', () => {
  it('counts every search, a full extract and the revisits, at Tavily’s basic rates', () => {
    // The code defaults: 10 searches + 60 pages (12) + 10 revisits (2).
    expect(worstCaseRunCredits(readDiscoveryConfig({}))).toBe(24);
    // Live development: 3 searches + 12 pages (3) + no revisits.
    expect(worstCaseRunCredits({ maxQueries: 3, maxExtract: 12, maxRevisits: 0 })).toBe(6);
    // Pages round up to whole credits.
    expect(worstCaseRunCredits({ maxQueries: 1, maxExtract: 6, maxRevisits: 1 })).toBe(4);
  });

  it('says whether a run plus the research reserve fits the daily limit', () => {
    const defaults = readDiscoveryConfig({});
    expect(searchBudgetFit(defaults, 20)).toMatchObject({ worstCase: 24, fits: false });
    expect(searchBudgetFit({ maxQueries: 3, maxExtract: 12, maxRevisits: 0 }, 20)).toMatchObject({
      worstCase: 6,
      fits: true,
    });
    expect(searchBudgetFit(defaults, 24 + RESEARCH_CREDIT_RESERVE).fits).toBe(true);
    expect(searchBudgetFit(defaults, null)).toMatchObject({ fits: null });
    expect(searchBudgetFit(defaults, 20).note).toMatch(/passes the limit of 20/);
  });
});

describe('before the first search', () => {
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
  afterEach(() => {
    delete process.env.SEARCH_DAILY_CREDIT_LIMIT;
  });

  const runWith = (search: SearchClient, now: Date) =>
    runDiscoveryInline({
      runKey: 'daily-discovery:2026-10-20',
      trigger: 'manual',
      owner: 'w',
      deps: {
        llm: createScriptedLlm({}).llm,
        search,
        config: { ...readDiscoveryConfig({}), maxQueries: 3, maxExtract: 12, maxRevisits: 0 },
        now: () => now,
      },
    });

  it('refuses a run that cannot fit in what is left of the limit, having spent nothing', async () => {
    process.env.SEARCH_DAILY_CREDIT_LIMIT = '20';
    const now = new Date('2026-10-20T05:00:00Z');
    const { AiUsage } = await getModels();
    // 16 credits already used today (two research briefs and a run, say): 6 more would pass 20.
    await AiUsage.create({
      provider: 'tavily',
      kind: 'search',
      operation: 'research',
      units: 16,
      outcome: 'ok',
    });
    let searches = 0;
    const search: SearchClient = {
      search: () => {
        searches += 1;
        return Promise.resolve([]);
      },
      extract: () => Promise.resolve({ pages: [], failed: [] }),
    };
    await expect(runWith(search, now)).rejects.toThrow(/search credits/);
    expect(searches).toBe(0);
    expect((await getRun('daily-discovery:2026-10-20'))?.status).toBe('failed');
  });

  it('lets a run that fits go ahead', async () => {
    process.env.SEARCH_DAILY_CREDIT_LIMIT = '20';
    let searches = 0;
    const search: SearchClient = {
      search: () => {
        searches += 1;
        return Promise.resolve([]);
      },
      extract: () => Promise.resolve({ pages: [], failed: [] }),
    };
    await runWith(search, new Date('2026-10-20T05:00:00Z'));
    expect(searches).toBe(3);
  });
});
