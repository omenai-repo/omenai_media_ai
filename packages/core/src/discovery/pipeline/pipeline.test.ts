/**
 * End-to-end discovery pipeline against fixtures: fake search, scripted LLM (behind the real
 * LlmClient), in-memory MongoDB. Proves the pipeline's logic, idempotency and accounting. It does
 * NOT prove real model or Tavily behaviour (see docs/VERIFICATION.md).
 */
import { weightedTotal, type DimensionScores } from '@repo/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getModels } from '../../db/models.js';
import {
  createFakeSearch,
  DAY1,
  DAY2,
  fixtureEvaluation,
  scores,
} from '../../testing/discovery-fixtures.js';
import { createScriptedLlm, promptArticles, promptStories } from '../../testing/fake-llm.js';
import { startTestDatabase, type TestDatabase } from '../../testing/index.js';
import { readDiscoveryConfig } from '../config.js';
import { getRun } from '../runs.js';
import { runDiscoveryInline } from './run-inline.js';

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

const DAY1_RUN = 'daily-discovery:2026-10-15';
const DAY2_RUN = 'daily-discovery:2026-10-18';
const config = { ...readDiscoveryConfig({}), maxQueries: 2 };

function evaluationFor(prompt: string, tier: string) {
  const lead = promptArticles(prompt)[0]?.headline ?? '';
  const headline = lead;
  if (/Gele/.test(lead))
    return fixtureEvaluation(
      scores(4, { human_interest_access: 3, audience_relevance: 3, commercial_adjacency: 2 }),
      {
        headline,
        geography: [
          { country: 'Nigeria', city: 'Lagos', region: 'west_africa', confidence: 'high' },
        ],
      },
    );
  if (/10 art exhibitions/.test(lead))
    return fixtureEvaluation(scores(3), {
      headline,
      exclusions: [
        { id: 'thin_listicle_seo', evidence: 'Ten openings, one line each.', exception: null },
      ],
    });
  if (/whisky/.test(lead))
    // Scores 100, yet gates must still reject it.
    return fixtureEvaluation(scores(5), {
      headline,
      exclusions: [
        {
          id: 'generic_luxury_promotion',
          evidence: 'Sponsored brand event copy.',
          exception: null,
        },
        { id: 'press_release_repackaged', evidence: 'Mirrors the brand release.', exception: null },
      ],
    });
  if (/punk/.test(lead))
    return tier === 'escalation'
      ? fixtureEvaluation(scores(3, { commercial_adjacency: 1 }), { headline })
      : fixtureEvaluation(scores(3, { originality: 4, commercial_adjacency: 1 }), { headline });
  if (/Zeitz MOCAA opens/.test(lead))
    return fixtureEvaluation(
      scores(4, { cultural_significance: 5, visual_potential: 5, commercial_adjacency: 3 }),
      {
        headline,
        entities: ['Zeitz MOCAA', 'Kwame Asante'],
      },
    );
  if (/Unseen archive/.test(lead))
    return fixtureEvaluation(scores(4, { cultural_significance: 5 }), {
      headline,
      criticalIssues: [
        {
          kind: 'rights',
          severity: 'hold',
          evidence: 'Photographs of unknown provenance and rights.',
        },
      ],
    });
  if (/auction record/.test(lead))
    return fixtureEvaluation(scores(4, { cultural_significance: 5, timeliness: 5 }), {
      headline,
      noveltyStatus: 'developing',
      timeliness: 'urgent',
    });
  throw new Error(`No fixture evaluation for "${lead}"`);
}

function createLlm() {
  return createScriptedLlm({
    triage: (prompt) => ({
      articles: promptArticles(prompt).map((a) => ({
        ref: a.ref,
        inScope: !/For Sale/.test(a.headline),
        reason: /For Sale/.test(a.headline)
          ? 'A sales listing, not a story.'
          : 'Cultural development.',
        eventSummary: a.headline,
        eventDate: null,
        entities: [],
        places: [],
        exclusionSignals: [],
      })),
    }),
    cluster: (prompt) => {
      const stories = promptStories(prompt);
      const asante = stories.find((s) => /Kwame Asante/.test(s.headline))?.ref ?? null;
      return {
        // The model leaves syndicated copies apart; deterministic pre-grouping must merge them.
        groups: promptArticles(prompt).map((a) => {
          if (/draws crowds/.test(a.headline))
            return {
              items: [a.ref],
              relation: 'same_development_no_new_info',
              relatedStory: asante,
              signature: 'Asante retrospective',
            };
          if (/auction record/.test(a.headline))
            return {
              items: [a.ref],
              relation: 'new_development',
              relatedStory: asante,
              signature: 'Asante auction record',
            };
          return { items: [a.ref], relation: 'new', relatedStory: null, signature: a.headline };
        }),
      };
    },
    evaluate: evaluationFor,
    change: () => ({
      changeKind: 'updated_reporting',
      summary: 'Should not be needed in these fixtures.',
    }),
  });
}

const day1Hits = Object.values(DAY1);

async function storyByHeadline(pattern: RegExp) {
  const { Story } = await getModels();
  const stories = await Story.find().lean();
  const story = stories.find((s) => pattern.test(s.headline));
  if (!story) throw new Error(`No story matching ${pattern}`);
  return story;
}

describe('daily discovery pipeline (fixtures)', () => {
  it('produces a ranked shortlist that never pads, with an outcome for every candidate', async () => {
    const search = createFakeSearch(day1Hits);
    const { llm, calls } = createLlm();
    const result = await runDiscoveryInline({
      runKey: DAY1_RUN,
      trigger: 'schedule',
      owner: 'worker-1',
      deps: { llm, search: search.client, config, now: () => new Date('2026-10-15T05:00:00Z') },
    });

    // Two qualify; the list is NOT padded to the target of five.
    expect(result?.shortlist.map((s) => s.score)).toEqual([86, 74]);
    const zeitz = await storyByHeadline(/Zeitz MOCAA opens/);
    const gele = await storyByHeadline(/Gele/);
    expect(result?.shortlist.map((s) => s.storyId)).toEqual([String(zeitz._id), String(gele._id)]);

    // The total is computed in code from the dimension scores.
    const dims = Object.fromEntries(
      (zeitz.score?.dimensions ?? []).map((d) => [d.dimension, d.score]),
    ) as DimensionScores;
    expect(zeitz.score?.total).toBe(weightedTotal(dims));
    expect(zeitz.recommendedAction).toBe('pitch');
    expect(zeitz.tier).toBe(1);

    // Gates override scores: the brand promotion scored 100 and was still rejected.
    const whisky = await storyByHeadline(/whisky/);
    expect(whisky.score?.total).toBe(100);
    expect(whisky.evaluation?.outcome).toBe('gate_reject');
    expect((await storyByHeadline(/10 art exhibitions/)).evaluation?.outcome).toBe('gate_reject');
    expect((await storyByHeadline(/Unseen archive/)).evaluation?.outcome).toBe('gate_hold');

    // Borderline score → one escalation, whose result is used.
    const punk = await storyByHeadline(/punk/);
    expect(punk.evaluation?.escalated).toBe(true);
    expect(punk.score?.total).toBe(58);
    expect(punk.evaluation?.outcome).toBe('below_threshold');

    // Syndicated copy merged into one story; tracking-link duplicate stored once.
    expect(gele.sourceArticleIds).toHaveLength(2);
    const { SourceArticle, Story } = await getModels();
    expect(
      await SourceArticle.countDocuments({
        canonicalUrl: 'https://lagos-business.example/arts/alexis-galleries-gele',
      }),
    ).toBe(1);

    // The sales listing was triaged out and never became a story.
    expect(await Story.countDocuments()).toBe(6);
    expect(
      (await SourceArticle.findOne({ originalHeadline: /For Sale/ }).lean())?.triage?.inScope,
    ).toBe(false);

    // Accounting: every candidate has exactly one outcome, and the shortfall is explained.
    const run = await getRun(DAY1_RUN);
    expect(run?.status).toBe('completed');
    expect(run?.outcomes).toHaveLength(6);
    expect(run?.funnel).toMatchObject({
      qualified: 2,
      shortlisted: 2,
      gateRejects: 2,
      gateHolds: 1,
      belowThreshold: 1,
    });
    expect(run?.shortfallReasons.map((r) => r.code)).toEqual([
      'editorial_gates',
      'below_threshold',
    ]);
    expect(run?.shortfallReasons[0]?.breakdown).toMatchObject({
      'exclusion:thin_listicle_seo': 1,
      'exclusion:generic_luxury_promotion': 1,
    });

    // Cost shape: 1 triage batch, 1 clustering call, 6 evaluations + 1 escalation.
    expect(calls.filter((c) => c.operation === 'triage')).toHaveLength(1);
    expect(calls.filter((c) => c.operation === 'cluster')).toHaveLength(1);
    expect(calls.filter((c) => c.operation === 'evaluate')).toHaveLength(7);
    expect(search.calls.search).toBe(2);
  });

  it('never runs the same day twice', async () => {
    const search = createFakeSearch(day1Hits);
    const { llm, calls } = createLlm();
    const deps = {
      llm,
      search: search.client,
      config,
      now: () => new Date('2026-10-15T05:00:00Z'),
    };
    await runDiscoveryInline({ runKey: DAY1_RUN, trigger: 'schedule', owner: 'worker-1', deps });
    const before = { llm: calls.length, search: search.calls.search };

    const again = await runDiscoveryInline({
      runKey: DAY1_RUN,
      trigger: 'manual',
      owner: 'worker-2',
      deps,
    });
    expect(again).toBeNull();
    expect(calls.length).toBe(before.llm);
    expect(search.calls.search).toBe(before.search);
  });

  it('resumes after a transient outage without repeating completed stages', async () => {
    const search = createFakeSearch(day1Hits);
    const { llm, failNextWithOutage } = createLlm();
    const deps = {
      llm,
      search: search.client,
      config,
      now: () => new Date('2026-10-15T05:00:00Z'),
    };

    failNextWithOutage('triage');
    await expect(
      runDiscoveryInline({ runKey: DAY1_RUN, trigger: 'schedule', owner: 'worker-1', deps }),
    ).rejects.toThrow(/outage/);
    expect((await getRun(DAY1_RUN))?.status).toBe('failed');
    const searchesBefore = search.calls.search;

    const resumed = await runDiscoveryInline({
      runKey: DAY1_RUN,
      trigger: 'schedule',
      owner: 'worker-2',
      deps,
    });
    expect(resumed?.shortlist).toHaveLength(2);
    // Discovery had completed before the outage, so it was not searched (or paid for) again.
    expect(search.calls.search).toBe(searchesBefore);
  });

  it('suppresses a skipped development, admits a genuinely new one, and revisits without AI calls', async () => {
    const search = createFakeSearch(day1Hits);
    const { llm, calls } = createLlm();
    await runDiscoveryInline({
      runKey: DAY1_RUN,
      trigger: 'schedule',
      owner: 'w',
      deps: { llm, search: search.client, config, now: () => new Date('2026-10-15T05:00:00Z') },
    });

    // An editor skips the retrospective announcement.
    const { Story } = await getModels();
    const zeitz = await storyByHeadline(/Zeitz MOCAA opens/);
    await Story.updateOne({ _id: zeitz._id }, { $set: { editorialState: 'skipped' } });

    // Day 2: a repeat with nothing new, the later auction result, and the Gele article again
    // (now with a trivial edit) plus unchanged articles behind recommended stories.
    search.setHits([DAY2.zeitzCrowds, DAY2.auction, DAY1.gele]);
    search.setPage(DAY1.gele.url, `${DAY1.gele.content} Related: more exhibitions this week.`);
    const callsBefore = calls.length;

    const day2 = await runDiscoveryInline({
      runKey: DAY2_RUN,
      trigger: 'schedule',
      owner: 'w',
      deps: { llm, search: search.client, config, now: () => new Date('2026-10-18T05:00:00Z') },
    });

    const auction = await storyByHeadline(/auction record/);
    expect(day2?.shortlist.map((s) => s.storyId)).toEqual([String(auction._id)]);
    expect(auction.relation).toBe('new_development');
    expect(String(auction.parentStoryId)).toBe(String(zeitz._id));
    expect(auction.recommendedAction).toBe('urgent_review');

    const run = await getRun(DAY2_RUN);
    expect(run?.outcomes.find((o) => String(o.storyId) === String(zeitz._id))?.outcome).toBe(
      'suppressed_repeat',
    );
    // Earlier recommendations are not recommended again as if new.
    const gele = await storyByHeadline(/Gele/);
    expect(gele.recommendations).toHaveLength(1);

    // Revisits: a trivial edit and unchanged pages cost no model calls.
    const revisit = (run?.stageStats as { revisit: Record<string, number> }).revisit;
    expect(revisit).toMatchObject({ aiCalls: 0, cosmetic: 1 });
    expect(revisit.unchanged).toBeGreaterThan(0);
    expect(calls.slice(callsBefore).some((c) => c.operation === 'change')).toBe(false);
  });
});

describe('late evaluations', () => {
  it('carries a story evaluated after the set closed into the next run without re-evaluating it', async () => {
    const search = createFakeSearch(day1Hits);
    const { llm, calls } = createLlm();
    await runDiscoveryInline({
      runKey: DAY1_RUN,
      trigger: 'schedule',
      owner: 'w',
      deps: { llm, search: search.client, config, now: () => new Date('2026-10-15T05:00:00Z') },
    });
    // Simulate the Gele evaluation having finished after day 1's candidate set closed.
    const { Story } = await getModels();
    const gele = await storyByHeadline(/Gele/);
    await Story.updateOne(
      { _id: gele._id },
      {
        $set: {
          'evaluation.outcome': 'deferred_late',
          recommendations: [],
          lastRecommendedAt: null,
        },
      },
    );

    search.setHits([]);
    const evaluationsBefore = calls.filter((c) => c.operation === 'evaluate').length;
    const day2 = await runDiscoveryInline({
      runKey: DAY2_RUN,
      trigger: 'schedule',
      owner: 'w',
      deps: { llm, search: search.client, config, now: () => new Date('2026-10-16T05:00:00Z') },
    });

    expect(day2?.shortlist.map((s) => s.storyId)).toEqual([String(gele._id)]);
    expect(calls.filter((c) => c.operation === 'evaluate').length).toBe(evaluationsBefore);
    const after = await storyByHeadline(/Gele/);
    expect(after.evaluation).toMatchObject({ outcome: 'qualified', runKey: DAY2_RUN });
  });

  it('rejects a carried-over story that has gone stale', async () => {
    const search = createFakeSearch(day1Hits);
    const { llm } = createLlm();
    await runDiscoveryInline({
      runKey: DAY1_RUN,
      trigger: 'schedule',
      owner: 'w',
      deps: { llm, search: search.client, config, now: () => new Date('2026-10-15T05:00:00Z') },
    });
    const { Story } = await getModels();
    const gele = await storyByHeadline(/Gele/);
    await Story.updateOne({ _id: gele._id }, { $set: { 'evaluation.outcome': 'deferred_late' } });

    search.setHits([]);
    // 13 days later: still inside the carry-over window, but the article (Oct 12) is 15 days old.
    await runDiscoveryInline({
      runKey: 'daily-discovery:2026-10-28',
      trigger: 'schedule',
      owner: 'w',
      deps: { llm, search: search.client, config, now: () => new Date('2026-10-27T05:00:00Z') },
    });
    const after = await storyByHeadline(/Gele/);
    expect(after.evaluation?.outcome).toBe('gate_reject');
  });
});
