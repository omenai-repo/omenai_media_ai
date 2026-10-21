/**
 * Bounded live check of the Anthropic path, through the production factory (`getLlmClient` with
 * LLM_PROVIDER=anthropic, Gemini settings left alongside) and the real services. Skipped unless
 * ANTHROPIC_LIVE_TESTS is set:
 *
 *   dry  The same steps with the scripted model; no network.
 *   1    Real Anthropic requests (needs approval): 3 expected, at most 6 HTTP requests in all,
 *        retries and repair rounds included. A guard below the SDK refuses a seventh request
 *        before it is sent, and refuses any request to the Gemini API outright.
 *
 *   ANTHROPIC_LIVE_TESTS=1 ANTHROPIC_LIVE_KEY_FILE=/path/to/env-file ANTHROPIC_LIVE_OUT=out.json \
 *     node node_modules/vitest/vitest.mjs run src/llm/anthropic.live.test.ts --silent=false
 *
 * Vitest hides the console output of passing tests unless `--silent=false` is given, so the
 * request log and usage also go to ANTHROPIC_LIVE_OUT. (The first run, 2026-10-21, lost its log
 * this way: its assertions passed, but its token counts weren't kept.)
 *
 * Only ANTHROPIC_API_KEY is read from the key file (never printed); nothing else in it is
 * loaded. The story and its research come from development fixtures in an in-memory database
 * (scripted research, fake search), so nothing reaches Tavily or Atlas. The content is invented.
 *
 * Cases: a structured classification (triage tier), a chat answer from supplied research
 * (primary tier, streamed), and a Weekly Briefing draft with an editor's instruction (primary
 * tier, streamed), each checked against what was saved.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';

import { getModels } from '../db/models.js';
import { getDraftsView } from '../drafts/queries.js';
import { requestDraft, runDraftGeneration } from '../drafts/service.js';
import { streamChatReply } from '../research/chat.js';
import { getResearchView } from '../research/queries.js';
import { postChatMessage, requestResearch, runResearch } from '../research/service.js';
import { startTestDatabase, type TestDatabase } from '../testing/index.js';
import { createFixtureResearchLlm } from '../testing/scenarios/executor.js';
import { fixtureResearchSearch, researchResultsFor } from '../testing/scenarios/research-script.js';
import { seedFixtureNewsroom } from '../testing/seed.js';
import { getLlmClient, resetLlmClientForTesting, type LlmClient } from './client.js';
import { createGeminiProvider } from './providers/gemini.js';

vi.mock('./providers/gemini.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./providers/gemini.js')>();
  return { ...actual, createGeminiProvider: vi.fn(actual.createGeminiProvider) };
});

const mode = process.env.ANTHROPIC_LIVE_TESTS;
const MAX_REQUESTS = 6;
const INSTRUCTION = 'Use a warm, friendly tone and write exactly three distinct paragraphs.';

/** HTTP requests seen below the SDK: every attempt, retry and repair round. */
const requests: Array<{ host: string; model: unknown; status?: number }> = [];

/** Installed before any adapter exists, so the SDK captures it as its fetch. */
function guardFetch() {
  const real = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const host = new URL(url).host;
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as { model?: unknown }) : {};
    if (host !== 'api.anthropic.com') {
      requests.push({ host, model: body.model });
      throw new Error(`Refused: a model request to ${host} (only Anthropic is allowed here).`);
    }
    if (requests.filter((r) => r.host === 'api.anthropic.com').length >= MAX_REQUESTS)
      throw new Error(
        `Live budget of ${MAX_REQUESTS} Anthropic requests reached; refusing another.`,
      );
    const entry: (typeof requests)[number] = { host, model: body.model };
    requests.push(entry);
    const response = await real(input, init);
    entry.status = response.status;
    return response;
  });
}

function anthropicKey(): string {
  const file = process.env.ANTHROPIC_LIVE_KEY_FILE;
  if (!file) throw new Error('Set ANTHROPIC_LIVE_KEY_FILE to the env file holding the key.');
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('ANTHROPIC_API_KEY='));
  const key = line?.slice('ANTHROPIC_API_KEY='.length).trim().replace(/^"|"$/g, '');
  if (!key) throw new Error(`No ANTHROPIC_API_KEY in ${file}.`);
  return key;
}

/** Records what each call returned and how many pieces it streamed. */
function observed(
  inner: LlmClient,
  calls: Array<{ operation: string; data: unknown; pieces: number }>,
) {
  return {
    ...inner,
    generateObject: async (request) => {
      const result = await inner.generateObject(request);
      calls.push({ operation: request.operation, data: result.data, pieces: 0 });
      return result;
    },
    streamObject: async (request) => {
      let pieces = 0;
      const result = await inner.streamObject({
        ...request,
        onText: (text) => {
          pieces += 1;
          request.onText?.(text);
        },
      });
      calls.push({ operation: request.operation, data: result.data, pieces });
      return result;
    },
  } satisfies LlmClient;
}

const collapse = (text: string) =>
  text
    .replace(/\s*\[S\d+(?:\s*,\s*S\d+)*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

describe.skipIf(mode !== '1' && mode !== 'dry')('live Anthropic check (bounded)', () => {
  let db: TestDatabase;
  let storyId: string;
  let llm: LlmClient;
  const calls: Array<{ operation: string; data: unknown; pieces: number }> = [];

  beforeAll(async () => {
    db = await startTestDatabase();
    await seedFixtureNewsroom();
    const { Story } = await getModels();
    const story = (await Story.findOne({ headline: /Zeitz MOCAA opens/ }).lean())!;
    storyId = String(story._id);
    // Research from fixtures: scripted model and fake search, never a provider or Tavily.
    const { taskKey } = await requestResearch({ storyId, userId: 'live-check', depth: 'standard' });
    await runResearch({
      taskKey,
      deps: {
        llm: createFixtureResearchLlm(),
        search: fixtureResearchSearch(researchResultsFor(story)),
        now: () => new Date(),
      },
    });

    if (mode === '1') {
      guardFetch();
      // Production's resolution: Anthropic selected, Gemini settings still present and ignored.
      Object.assign(process.env, {
        LLM_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: anthropicKey(),
        GEMINI_API_KEY: 'unused-gemini-key',
        GEMINI_MODEL_PRIMARY: 'gemini-3.8-flash',
      });
      delete process.env.AI_DAILY_CALL_LIMIT;
      resetLlmClientForTesting();
      vi.spyOn(console, 'info').mockImplementation(() => undefined);
      llm = observed(getLlmClient(), calls);
      vi.mocked(console.info).mockRestore();
      expect(llm.provider).toBe('anthropic');
    } else {
      llm = observed(createFixtureResearchLlm(), calls);
    }
  }, 120_000);

  afterAll(async () => {
    const { AiUsage } = await getModels();
    const usage = await AiUsage.find({ kind: 'llm' }).sort({ createdAt: 1 }).lean();
    const report = {
      mode,
      httpRequests: requests,
      usage: usage
        .filter((u) => !u.simulated)
        .map((u) => ({
          operation: u.operation,
          provider: u.provider,
          model: u.model,
          outcome: u.outcome,
          errorKind: u.errorKind,
          input: u.inputTokens,
          cached: u.cachedInputTokens,
          output: u.outputTokens,
          reasoning: u.reasoningTokens,
          attempts: u.attempts,
          latencyMs: u.latencyMs,
          firstChunkMs: u.firstChunkMs,
        })),
    };
    // Vitest hides a passing test's console output; the file keeps the evidence of a paid run.
    if (process.env.ANTHROPIC_LIVE_OUT)
      writeFileSync(process.env.ANTHROPIC_LIVE_OUT, JSON.stringify(report, null, 2));
    console.info(`[live anthropic] ${JSON.stringify(report)}`);
    resetLlmClientForTesting();
    vi.unstubAllGlobals();
    await db?.stop();
  });

  it('returns a valid structured classification on the triage tier', async () => {
    const schema = z.object({
      pillar: z.enum(['art_creative_expression', 'ideas_history_cultural_change', 'other']),
      confidence: z.enum(['low', 'medium', 'high']),
      reason: z.string().min(10),
    });
    const ask = () =>
      llm.generateObject({
        operation: 'live.classify',
        tier: 'triage',
        system: 'Classify the story into one Omenai pillar. Answer in JSON.',
        messages: [
          {
            role: 'user',
            content:
              'Zeitz MOCAA opens the first major retrospective of the Ghanaian sculptor Kwame Asante.',
          },
        ],
        maxOutputTokens: 300,
        schema,
        retry: { attempts: 1, initialDelayMs: 1_000, maxDelayMs: 1_000 },
      });
    if (mode !== '1') return;
    const result = await ask();
    console.info(`[live anthropic] classify: ${JSON.stringify(result.data)} model=${result.model}`);
    expect(result.provider).toBe('anthropic');
    expect(result.model).toMatch(/^claude-haiku-5-5/);
    expect(schema.safeParse(result.data).success).toBe(true);
  }, 120_000);

  it('answers from the supplied research, with citations checked against stored sources', async () => {
    const question = 'What have critics said about Kwame Asante so far?';
    const { taskKey } = await postChatMessage({ storyId, userId: 'live-check', content: question });
    const events: string[] = [];
    await streamChatReply({
      taskKey,
      deps: { llm, now: () => new Date() },
      onEvent: (event) => events.push(event.type),
    });
    const view = await getResearchView(storyId);
    const reply = view.messages.find((m) => m.role === 'assistant')!;
    const { SourceArticle } = await getModels();
    const known = new Set(
      (await SourceArticle.find({}, { _id: 1 }).lean()).map((a) => String(a._id)),
    );
    console.info(
      `[live anthropic] chat: assessment=${reply.assessment} scope=${reply.scope} streamedTextEvents=${events.filter((e) => e === 'text').length} claims=${JSON.stringify(
        (reply.claims ?? []).map((c) => ({ text: c.text, status: c.citationStatus })),
      )}\n${reply.content}`,
    );
    expect(events).toContain('done');
    expect(reply.content.length).toBeGreaterThan(0);
    // Every cited source is one we stored; nothing cited comes from model text.
    for (const claim of reply.claims ?? [])
      for (const id of claim.sourceIds) expect(known.has(id)).toBe(true);
    for (const citation of reply.citations) expect(known.has(citation.sourceId)).toBe(true);
    if (mode === '1') expect(calls.at(-1)?.pieces).toBeGreaterThan(1);
  }, 180_000);

  it('writes a draft that follows the editor’s instruction and saves what the model returned', async () => {
    const { taskKey } = await requestDraft({
      storyId,
      userId: 'live-check',
      format: 'newsletter_item',
      instructions: INSTRUCTION,
    });
    await runDraftGeneration({ taskKey, deps: { llm, now: () => new Date() } });
    const version = (await getDraftsView(storyId)).formats.newsletter_item.versions[0]!;
    const generated = calls.filter((c) => c.operation.startsWith('draft.')).at(-1)!;
    const { DraftVersion } = await getModels();
    const saved = (await DraftVersion.findOne({ taskId: taskKey }, { model: 1 }).lean())!;
    const paragraphs = version.body.split(/\n\s*\n/).filter((p) => p.trim());
    console.info(
      `[live anthropic] draft: paragraphs=${paragraphs.length} streamedPieces=${generated.pieces} shortened=${version.shortened} model=${saved.model}\n${version.title}\n\n${version.body}`,
    );
    expect(version.instructions).toBe(INSTRUCTION);
    // The saved text is the model's text, minus source labels and spacing.
    expect(collapse(version.body)).toBe(collapse((generated.data as { body: string }).body));
    if (mode !== '1') return;
    expect(saved.model).toMatch(/^claude-sonnet-5-5/);
    expect(generated.pieces).toBeGreaterThan(1);
    expect(paragraphs).toHaveLength(3);
    expect(vi.mocked(createGeminiProvider)).not.toHaveBeenCalled();
    expect(requests.every((r) => r.host === 'api.anthropic.com')).toBe(true);
    expect(requests.length).toBeLessThanOrEqual(MAX_REQUESTS);
  }, 240_000);
});
