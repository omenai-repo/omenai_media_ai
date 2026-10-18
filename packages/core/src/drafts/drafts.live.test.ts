/**
 * Bounded live check of draft writing: one Weekly Briefing item and one X post, written by the
 * configured model (Gemini unless DRAFT_LIVE_PROVIDER approves another) from fixture research. Skipped unless DRAFT_LIVE_TESTS is set:
 *
 *   dry  The same steps with the scripted model; no network. Prints prompt sizes for estimates.
 *   1    Real Gemini calls (needs approval: expected 2, at most 6; the budget guard refuses more).
 *
 *   DRAFT_LIVE_TESTS=1 node --env-file=../../apps/worker/.env node_modules/vitest/vitest.mjs run src/drafts/drafts.live.test.ts
 *
 * Only the draft calls go to Gemini. The story and its research come from development fixtures
 * in an in-memory database (scripted research, fake search), so nothing reaches Tavily or Atlas,
 * and usage is captured here instead of being written anywhere. The content is invented.
 */
import { measureDraft } from '@repo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getModels } from '../db/models.js';
import { createLlmClient, type LlmClient } from '../llm/client.js';
import { readLlmConfig } from '../llm/config.js';
import type { LlmUsageRecord } from '../llm/usage.js';
import { requestResearch, runResearch } from '../research/service.js';
import { startTestDatabase, type TestDatabase } from '../testing/index.js';
import { createFixtureResearchLlm } from '../testing/scenarios/executor.js';
import { fixtureResearchSearch, researchResultsFor } from '../testing/scenarios/research-script.js';
import { seedFixtureNewsroom } from '../testing/seed.js';
import { getDraftsView } from './queries.js';
import { requestDraft, runDraftGeneration } from './service.js';

const mode = process.env.DRAFT_LIVE_TESTS;
/** Briefing: generation + one repair. X post: generation + repair, shortening + repair. */
const MAX_CALLS = 6;
const AVOID = ['breaking barriers', 'redefining the landscape', 'at the intersection of'];

/**
 * Refuses any call beyond the approved budget, and records usage and prompt sizes locally. Drafts
 * are streamed, so both ways of asking for an answer are counted.
 */
function budgeted(inner: LlmClient, log: { calls: number; promptChars: number[] }): LlmClient {
  const count = (request: Parameters<LlmClient['generateObject']>[0]) => {
    if (log.calls >= MAX_CALLS)
      throw new Error(`Live budget of ${MAX_CALLS} model calls reached; refusing another.`);
    log.calls += 1;
    log.promptChars.push(
      request.system.length + request.messages.reduce((n, m) => n + m.content.length, 0),
    );
  };
  return {
    ...inner,
    generateObject: (request) => {
      count(request);
      return inner.generateObject(request);
    },
    streamObject: (request) => {
      count(request);
      return inner.streamObject(request);
    },
  };
}

/**
 * The configured provider, but only the one approved for this run: Gemini unless
 * DRAFT_LIVE_PROVIDER names another, so switching LLM_PROVIDER alone never spends elsewhere.
 */
async function liveModel(records: LlmUsageRecord[]): Promise<LlmClient> {
  const config = readLlmConfig();
  const approved = process.env.DRAFT_LIVE_PROVIDER ?? 'gemini';
  if (config.provider !== approved)
    throw new Error(
      `LLM_PROVIDER is ${config.provider}, but this run is approved for ${approved} only.`,
    );
  const provider =
    config.provider === 'anthropic'
      ? (await import('../llm/providers/anthropic.js')).createAnthropicProvider({
          apiKey: config.apiKey,
          // No SDK-level retries: every call counts against the approved budget.
          maxRetries: 0,
        })
      : (await import('../llm/providers/gemini.js')).createGeminiProvider({
          apiKey: config.apiKey,
        });
  return createLlmClient({
    provider,
    models: config.models,
    recordUsage: (record) => {
      records.push(record);
      return Promise.resolve();
    },
  });
}

describe.skipIf(mode !== '1' && mode !== 'dry')('live draft check (bounded)', () => {
  let db: TestDatabase;
  let storyId: string;
  const records: LlmUsageRecord[] = [];
  const log = { calls: 0, promptChars: [] as number[] };
  let llm: LlmClient;

  beforeAll(async () => {
    db = await startTestDatabase();
    await seedFixtureNewsroom();
    const { Story } = await getModels();
    const story = (await Story.findOne({ headline: /Zeitz MOCAA opens/ }).lean())!;
    storyId = String(story._id);
    // Research from fixtures: scripted model and fake search, never Gemini or Tavily.
    const { taskKey } = await requestResearch({ storyId, userId: 'live-check', depth: 'standard' });
    await runResearch({
      taskKey,
      deps: {
        llm: createFixtureResearchLlm(),
        search: fixtureResearchSearch(researchResultsFor(story)),
        now: () => new Date(),
      },
    });
    llm = budgeted(mode === '1' ? await liveModel(records) : createFixtureResearchLlm(), log);
  }, 120_000);

  afterAll(async () => {
    console.info(
      `[live drafts] mode=${mode} calls=${log.calls} promptChars=${JSON.stringify(log.promptChars)} usage=${JSON.stringify(
        records.map((r) => ({
          operation: r.operation,
          model: r.model,
          outcome: r.outcome,
          input: r.usage.inputTokens,
          output: r.usage.outputTokens,
          reasoning: r.usage.reasoningTokens,
        })),
      )}`,
    );
    await db?.stop();
  });

  async function write(format: 'newsletter_item' | 'x_post') {
    const { taskKey } = await requestDraft({ storyId, userId: 'live-check', format });
    await runDraftGeneration({ taskKey, deps: { llm, now: () => new Date() } });
    const version = (await getDraftsView(storyId)).formats[format].versions[0]!;
    const measure = measureDraft(format, version.body);
    const statuses = version.claims.map((c) => c.citationStatus);
    console.info(
      `[live drafts] ${format}: ${measure.summary}; shortened=${version.shortened}; statements=${statuses.length} (quote found ${statuses.filter((s) => s === 'verified').length}, not found ${statuses.filter((s) => s === 'excerpt_not_located').length}, interpretation ${statuses.filter((s) => s === 'uncited').length}, dropped ${version.droppedClaims}); avoid-list phrases: ${JSON.stringify(AVOID.filter((p) => version.body.toLowerCase().includes(p)))}\n${version.title ? `${version.title}\n\n` : ''}${version.body}`,
    );
    return { version, measure };
  }

  it('writes a Weekly Briefing item that keeps to the contract', async () => {
    const { version, measure } = await write('newsletter_item');
    expect(version.title.length).toBeGreaterThan(0);
    expect(version.body).not.toMatch(/\[S\d+\]/);
    expect(version.claims.length).toBeGreaterThan(0);
    // Length and voice are observations for the report, not pass/fail rules.
    expect(measure.count).toBeGreaterThan(0);
  }, 180_000);

  it('writes an X post that fits as X counts it, or is flagged', async () => {
    const { version, measure } = await write('x_post');
    expect(version.title).toBe('');
    expect(version.body).not.toMatch(/\[S\d+\]/);
    // Either it fits, or the studio flags it; a post is never silently cut.
    if (measure.overLimit) expect(version.shortened).toBe(true);
    expect(log.calls).toBeLessThanOrEqual(MAX_CALLS);
  }, 180_000);
});
