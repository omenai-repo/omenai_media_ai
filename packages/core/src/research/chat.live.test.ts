/**
 * Bounded live evaluation of the research chat against a real story. Skipped unless
 * CHAT_LIVE_TESTS is set; `eval` spends real quota and needs the product owner's approval:
 *
 *   dry   The same eight cases with the scripted model: checks the harness, no model calls.
 *   eval  The eight cases on the configured Gemini model, streamed. At most 12 model calls
 *         (8 answers plus repair rounds); a guard refuses a 13th.
 *
 * A re-check of some cases lowers the cap and filters by name, e.g. CHAT_LIVE_MAX_CALLS=2 with
 * -t "direct follow-up|related date".
 *
 *   CHAT_LIVE_TESTS=eval CHAT_LIVE_OUT=/path/to/out.json \
 *     node --env-file=../../apps/worker/.env node_modules/vitest/vitest.mjs run src/research/chat.live.test.ts
 *
 * The story, its briefs and their sources are read (read-only) from the live-development
 * database into an in-memory database; nothing in Atlas changes except the usage rows a real
 * run records afterwards, so its calls count against the daily limit like any other.
 *
 * The baseline before the change (2026-10-16, the two-call path: a scope check, then the
 * answer) was measured with the earlier version of this file; its results are in
 * docs/VERIFICATION.md.
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
import { outOfScopeReply, streamChatReply, type ChatEvent } from './chat.js';
import { getResearchView } from './queries.js';
import { postChatMessage } from './service.js';

const mode = process.env.CHAT_LIVE_TESTS;
const LIVE_DB = process.env.CHAT_LIVE_DB ?? 'omenai_live_dev';
/** "Met Curator Alisa LaGamma on the Rockefeller Wing and Restitution" in omenai_live_dev. */
const STORY_ID = process.env.CHAT_LIVE_STORY ?? '6ad23e006294bdee6a226526';
/** At most 12; CHAT_LIVE_MAX_CALLS can only lower it (a re-check of some cases). */
const MAX_CALLS = Math.min(12, Number(process.env.CHAT_LIVE_MAX_CALLS ?? 12) || 12);

/** The eight regression cases, in order. */
const CASES = {
  editorialFit: 'Do you think this story appeals to Omenai’s focus on contemporary art?',
  directFollowUp: 'What does LaGamma say about the reopening of the Rockefeller Wing?',
  widerCulture:
    'How does this connect to wider debates about the restitution of African art held in European museums?',
  unrelated: 'Can you help me write a Python script that renames files in a folder?',
  appointmentDate:
    'When was Alisa LaGamma appointed to her position as the Ceil and Michael E. Pulitzer Curator at the Metropolitan Museum of Art?',
  insufficient:
    'How many visitors did the Rockefeller Wing receive in its first month after reopening?',
  shortFact: 'Which museum is LaGamma a curator at?',
  angle: 'What angle would make this work for Omenai’s readers?',
} as const;
type CaseName = keyof typeof CASES;

const BRIEF_HEADINGS = /why it matters|still to confirm|background:|^#+\s|what we found/im;

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
    const briefs = await db
      .collection('researchBriefs')
      .find({ storyId: id })
      .sort({ createdAt: 1 })
      .toArray();
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

describe.skipIf(mode !== 'eval' && mode !== 'dry')('live chat evaluation (bounded)', () => {
  let db: TestDatabase;
  let llm: LlmClient;
  const records: Array<LlmUsageRecord & { at: Date }> = [];
  const results: Record<string, unknown> = {};
  let calls = 0;
  let headline = '';
  let snapshotSourceIds = new Set<string>();

  beforeAll(async () => {
    const snapshot = await readSnapshot();
    headline = snapshot.story.headline as string;
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
    snapshotSourceIds = new Set(snapshot.articles.map((a) => String(a._id)));
    results.snapshot = {
      story: headline,
      briefs: snapshot.briefs.length,
      sources: snapshot.articles.length,
    };
  }, 120_000);

  afterAll(async () => {
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
    if (mode === 'eval') await recordLiveUsage(records);
    const out = process.env.CHAT_LIVE_OUT;
    if (out) writeFileSync(out, JSON.stringify(results, null, 2));
    console.info(`[live chat] ${JSON.stringify(results, null, 1)}`);
    await db?.stop();
  }, 120_000);

  /** Asks one question in a fresh conversation, streamed, and records what happened when. */
  async function ask(name: CaseName) {
    const { ChatMessage, Task } = await getModels();
    await ChatMessage.deleteMany({});
    const started = Date.now();
    const events: Array<{ at: number; type: ChatEvent['type']; chars?: number }> = [];
    const { taskKey } = await postChatMessage({
      storyId: STORY_ID,
      userId: 'live-check',
      content: CASES[name],
    });
    let error: string | null = null;
    try {
      await streamChatReply({
        taskKey,
        deps: { llm, now: () => new Date() },
        receivedAt: started,
        onEvent: (event) =>
          events.push({
            at: Date.now() - started,
            type: event.type,
            ...(event.type === 'text' ? { chars: event.text.length } : {}),
          }),
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    // This evaluation judges the assessment; research a reply started isn't run here (no search
    // credits). Released, so the next case can ask.
    await Task.updateMany(
      { kind: 'research', requestKind: 'followup', activeLock: { $exists: true } },
      {
        $set: { status: 'skipped', lastError: 'Not run by the chat evaluation.' },
        $unset: { activeLock: '' },
      },
    );
    const view = await getResearchView(STORY_ID);
    const reply = view.messages.find((m) => m.role === 'assistant') ?? null;
    const statements = reply?.claims ?? [];
    const firstText = events.find((e) => e.type === 'text');
    const outcome = {
      question: CASES[name],
      error,
      firstTextMs: firstText?.at ?? null,
      doneMs: events.find((e) => e.type === 'done')?.at ?? null,
      textEvents: events.filter((e) => e.type === 'text').length,
      assessment: reply?.assessment ?? null,
      scope: reply?.scope ?? null,
      evidence: reply?.evidence ?? null,
      researchQuestion: reply?.followUp?.question ?? reply?.suggestedFocus ?? null,
      researchStarted: reply?.followUp?.status === 'started',
      words: reply ? reply.content.split(/\s+/).filter(Boolean).length : 0,
      answer: reply?.content ?? null,
      statements: statements.map((c) => ({
        type: c.type,
        text: c.text,
        sources: c.sourceLabels,
        status: c.citationStatus,
        excerpt: c.excerpt,
      })),
      droppedClaims: reply?.droppedClaims ?? 0,
    };
    results[name] = outcome;
    return { reply, outcome, view };
  }

  /** Every cited source is one of this story's stored sources. */
  function citationsResolve(view: Awaited<ReturnType<typeof getResearchView>>) {
    for (const message of view.messages)
      for (const claim of message.claims ?? [])
        for (const label of claim.sourceLabels) expect(label).toMatch(/^S\d+$/);
    for (const id of Object.keys(view.sources)) expect(snapshotSourceIds.has(id)).toBe(true);
  }

  it('1. answers whether the story suits Omenai’s contemporary-art focus, without refusing', async () => {
    const { reply, outcome, view } = await ask('editorialFit');
    expect(outcome.error).toBeNull();
    expect(reply?.scope).not.toBe('unrelated');
    // A judgement the saved research can inform: answered, not researched.
    if (mode === 'eval') expect(reply?.assessment).toBe('sufficient');
    expect(reply?.content).not.toBe(outOfScopeReply(headline));
    expect(reply?.content ?? '').not.toMatch(BRIEF_HEADINGS);
    citationsResolve(view);
  }, 120_000);

  it('2. answers a direct follow-up about the story from its sources', async () => {
    const { reply, outcome, view } = await ask('directFollowUp');
    expect(outcome.error).toBeNull();
    expect(reply?.scope).toBe('about_story');
    expect(reply?.content ?? '').not.toMatch(BRIEF_HEADINGS);
    citationsResolve(view);
  }, 120_000);

  it('3. takes a wider art-and-culture question instead of refusing it for changing scope', async () => {
    const { reply, outcome, view } = await ask('widerCulture');
    expect(outcome.error).toBeNull();
    expect(reply?.scope).not.toBe('unrelated');
    citationsResolve(view);
  }, 120_000);

  it('4. redirects a genuinely unrelated question politely, in the server’s words', async () => {
    const { reply, outcome } = await ask('unrelated');
    expect(outcome.error).toBeNull();
    expect(reply).toMatchObject({ scope: 'unrelated', content: outOfScopeReply(headline) });
  }, 120_000);

  it('5. never presents a related date as the date of the specific appointment', async () => {
    const { reply, outcome, view } = await ask('appointmentDate');
    expect(outcome.error).toBeNull();
    // A meaning check for a real model; the scripted one (dry) can't read the question. The career
    // date in the saved research is related, not the answer: research is needed.
    if (mode === 'eval') {
      expect(reply?.evidence).not.toBe('sufficient');
      expect(reply?.assessment).toBe('needs_research');
    }
    // No fact or attributed statement may give an appointment year its own quote doesn't back
    // together with the title (the stored sources give only "a curator … since 1996").
    for (const claim of reply?.claims ?? []) {
      if (claim.type !== 'fact' && claim.type !== 'attributed') continue;
      const states =
        /\b(19|20)\d{2}\b/.test(claim.text) && /appoint|named|became|took up/i.test(claim.text);
      const backed =
        /pulitzer/i.test(claim.excerpt ?? '') && /\b(19|20)\d{2}\b/.test(claim.excerpt ?? '');
      if (states && !/not|n’t|n't|unclear|unknown|doesn|don/i.test(claim.text))
        expect(backed).toBe(true);
    }
    citationsResolve(view);
  }, 120_000);

  it('6. says honestly when the research can’t answer', async () => {
    const { reply, outcome } = await ask('insufficient');
    expect(outcome.error).toBeNull();
    expect(reply?.evidence).not.toBe('sufficient');
    expect(reply?.scope).not.toBe('unrelated');
    if (mode === 'eval') expect(reply?.assessment).toBe('needs_research');
  }, 120_000);

  it('7. keeps a short factual answer short, with its citation on the statement', async () => {
    const { reply, outcome, view } = await ask('shortFact');
    expect(outcome.error).toBeNull();
    if (mode === 'eval') expect(reply?.assessment).toBe('sufficient');
    expect(reply?.content ?? '').not.toMatch(BRIEF_HEADINGS);
    expect(outcome.words).toBeLessThanOrEqual(120);
    citationsResolve(view);
  }, 120_000);

  it('8. gives an editorial angle as judgement, without briefing sections', async () => {
    const { reply, outcome, view } = await ask('angle');
    expect(outcome.error).toBeNull();
    expect(reply?.scope).not.toBe('unrelated');
    expect(reply?.content ?? '').not.toMatch(BRIEF_HEADINGS);
    citationsResolve(view);
    expect(calls).toBeLessThanOrEqual(MAX_CALLS);
  }, 120_000);
});
