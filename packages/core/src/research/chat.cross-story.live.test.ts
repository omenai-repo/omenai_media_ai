/**
 * Bounded cross-story evaluation of the chat's evidence judgement (ADR-038, ADR-039) on real
 * stories and their saved research. Skipped unless CROSS_STORY_LIVE is set:
 *
 *   dry   The cases with the scripted model: checks the harness, no model calls.
 *   eval  The cases on the configured Gemini model. At most 24 model calls, repairs and failures
 *         included; a guard refuses the 25th. Needs the product owner's approval.
 *
 *   CROSS_STORY_LIVE=eval CROSS_STORY_OUT=/path/to/out.json \
 *     node --env-file=../../apps/worker/.env node_modules/vitest/vitest.mjs run src/research/chat.cross-story.live.test.ts
 *
 * Every story, brief and source is read (read-only) from the live-development database into an
 * in-memory one. No search is made: research a reply would start is recorded, never run. Only
 * the usage rows of a real run are written back, so its calls count against the daily limit.
 * Expected outcomes were set from the stored source text before the run; this file records what
 * happened, and the judgement against those expectations is made by reading the evidence.
 */
import { writeFileSync } from 'node:fs';

import { MongoClient, ObjectId, type Document } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getModels } from '../db/models.js';
import { createLlmClient, type LlmClient } from '../llm/client.js';
import { readLlmConfig } from '../llm/config.js';
import { createGeminiProvider } from '../llm/providers/gemini.js';
import type { LlmUsageRecord } from '../llm/usage.js';
import { startTestDatabase, type TestDatabase } from '../testing/index.js';
import { createFixtureResearchLlm } from '../testing/scenarios/executor.js';
import { streamChatReply } from './chat.js';
import { getResearchView } from './queries.js';
import { postChatMessage } from './service.js';

const mode = process.env.CROSS_STORY_LIVE;
const LIVE_DB = process.env.CROSS_STORY_DB ?? 'omenai_live_dev';
/** At most 24; CROSS_STORY_MAX_CALLS can only lower it (re-running cases a limit stopped). */
const MAX_CALLS = Math.min(24, Number(process.env.CROSS_STORY_MAX_CALLS ?? 24) || 24);

const STORIES = {
  market: '6ad23e006294bdee6a226525', // East African modernism auction (art market)
  heritage: '6ad23e026294bdee6a226529', // Fayoum mummy portraits restored (heritage)
  spaces: '6ad23e006294bdee6a226524', // African galleries beyond the white cube (exhibitions)
  museum: '6ad23e006294bdee6a226526', // Met curator, Rockefeller Wing (museums)
} as const;

type Expected = 'sufficient' | 'needs_research' | 'out_of_scope' | 'not_refused';

/** Expected outcomes, set from the stored sources (see VERIFICATION.md for the evidence). */
const CASES: Array<{
  name: string;
  story: keyof typeof STORIES;
  question: string;
  expected: Expected;
  tests: string;
}> = [
  {
    name: 'M1',
    story: 'market',
    question:
      'When and where will this year’s Art Auction East Africa sale with Strauss & Co take place?',
    expected: 'sufficient',
    tests: 'exact date, stated in the source',
  },
  {
    name: 'M2',
    story: 'market',
    question: 'How many lots are in this year’s sale?',
    expected: 'sufficient',
    tests: 'figure written as "a 67-lot sale" (paraphrase)',
  },
  {
    name: 'M3',
    story: 'market',
    question: 'Who founded Art Auction East Africa, and in what year?',
    expected: 'sufficient',
    tests: 'name and founding year in one attributed sentence',
  },
  {
    name: 'M4',
    story: 'market',
    question: 'How much did the 2025 edition of the sale make in total?',
    expected: 'needs_research',
    tests: 'related only: "selling above pre-sale estimates"',
  },
  {
    name: 'M5',
    story: 'market',
    question: 'When did Ahmed Shibrain die?',
    expected: 'needs_research',
    tests: 'incidental mention: named, no dates',
  },
  {
    name: 'M6',
    story: 'market',
    question: 'What price did K.F. Msangi’s My First Wife sell for?',
    expected: 'not_refused',
    tests: 'estimate is not a sale price; the sale is still to come (ambiguous assessment)',
  },
  {
    name: 'M7',
    story: 'market',
    question: 'How does the Khartoum School relate to modernism elsewhere in Africa?',
    expected: 'not_refused',
    tests: 'wider-culture scope',
  },
  {
    name: 'H1',
    story: 'heritage',
    question: 'How long did the restoration of the Tondo of the Two Brothers take?',
    expected: 'sufficient',
    tests: 'duration written in words ("three weeks")',
  },
  {
    name: 'H2',
    story: 'heritage',
    question: 'When will the Fayoum portraits be shown in Rome?',
    expected: 'not_refused',
    tests: 'months without a year (partial is honest)',
  },
  {
    name: 'H3',
    story: 'heritage',
    question: 'What technique was used to paint the Tondo of the Two Brothers?',
    expected: 'sufficient',
    tests: 'paraphrase ("molten wax"); a different portrait in tempera is related only',
  },
  {
    name: 'H4',
    story: 'heritage',
    question: 'When was the Tondo of the Two Brothers discovered?',
    expected: 'needs_research',
    tests: 'related only: excavation dates for Fayoum portraits in general',
  },
  {
    name: 'H5',
    story: 'heritage',
    question: 'Which pieces will travel with the Tondo of the Two Brothers to Rome?',
    expected: 'needs_research',
    tests: 'repeat of a researched question: no second research',
  },
  {
    name: 'H6',
    story: 'heritage',
    question: 'Would this story suit our heritage newsletter?',
    expected: 'sufficient',
    tests: 'editorial judgement',
  },
  {
    name: 'S1',
    story: 'spaces',
    question: 'When did Uthman Wahaab’s exhibition Alas, We Meet Again open at Windsor Gallery?',
    expected: 'needs_research',
    tests: 'only "a Friday in the middle of July", no year',
  },
  {
    name: 'S2',
    story: 'spaces',
    question: 'Where did Wahaab previously show Where Is Chi Chi?',
    expected: 'sufficient',
    tests: 'place and gallery in the source (formerly unlocated quote)',
  },
  {
    name: 'S3',
    story: 'spaces',
    question: 'When is Africa Basel 2026 taking place?',
    expected: 'sufficient',
    tests: 'date range in a second source',
  },
  {
    name: 'S4',
    story: 'spaces',
    question: 'Can you recommend a good laptop for video editing?',
    expected: 'out_of_scope',
    tests: 'unrelated question',
  },
  {
    name: 'L1',
    story: 'museum',
    question: 'When did the Rockefeller Wing reopen?',
    expected: 'not_refused',
    tests:
      '"scheduled to reopen in May 2025" and "completed at the end of May 2025" (no exact day)',
  },
];

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

/** Every case's story with its briefs and sources, and the 24-hour usage; nothing is written. */
async function readSnapshot() {
  return withLiveDatabase(async (client) => {
    const db = client.db(liveDatabaseName());
    const ids = Object.values(STORIES).map((id) => new ObjectId(id));
    const stories = await db
      .collection('stories')
      .find({ _id: { $in: ids } })
      .toArray();
    if (stories.length !== ids.length)
      throw new Error('A case story is missing from the database.');
    const briefs = await db
      .collection('researchBriefs')
      .find({ storyId: { $in: ids } })
      .toArray();
    const sourceIds = [
      ...stories.flatMap((s) => (s.sourceArticleIds as ObjectId[] | undefined) ?? []),
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
    return { stories, briefs, articles, aiCallsToday };
  });
}

describe.skipIf(mode !== 'eval' && mode !== 'dry')('cross-story chat evaluation (bounded)', () => {
  let db: TestDatabase;
  let llm: LlmClient;
  const records: Array<LlmUsageRecord & { at: Date }> = [];
  const results: Record<string, unknown> = {};
  let calls = 0;
  /** Set by a rate-limit or quota error: no further calls in this run. */
  let stopped = false;

  beforeAll(async () => {
    const snapshot = await readSnapshot();
    if (mode === 'eval') {
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
          if (stopped)
            return Promise.reject(new Error('Stopped after a rate-limit or quota error.'));
          if (calls >= MAX_CALLS)
            return Promise.reject(new Error(`Live budget of ${MAX_CALLS} model calls reached.`));
          calls += 1;
          return Promise.resolve();
        },
      });
    } else {
      llm = createFixtureResearchLlm();
    }
    db = await startTestDatabase();
    await db.db.collection('stories').insertMany(snapshot.stories);
    await db.db.collection('researchBriefs').insertMany(snapshot.briefs);
    await db.db.collection('sourceArticles').insertMany(snapshot.articles);
  }, 120_000);

  afterAll(async () => {
    results.calls = calls;
    results.usage = records.map((r) => ({
      operation: r.operation,
      outcome: r.outcome,
      errorKind: r.errorKind ?? null,
      input: r.usage.inputTokens,
      output: r.usage.outputTokens,
      reasoning: r.usage.reasoningTokens,
      latencyMs: r.latencyMs ?? null,
      firstChunkMs: r.firstChunkMs ?? null,
      attempts: r.attempts ?? null,
      repairReason: r.repairReason ?? null,
    }));
    if (mode === 'eval' && records.length)
      await withLiveDatabase((client) =>
        client
          .db(liveDatabaseName())
          .collection('aiUsage')
          .insertMany(
            records.map((r): Document => ({
              provider: r.provider,
              kind: 'llm',
              operation: `eval.chat.${r.operation}`,
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
              storyId: null,
              latencyMs: r.latencyMs ?? null,
              firstChunkMs: r.firstChunkMs ?? null,
              attempts: r.attempts ?? null,
              retryStatuses: r.retryStatuses ?? [],
              repairReason: r.repairReason ?? null,
              simulated: false,
              createdAt: r.at,
            })),
          ),
      );
    const out = process.env.CROSS_STORY_OUT;
    if (out) writeFileSync(out, JSON.stringify(results, null, 2));
    await db?.stop();
  }, 120_000);

  it.each(CASES)(
    '$name ($story): $tests',
    async (c) => {
      const { ChatMessage, Task } = await getModels();
      await ChatMessage.deleteMany({});
      const storyId = STORIES[c.story];
      const started = Date.now();
      let firstTextMs: number | null = null;
      let error: string | null = null;
      const { taskKey } = await postChatMessage({
        storyId,
        userId: 'live-check',
        content: c.question,
      });
      let followUp: unknown = null;
      try {
        const result = await streamChatReply({
          taskKey,
          deps: { llm, now: () => new Date() },
          receivedAt: started,
          onEvent: (event) => {
            if (event.type === 'text' && firstTextMs === null) firstTextMs = Date.now() - started;
          },
        });
        followUp = result.followUp;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        if (/\b429\b|RESOURCE_EXHAUSTED|quota/i.test(error)) stopped = true;
      }
      // Research a reply would start is recorded but never run: no search is made.
      await Task.updateMany(
        { kind: 'research', requestKind: 'followup', activeLock: { $exists: true } },
        {
          $set: { status: 'skipped', lastError: 'Not run by the evaluation.' },
          $unset: { activeLock: '' },
        },
      );
      const view = await getResearchView(storyId);
      const reply = view.messages.find((m) => m.role === 'assistant') ?? null;
      results[c.name] = {
        ...c,
        error,
        firstTextMs,
        totalMs: Date.now() - started,
        scope: reply?.scope ?? null,
        assessment: reply?.assessment ?? null,
        evidence: reply?.evidence ?? null,
        evidenceCheck: reply?.evidenceCheck ?? null,
        followUp: reply?.followUp ?? null,
        researchStarted: Boolean(followUp),
        suggestedFocus: reply?.suggestedFocus ?? null,
        droppedClaims: reply?.droppedClaims ?? 0,
        answer: reply?.content ?? null,
        statements: (reply?.claims ?? []).map((s) => ({
          type: s.type,
          text: s.text,
          status: s.citationStatus,
          excerpt: s.excerpt,
        })),
      };
      expect(error).toBeNull();
      expect(calls).toBeLessThanOrEqual(MAX_CALLS);
    },
    120_000,
  );
});
