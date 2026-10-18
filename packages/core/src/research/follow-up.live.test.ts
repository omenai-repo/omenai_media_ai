/**
 * Bounded live check of research-trail reuse and automatic evidence-gap research (ADR-038) on a
 * real story. Skipped unless FOLLOW_UP_LIVE is set; `live` spends real quota and needs the
 * product owner's approval:
 *
 *   dry   The same steps with the scripted model and a fake search: checks the harness, no model
 *         or search calls.
 *   live  Gemini and Tavily, streamed as in the app: at most MAX_CALLS model calls and MAX_CREDITS
 *         search credits; guards refuse more.
 *
 *   FOLLOW_UP_LIVE=live FOLLOW_UP_LIVE_OUT=/path/to/out.json \
 *     node --env-file=../../apps/worker/.env node_modules/vitest/vitest.mjs run src/research/follow-up.live.test.ts
 *
 * The story, its briefs and their sources are read (read-only) from the live-development database
 * into an in-memory one, where the questions, the follow-up research and its findings are saved.
 * Nothing in Atlas changes except the usage rows recorded afterwards (`eval.followup.*`), so the
 * daily limits count them. The follow-up runs in this process, as the worker would run it; the
 * Trigger.dev queue in front of it is measured separately.
 */
import { writeFileSync } from 'node:fs';

import { MongoClient, ObjectId, type Document } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { requireEnv } from '../config/env.js';
import { getModels } from '../db/models.js';
import { createLlmClient, type LlmClient } from '../llm/client.js';
import { readLlmConfig } from '../llm/config.js';
import { createGeminiProvider } from '../llm/providers/gemini.js';
import type { LlmUsageRecord } from '../llm/usage.js';
import { createTavilySearchClient } from '../search/tavily.js';
import type { SearchClient } from '../search/types.js';
import { startTaskAttempt } from '../tasks/service.js';
import { startTestDatabase, type TestDatabase } from '../testing/index.js';
import { createFixtureResearchLlm } from '../testing/scenarios/executor.js';
import { fixtureResearchSearch, researchResultsFor } from '../testing/scenarios/research-script.js';
import { streamChatReply, type ChatEvent } from './chat.js';
import { postChatMessage, runResearch } from './service.js';

const mode = process.env.FOLLOW_UP_LIVE;
const LIVE_DB = process.env.FOLLOW_UP_LIVE_DB ?? 'omenai_live_dev';
/** "Met Curator Alisa LaGamma on the Rockefeller Wing and Restitution" in omenai_live_dev. */
const STORY_ID = process.env.FOLLOW_UP_LIVE_STORY ?? '6ad23e006294bdee6a226526';
/** Four answers, one focused research call and one repair round at most. */
const MAX_CALLS = 6;
/** Two searches and one extract (five pages a credit). */
const MAX_CREDITS = 3;

const QUESTIONS = {
  /** Answered by the saved sources: no research. */
  fromSaved: 'Which museum is Alisa LaGamma a curator at?',
  /** Researched on 2026-10-16 (a lead): reused, never repeated. */
  earlierResearch: 'When was Alisa LaGamma appointed the Ceil and Michael E. Pulitzer Curator?',
  /** Not in the saved sources (they name the firm, not who leads it): research starts. */
  gap: 'Who leads WHY Architecture, the firm behind the renovated Rockefeller Wing?',
} as const;

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

/** The story and its research, and the 24-hour usage, read without writing anything. */
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
    const since = new Date(Date.now() - 24 * 60 * 60_000);
    const usage = await db
      .collection('aiUsage')
      .find({ createdAt: { $gte: since }, simulated: { $ne: true } })
      .toArray();
    return {
      story,
      briefs,
      articles,
      aiCalls: usage.filter((u) => u.kind === 'llm').length,
      searchCredits: usage
        .filter((u) => u.provider === 'tavily')
        .reduce((sum, u) => sum + Number(u.units ?? (u.outcome === 'ok' ? 1 : 0)), 0),
    };
  });
}

describe.skipIf(mode !== 'live' && mode !== 'dry')(
  'live follow-up research check (bounded)',
  () => {
    let db: TestDatabase;
    let llm: LlmClient;
    let search: SearchClient;
    let calls = 0;
    let credits = 0;
    const records: Array<LlmUsageRecord & { at: Date }> = [];
    const results: Record<string, unknown> = {};

    beforeAll(async () => {
      const snapshot = await readSnapshot();
      db = await startTestDatabase();
      await db.db.collection('stories').insertOne(snapshot.story);
      await db.db.collection('researchBriefs').insertMany(snapshot.briefs);
      await db.db.collection('sourceArticles').insertMany(snapshot.articles);
      results.snapshot = {
        story: snapshot.story.headline as string,
        briefs: snapshot.briefs.map((b) => ({
          requestKind: String(b.requestKind),
          focus: typeof b.focus === 'string' ? b.focus : null,
        })),
        sources: snapshot.articles.length,
      };
      if (mode === 'live') {
        const config = readLlmConfig();
        if (config.provider !== 'gemini') throw new Error('This run is approved for Gemini only.');
        const aiLimit = Number(process.env.AI_DAILY_CALL_LIMIT ?? 'NaN');
        const searchLimit = Number(process.env.SEARCH_DAILY_CREDIT_LIMIT ?? 'NaN');
        if (
          snapshot.aiCalls + MAX_CALLS > aiLimit ||
          snapshot.searchCredits + MAX_CREDITS > searchLimit
        )
          throw new Error(
            `Not enough of the daily limits left: ${snapshot.aiCalls}/${aiLimit} AI calls and ${snapshot.searchCredits}/${searchLimit} search credits used; this run needs up to ${MAX_CALLS} and ${MAX_CREDITS}.`,
          );
        results.before = { ...snapshot, story: undefined, briefs: undefined, articles: undefined };
        llm = createLlmClient({
          provider: createGeminiProvider({ apiKey: config.apiKey }),
          models: config.models,
          recordUsage: (record) => {
            records.push({ ...record, at: new Date() });
            return Promise.resolve();
          },
          beforeCall: () => {
            if (calls >= MAX_CALLS)
              return Promise.reject(new Error(`Live budget of ${MAX_CALLS} model calls reached.`));
            calls += 1;
            return Promise.resolve();
          },
        });
        const tavily = createTavilySearchClient({ apiKey: requireEnv('TAVILY_API_KEY') });
        const spend = (n: number) => {
          if (credits + n > MAX_CREDITS)
            throw new Error(`Live budget of ${MAX_CREDITS} search credits reached.`);
          credits += n;
        };
        search = {
          search: (query, options, context) => {
            spend(1);
            return tavily.search(query, options, context);
          },
          extract: (urls, context, options) => {
            spend(Math.ceil(urls.length / 5));
            return tavily.extract(urls, context, options);
          },
        };
      } else {
        llm = createFixtureResearchLlm();
        const { Story } = await getModels();
        search = fixtureResearchSearch(
          researchResultsFor((await Story.findById(STORY_ID).lean())!),
        );
      }
    }, 120_000);

    afterAll(async () => {
      const { AiUsage } = await getModels();
      const searchRows = await AiUsage.find({ provider: 'tavily' }).lean();
      if (mode === 'live')
        await withLiveDatabase(async (client) => {
          const usage = client.db(liveDatabaseName()).collection('aiUsage');
          const rows: Document[] = [
            ...records.map((r) => ({
              provider: r.provider,
              kind: 'llm',
              operation: `eval.followup.${r.operation}`,
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
            ...searchRows.map(({ _id, ...row }) => ({
              ...row,
              operation: `eval.followup.${String(row.operation)}`,
              storyId: STORY_ID,
              simulated: false,
            })),
          ];
          if (rows.length) await usage.insertMany(rows);
        });
      results.calls = calls;
      results.credits = credits;
      results.usage = records.map((r) => ({
        operation: r.operation,
        outcome: r.outcome,
        input: r.usage.inputTokens,
        output: r.usage.outputTokens,
        reasoning: r.usage.reasoningTokens,
        latencyMs: r.latencyMs ?? null,
        firstChunkMs: r.firstChunkMs ?? null,
        attempts: r.attempts ?? null,
        retryStatuses: r.retryStatuses ?? [],
        repairReason: r.repairReason ?? null,
      }));
      results.searchUsage = searchRows.map((r) => ({
        kind: r.kind,
        units: r.units,
        outcome: r.outcome,
      }));
      const out = process.env.FOLLOW_UP_LIVE_OUT;
      if (out) writeFileSync(out, JSON.stringify(results, null, 2));
      console.info(`[follow-up live] mode=${mode} calls=${calls} credits=${credits}`);
      await db?.stop();
    }, 120_000);

    const researchCount = async () => {
      const { Task } = await getModels();
      return Task.countDocuments({ kind: 'research' });
    };

    /** Asks a question as the app does, and records each stage's time. */
    async function ask(name: string, content: string) {
      const { Task, ChatMessage } = await getModels();
      const t0 = performance.now();
      const { taskKey } = await postChatMessage({
        storyId: STORY_ID,
        userId: 'live-check',
        content,
      });
      const saved = performance.now();
      const at: Partial<Record<ChatEvent['type'], number>> = {};
      const usedBefore = records.length;
      let error: string | null = null;
      let followUp: { taskKey: string } | null = null;
      let messageId: string | null = null;
      try {
        const result = await streamChatReply({
          taskKey,
          deps: { llm, now: () => new Date() },
          receivedAt: Date.now(),
          onEvent: (event) => {
            at[event.type] ??= Math.round(performance.now() - saved);
          },
        });
        followUp = result.followUp;
        messageId = result.messageId;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const task = (await Task.findOne({ key: taskKey }).lean())!;
      const steps = Object.fromEntries(
        (task.progress?.steps ?? []).map((s) => [s.step, s.startedAt.getTime()]),
      );
      const reply = messageId ? await ChatMessage.findById(messageId).lean() : null;
      const outcome = {
        question: content,
        error,
        saveQuestionMs: Math.round(saved - t0),
        contextLoadMs: steps.compose && steps.read ? steps.compose - steps.read : null,
        firstTextMs: at.text ?? null,
        doneMs: at.done ?? null,
        model: records.slice(usedBefore).map((r) => ({
          firstChunkMs: r.firstChunkMs ?? null,
          latencyMs: r.latencyMs ?? null,
          input: r.usage.inputTokens,
          output: r.usage.outputTokens,
        })),
        assessment: reply?.assessment ?? null,
        evidence: reply?.evidence ?? null,
        researchQuestion: reply?.suggestedFocus ?? null,
        followUp: reply?.followUp ?? null,
        answer: reply?.content ?? null,
        statements: (reply?.claims ?? []).map((c) => ({
          type: c.type,
          text: c.text,
          status: c.citationStatus,
          excerpt: c.excerpt,
        })),
      };
      results[name] = outcome;
      return { outcome, followUp };
    }

    it('1. answers from the saved research without research or search', async () => {
      const before = await researchCount();
      const { outcome, followUp } = await ask('fromSaved', QUESTIONS.fromSaved);
      expect(outcome.error).toBeNull();
      expect(followUp).toBeNull();
      expect(await researchCount()).toBe(before);
      expect(credits).toBe(0);
      if (mode === 'live') expect(outcome.assessment).toBe('sufficient');
    }, 120_000);

    it('2. reuses the earlier research on the appointment instead of repeating it', async () => {
      const before = await researchCount();
      const { outcome, followUp } = await ask('earlierResearch', QUESTIONS.earlierResearch);
      expect(outcome.error).toBeNull();
      expect(followUp).toBeNull();
      expect(await researchCount()).toBe(before);
      expect(credits).toBe(0);
    }, 120_000);

    it('3–4. researches a genuine gap on its own, then answers it again from what it saved', async () => {
      const { outcome, followUp } = await ask('gap', QUESTIONS.gap);
      expect(outcome.error).toBeNull();
      if (mode === 'live') expect(outcome.assessment).toBe('needs_research');
      if (!followUp) return;
      // The worker's part, timed step by step.
      const { Task, ResearchBrief } = await getModels();
      const usedBefore = records.length;
      await startTaskAttempt(followUp.taskKey, 1);
      const t0 = performance.now();
      let error: string | null = null;
      try {
        await runResearch({
          taskKey: followUp.taskKey,
          deps: { llm, search, now: () => new Date() },
        });
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const task = (await Task.findOne({ key: followUp.taskKey }).lean())!;
      const steps = (task.progress?.steps ?? []).map((s) => ({
        step: s.step,
        atMs: Math.round(s.startedAt.getTime() - (task.startedAt?.getTime() ?? 0)),
        counts: (s.counts as Record<string, number> | null | undefined) ?? null,
      }));
      const brief = await ResearchBrief.findOne({ taskId: followUp.taskKey }).lean();
      results.research = {
        error,
        totalMs: Math.round(performance.now() - t0),
        steps,
        model: records.slice(usedBefore).map((r) => ({
          operation: r.operation,
          latencyMs: r.latencyMs ?? null,
          repairReason: r.repairReason ?? null,
        })),
        credits,
        evidence: brief?.evidence ?? null,
        searchFailures: brief?.searchFailures ?? null,
        answer: brief?.sections
          .flatMap((s) =>
            s.claims.map((c) => ({
              section: s.kind,
              type: c.type,
              text: c.text,
              status: c.citationStatus,
            })),
          )
          .slice(0, 6),
      };
      expect(error).toBeNull();
      expect(brief).not.toBeNull();

      // 4. The same question again: answered from the saved findings, no new search.
      const creditsBefore = credits;
      const before = await researchCount();
      const again = await ask('gapAgain', QUESTIONS.gap);
      expect(again.outcome.error).toBeNull();
      expect(again.followUp).toBeNull();
      expect(await researchCount()).toBe(before);
      expect(credits).toBe(creditsBefore);
      expect(calls).toBeLessThanOrEqual(MAX_CALLS);
    }, 300_000);
  },
);
