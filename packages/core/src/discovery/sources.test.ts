/**
 * Weighted tier rotation and the registry (ADR-042). Rotation spreads searches across tiers and
 * pillars over time; it never guarantees what is found and plays no part in ranking. Pure
 * functions, plus one fixture run to show a resumed run keeps its own day's queries.
 */
import { PILLAR_IDS, type GeographyTier } from '@repo/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { SearchClient } from '../search/types.js';
import { createScriptedLlm } from '../testing/fake-llm.js';
import { startTestDatabase, type TestDatabase } from '../testing/index.js';
import { readDiscoveryConfig } from './config.js';
import { runDiscoveryInline } from './pipeline/run-inline.js';
import {
  DISCOVERY_QUERIES,
  DRAFT_DISCOVERY_QUERIES,
  selectQueries,
  TIER_CYCLE,
} from './sources.js';

const SHARE: Record<GeographyTier, number> = { 1: 4, 2: 3, 3: 1, 4: 1, 5: 1 };
const TIERS = [1, 2, 3, 4, 5] as const;

function dateAfter(start: string, days: number): string {
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const tierCounts = (start: string, days: number, count: number) => {
  const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (let d = 0; d < days; d += 1)
    for (const q of selectQueries(dateAfter(start, d), count)) counts[q.tier]! += 1;
  return counts;
};

describe('weighted tier rotation', () => {
  it('uses a fixed, spread-out cycle with the 40/30/10/10/10 shares', () => {
    expect(TIER_CYCLE).toEqual([1, 2, 3, 1, 2, 4, 1, 5, 2, 1]);
  });

  it.each(Array.from({ length: 10 }, (_, i) => i + 1))(
    'gives every tier exactly its share over any 10 days, at %i queries a day',
    (count) => {
      for (const start of ['2026-10-01', '2026-10-17', '2027-02-24'])
        expect(tierCounts(start, 10, count)).toEqual(
          Object.fromEntries(TIERS.map((t) => [t, Math.min(SHARE[t] * count, 10 * count)])),
        );
    },
  );

  it('at 3 a day, no tier waits more than 4 days for a turn', () => {
    for (const tier of TIERS) {
      const days = Array.from({ length: 40 }, (_, d) => d).filter((d) =>
        selectQueries(dateAfter('2026-10-01', d), 3).some((q) => q.tier === tier),
      );
      const gaps = days.slice(1).map((d, i) => d - days[i]!);
      expect(Math.max(...gaps), `tier ${tier}`).toBeLessThanOrEqual(4);
    }
  });

  it('at 10 a day, each day is 4/3/1/1/1', () => {
    for (let d = 0; d < 15; d += 1)
      expect(tierCounts(dateAfter('2026-10-01', d), 1, 10)).toEqual({
        1: 4,
        2: 3,
        3: 1,
        4: 1,
        5: 1,
      });
  });

  it('works through every query in each tier over time, and never repeats one within a day', () => {
    for (const count of [3, 10]) {
      const seen = new Set<string>();
      for (let d = 0; d < 60; d += 1) {
        const day = selectQueries(dateAfter('2026-10-01', d), count).map((q) => q.query);
        expect(new Set(day).size).toBe(day.length);
        day.forEach((q) => seen.add(q));
      }
      expect(seen.size, `count ${count}`).toBe(DISCOVERY_QUERIES.length);
    }
  });

  it('reaches every pillar a tier has within one pass of its pool, from any starting day', () => {
    for (const tier of TIERS) {
      const queries = DISCOVERY_QUERIES.filter((q) => q.tier === tier);
      const pillars = new Set(queries.map((q) => q.pillar));
      for (const start of ['2026-10-01', '2026-10-04', '2026-12-31']) {
        const turns: string[] = [];
        for (let d = 0; turns.length < queries.length; d += 1)
          for (const q of selectQueries(dateAfter(start, d), 10))
            if (q.tier === tier && turns.length < queries.length) turns.push(q.pillar);
        expect(new Set(turns).size, `tier ${tier} from ${start}`).toBe(pillars.size);
      }
    }
  });
});

describe('determinism', () => {
  const DATES = ['2026-10-20', '2026-11-01', '2027-03-14'];

  it('gives the same queries for the same date and count, however often and in whatever order', () => {
    for (const count of [1, 3, 10]) {
      const first = DATES.map((d) => selectQueries(d, count));
      // Other dates and counts computed in between change nothing.
      for (const other of ['2026-01-01', '2030-06-30']) selectQueries(other, 7);
      expect(
        DATES.toReversed()
          .map((d) => selectQueries(d, count))
          .toReversed(),
      ).toEqual(first);
      expect(DATES.map((d) => selectQueries(d, count))).toEqual(first);
    }
  });

  it('gives the same queries after a restart (a fresh module instance)', async () => {
    const before = DATES.map((d) => selectQueries(d, 3));
    vi.resetModules();
    const fresh = await import('./sources.js');
    expect(fresh.selectQueries).not.toBe(selectQueries);
    expect(DATES.map((d) => fresh.selectQueries(d, 3))).toEqual(before);
  });

  it('changes with the count only as the cycle defines', () => {
    // Day d takes slots d·count … d·count + count − 1 of the cycle.
    const day = Math.floor(Date.UTC(2026, 9, 20) / 86_400_000);
    for (const count of [1, 2, 3, 5, 7, 10])
      expect(selectQueries('2026-10-20', count).map((q) => q.tier)).toEqual(
        Array.from({ length: count }, (_, i) => TIER_CYCLE[(day * count + i) % 10]),
      );
  });
});

describe('the registry', () => {
  const all = [...DISCOVERY_QUERIES, ...DRAFT_DISCOVERY_QUERIES];

  it('has no duplicate queries, and every query names a pillar', () => {
    expect(new Set(all.map((q) => q.query.toLowerCase())).size).toBe(all.length);
    for (const q of all) expect(PILLAR_IDS).toContain(q.pillar);
  });

  it('with the draft additions, covers all six pillars in every tier', () => {
    for (const tier of TIERS)
      expect(
        new Set(all.filter((q) => q.tier === tier).map((q) => q.pillar)).size,
        `tier ${tier}`,
      ).toBe(6);
  });

  it('never searches a draft query until it is moved into the active registry', () => {
    const drafts = new Set(DRAFT_DISCOVERY_QUERIES.map((q) => q.query));
    for (let d = 0; d < 60; d += 1)
      for (const q of selectQueries(dateAfter('2026-10-01', d), 10))
        expect(drafts.has(q.query)).toBe(false);
  });
});

describe('a resumed run', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await startTestDatabase();
  });
  afterAll(async () => {
    await db?.stop();
  });

  it('searches its run key’s day, not the day it happens to run on', async () => {
    const searched: string[] = [];
    const search: SearchClient = {
      search: (query) => {
        searched.push(query);
        return Promise.resolve([]);
      },
      extract: () => Promise.resolve({ pages: [], failed: [] }),
    };
    const { llm } = createScriptedLlm({});
    await runDiscoveryInline({
      runKey: 'daily-discovery:2026-10-20',
      trigger: 'schedule',
      owner: 'w',
      deps: {
        llm,
        search,
        config: { ...readDiscoveryConfig({}), maxQueries: 3 },
        // Retried the next morning.
        now: () => new Date('2026-10-21T14:00:00Z'),
      },
    });
    expect(searched).toEqual(selectQueries('2026-10-20', 3).map((q) => q.query));
  });
});
