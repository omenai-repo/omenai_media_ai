/**
 * Bounded live evaluation of draft-writing speed and quality at two reasoning levels, on a real
 * story's research. Skipped unless DRAFT_EVAL is set; `live` spends real quota and needs the
 * product owner's approval:
 *
 *   dry   The same cases with the scripted model: checks the harness, no model calls.
 *   live  Each case on the configured Gemini model, streamed (so the time to the first words is
 *         measured). At most MAX_CALLS model calls (cases plus repair or shortening rounds); a
 *         guard refuses one more.
 *
 *   DRAFT_EVAL=live DRAFT_EVAL_OUT=/path/to/out.json \
 *     node --env-file=../../apps/worker/.env node_modules/vitest/vitest.mjs run src/drafts/drafts.eval.live.test.ts
 *
 * The story, its briefs and their sources are read (read-only) from the live-development
 * database into an in-memory database, and the real `runDraftGeneration` writes each draft there.
 * Nothing in Atlas changes except the usage rows a live run records afterwards (`eval.draft.*`),
 * so its calls count against the daily limit like any other. The drafts' text goes only to the
 * output file, for the editors' own comparison.
 */
import { writeFileSync } from 'node:fs';

import { DRAFT_FORMATS, measureDraft, type DraftFormat } from '@repo/shared';
import { MongoClient, ObjectId, type Document } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getModels } from '../db/models.js';
import { createLlmClient, type LlmClient } from '../llm/client.js';
import { readLlmConfig } from '../llm/config.js';
import { parsePartialJson } from '../llm/partial-json.js';
import { createGeminiProvider } from '../llm/providers/gemini.js';
import type { Effort } from '../llm/types.js';
import type { LlmUsageRecord } from '../llm/usage.js';
import { startTaskAttempt } from '../tasks/service.js';
import { startTestDatabase, type TestDatabase } from '../testing/index.js';
import { createFixtureResearchLlm } from '../testing/scenarios/executor.js';
import { getDraftsView } from './queries.js';
import { requestDraft, runDraftGeneration } from './service.js';

const mode = process.env.DRAFT_EVAL;
const LIVE_DB = process.env.DRAFT_EVAL_DB ?? 'omenai_live_dev';
/** "Beyond the White Cube" in omenai_live_dev: the story of the last two real drafts. */
const STORY_ID = process.env.DRAFT_EVAL_STORY ?? '6ad23e006294bdee6a226524';
/** Samples of each case: one model call each varies a lot, so two by default (approved 2026-10-17). */
const REPEATS = Number(process.env.DRAFT_EVAL_REPEATS ?? 2);

/** The two drafts written for real on 2026-10-16, each at the current and a lower reasoning level. */
const DRAFTS: Array<{ format: DraftFormat; instructions: string | null }> = [
  {
    format: 'linkedin_post',
    instructions: 'Speak to Artists, galleries and museums based in Lagos',
  },
  { format: 'editorial_article', instructions: null },
];
const EFFORTS: Effort[] = ['medium', 'low'];

/** Interleaved (each round runs every case once), so drift over the run affects both levels alike. */
const CASES = Array.from({ length: REPEATS }, (_, round) =>
  DRAFTS.flatMap((draft) => EFFORTS.map((effort) => ({ ...draft, effort, sample: round + 1 }))),
).flat();
/** Every case once, plus two repair or shortening rounds at most. */
const MAX_CALLS = CASES.length + 2;

const AVOID = ['breaking barriers', 'redefining the landscape', 'at the intersection of'];

function liveDatabaseName(): string {
  if (!LIVE_DB.endsWith('_dev'))
    throw new Error(`Refusing to use ${LIVE_DB}: live checks use only a *_dev database.`);
  return LIVE_DB;
}

async function withLiveDatabase<T>(work: (client: MongoClient) => Promise<T>): Promise<T> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set (run with --env-file=../../apps/worker/.env).');
  const client = new MongoClient(uri);
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.close();
  }
}

/** Reads the story and its research, and the 24-hour usage, without writing anything. */
async function readSnapshot() {
  return withLiveDatabase(async (client) => {
    const db = client.db(liveDatabaseName());
    const id = new ObjectId(STORY_ID);
    const story = await db.collection('stories').findOne({ _id: id });
    if (!story) throw new Error(`Story ${STORY_ID} not found in ${LIVE_DB}.`);
    const briefs = await db.collection('researchBriefs').find({ storyId: id }).toArray();
    const sourceIds = [
      ...((story.sourceArticleIds as ObjectId[] | undefined) ?? []),
      ...briefs.flatMap((b) =>
        (b.sources as Array<{ sourceArticleId: ObjectId }>).map((s) => s.sourceArticleId),
      ),
    ];
    const articles = await db
      .collection('sourceArticles')
      .find({ _id: { $in: sourceIds } })
      .toArray();
    const aiCallsToday = await db.collection('aiUsage').countDocuments({
      kind: 'llm',
      simulated: { $ne: true },
      createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60_000) },
    });
    return { story, briefs, articles, aiCallsToday };
  });
}

/** Records every real call in the live-development usage, so the daily limit counts it. */
async function recordLiveUsage(records: ReadonlyArray<LlmUsageRecord & { at: Date }>) {
  if (!records.length) return;
  await withLiveDatabase(async (client) => {
    await client
      .db(liveDatabaseName())
      .collection('aiUsage')
      .insertMany(
        records.map((r): Document => ({
          provider: r.provider,
          kind: 'llm',
          operation: `eval.${r.operation}`,
          model: r.model,
          tier: r.tier,
          inputTokens: r.usage.inputTokens,
          outputTokens: r.usage.outputTokens,
          cachedInputTokens: r.usage.cachedInputTokens,
          reasoningTokens: r.usage.reasoningTokens,
          units: null,
          outcome: r.outcome,
          errorKind: r.errorKind ?? null,
          runKey: null,
          taskId: null,
          storyId: STORY_ID,
          latencyMs: r.latencyMs ?? null,
          firstChunkMs: r.firstChunkMs ?? null,
          attempts: r.attempts ?? null,
          retryStatuses: r.retryStatuses ?? [],
          repairReason: r.repairReason ?? null,
          simulated: false,
          createdAt: r.at,
        })),
      );
  });
}

/** The same client at a fixed reasoning level, noting when the draft's first words arrive. */
function atEffort(llm: LlmClient, effort: Effort, firstWords: { at: number | null }): LlmClient {
  return {
    ...llm,
    streamObject: (request) =>
      llm.streamObject({
        ...request,
        effort,
        onText: (raw) => {
          if (firstWords.at === null) {
            const body = (parsePartialJson(raw) as { body?: unknown } | undefined)?.body;
            if (typeof body === 'string' && body.trim()) firstWords.at = performance.now();
          }
          request.onText?.(raw);
        },
      }),
    generateObject: (request) => llm.generateObject({ ...request, effort }),
  };
}

/** Rules a draft must keep that can be checked mechanically (the voice needs an editor's eye). */
function ruleChecks(format: DraftFormat, title: string, body: string) {
  const hashtags = body.match(/(^|\s)#[\p{L}\p{N}_]+/gu)?.length ?? 0;
  return {
    sourceLabels: /\[\s*S\d+/i.test(body),
    links: /https?:\/\/|www\./i.test(body),
    markdownHeadings: /^#{1,6}\s/m.test(body),
    emoji: /\p{Extended_Pictographic}/u.test(body),
    hashtags,
    titlePresent: DRAFT_FORMATS[format].hasTitle ? title.trim().length > 0 : null,
    avoidPhrases: AVOID.filter((p) => body.toLowerCase().includes(p)),
  };
}

describe.skipIf(mode !== 'live' && mode !== 'dry')('live draft evaluation (bounded)', () => {
  let db: TestDatabase;
  let llm: LlmClient;
  let calls = 0;
  const records: Array<LlmUsageRecord & { at: Date }> = [];
  const results: Record<string, unknown> = {};

  beforeAll(async () => {
    const snapshot = await readSnapshot();
    if (mode === 'live') {
      const config = readLlmConfig();
      if (config.provider !== 'gemini') throw new Error('This run is approved for Gemini only.');
      const limit = Number(process.env.AI_DAILY_CALL_LIMIT ?? 'NaN');
      if (!Number.isInteger(limit) || snapshot.aiCallsToday + MAX_CALLS > limit)
        throw new Error(
          `Not enough of the daily AI limit left: ${snapshot.aiCallsToday} used of ${limit}, this run needs up to ${MAX_CALLS}.`,
        );
      results.before = { aiCallsToday: snapshot.aiCallsToday, limit, models: config.models };
      llm = createLlmClient({
        provider: createGeminiProvider({ apiKey: config.apiKey }),
        models: config.models,
        recordUsage: (record) => {
          records.push({ ...record, at: new Date() });
          return Promise.resolve();
        },
        beforeCall: () => {
          if (calls >= MAX_CALLS)
            return Promise.reject(
              new Error(`Live budget of ${MAX_CALLS} model calls reached; refusing another.`),
            );
          calls += 1;
          return Promise.resolve();
        },
      });
    } else {
      llm = createFixtureResearchLlm();
    }

    db = await startTestDatabase();
    await db.db.collection('stories').insertOne(snapshot.story);
    if (snapshot.briefs.length)
      await db.db.collection('researchBriefs').insertMany(snapshot.briefs);
    if (snapshot.articles.length)
      await db.db.collection('sourceArticles').insertMany(snapshot.articles);
    results.snapshot = {
      story: snapshot.story.headline as string,
      briefs: snapshot.briefs.length,
      sources: snapshot.articles.length,
    };
  }, 120_000);

  afterAll(async () => {
    if (mode === 'live') await recordLiveUsage(records);
    results.calls = calls;
    results.usage = records.map((r) => ({
      operation: r.operation,
      model: r.model,
      outcome: r.outcome,
      errorKind: r.errorKind ?? null,
      input: r.usage.inputTokens,
      output: r.usage.outputTokens,
      reasoning: r.usage.reasoningTokens,
      latencyMs: r.latencyMs ?? null,
      firstChunkMs: r.firstChunkMs ?? null,
      attempts: r.attempts ?? null,
      retryStatuses: r.retryStatuses ?? [],
      repairReason: r.repairReason ?? null,
    }));
    const out = process.env.DRAFT_EVAL_OUT;
    if (out) writeFileSync(out, JSON.stringify(results, null, 2));
    console.info(`[draft eval] mode=${mode} calls=${calls}`);
    await db?.stop();
  });

  it.each(CASES)(
    'writes a $format at $effort reasoning (sample $sample), keeping to the contract',
    async ({ format, instructions, effort, sample }) => {
      const { Story, Task } = await getModels();
      const story = (await Story.findById(STORY_ID).lean())!;
      const { taskKey } = await requestDraft({
        storyId: String(story._id),
        userId: 'draft-eval',
        format,
        instructions,
      });
      await startTaskAttempt(taskKey, 1);
      const firstWords = { at: null as number | null };
      const usedBefore = records.length;
      const started = performance.now();
      let error: string | null = null;
      try {
        await runDraftGeneration({
          taskKey,
          deps: { llm: atEffort(llm, effort, firstWords), now: () => new Date() },
        });
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const totalMs = Math.round(performance.now() - started);
      const task = (await Task.findOne({ key: taskKey }).lean())!;
      const versions = (await getDraftsView(String(story._id))).formats[format].versions;
      const version = versions.find((v) => v.createdAt >= new Date(started - 60_000).toISOString());
      const statuses = version?.claims.map((c) => c.citationStatus) ?? [];
      const measure = version ? measureDraft(format, version.body) : null;
      const steps = (task.progress?.steps ?? []).map((s) => ({
        step: s.step,
        atMs: Math.round(s.startedAt.getTime() - (task.startedAt?.getTime() ?? 0)),
      }));
      results[`${format}.${effort}.${sample}`] = {
        error,
        totalMs,
        firstWordsMs: firstWords.at === null ? null : Math.round(firstWords.at - started),
        steps,
        calls: records.slice(usedBefore).map((r) => ({
          operation: r.operation,
          latencyMs: r.latencyMs ?? null,
          firstChunkMs: r.firstChunkMs ?? null,
          input: r.usage.inputTokens,
          output: r.usage.outputTokens,
          reasoning: r.usage.reasoningTokens,
          repairReason: r.repairReason ?? null,
        })),
        length: measure && {
          summary: measure.summary,
          overLimit: measure.overLimit,
          outsideGuidance: measure.outsideGuidance,
        },
        shortened: version?.shortened ?? null,
        statements: {
          total: statuses.length,
          quoteFound: statuses.filter((s) => s === 'verified').length,
          quoteNotFound: statuses.filter((s) => s === 'excerpt_not_located').length,
          detailMissing: statuses.filter((s) => s === 'detail_not_in_excerpt').length,
          interpretation: statuses.filter((s) => s === 'uncited').length,
          dropped: version?.droppedClaims ?? null,
        },
        rules: version ? ruleChecks(format, version.title, version.body) : null,
        title: version?.title ?? null,
        body: version?.body ?? null,
      };
      expect(error).toBeNull();
      expect(version).toBeDefined();
      expect(version!.body).not.toMatch(/\[S\d+\]/);
      expect(calls).toBeLessThanOrEqual(MAX_CALLS);
    },
    300_000,
  );
});
