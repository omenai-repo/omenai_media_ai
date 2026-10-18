/**
 * TEST FIXTURE ONLY. Populates a database with two days of fixture discovery runs (via the real
 * pipeline code, with fake search and scripted model answers) for tests and local UI work.
 * The content is invented and lives on example.* domains.
 */
import { readDiscoveryConfig } from '../discovery/config.js';
import { runDiscoveryInline } from '../discovery/pipeline/run-inline.js';
import { getModels } from '../db/models.js';
import type { UsageRecorder } from '../llm/usage.js';
import { createFakeSearch, DAY1, DAY2 } from './discovery-fixtures.js';
import { createFixtureLlm } from './fixture-script.js';

export const FIXTURE_RUNS = {
  day1: 'daily-discovery:2026-10-15',
  day2: 'daily-discovery:2026-10-18',
} as const;

export async function seedFixtureNewsroom(
  options: { recordUsage?: UsageRecorder } = {},
): Promise<void> {
  const config = { ...readDiscoveryConfig({}), maxQueries: 2 };
  const search = createFakeSearch(Object.values(DAY1));
  const { llm } = createFixtureLlm(options);

  await runDiscoveryInline({
    runKey: FIXTURE_RUNS.day1,
    trigger: 'schedule',
    owner: 'fixture-seed',
    deps: { llm, search: search.client, config, now: () => new Date('2026-10-15T05:00:00Z') },
  });

  // An editor skipped the retrospective announcement; day 2 brings a repeat and a new development.
  const { Story } = await getModels();
  await Story.updateOne(
    { headline: /Zeitz MOCAA opens/ },
    {
      $set: { editorialState: 'skipped' },
      $push: {
        decisions: {
          action: 'skipped',
          userId: 'fixture-seed',
          reason: 'Covered elsewhere.',
          at: new Date('2026-10-16T09:00:00Z'),
        },
      },
    },
  );
  search.setHits([DAY2.zeitzCrowds, DAY2.auction, DAY1.gele]);
  search.setPage(DAY1.gele.url, `${DAY1.gele.content} Related: more exhibitions this week.`);
  await runDiscoveryInline({
    runKey: FIXTURE_RUNS.day2,
    trigger: 'schedule',
    owner: 'fixture-seed',
    deps: { llm, search: search.client, config, now: () => new Date('2026-10-18T05:00:00Z') },
  });
}
