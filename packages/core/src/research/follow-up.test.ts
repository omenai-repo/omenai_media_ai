import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getModels } from '../db/models.js';
import { UsageLimitError } from '../ops/budget.js';
import { SearchError, type SearchClient } from '../search/types.js';
import { createFakeSearch, type FixtureArticle } from '../testing/discovery-fixtures.js';
import { createScriptedLlm, type ScriptHandler } from '../testing/fake-llm.js';
import { startTestDatabase, type TestDatabase } from '../testing/index.js';
import { createFixtureResearchLlm } from '../testing/scenarios/executor.js';
import {
  fixtureResearchSearch,
  promptFollowUps,
  promptSources,
  researchResultsFor,
} from '../testing/scenarios/research-script.js';
import { seedFixtureNewsroom } from '../testing/seed.js';
import { streamChatReply, type ChatEvent } from './chat.js';
import { planFollowUp, sameQuestion } from './follow-up.js';
import { getResearchView } from './queries.js';
import { postChatMessage, requestResearch, runResearch, startFollowUpResearch } from './service.js';

/**
 * Research trail reuse and automatic evidence-gap research (ADR-038), with a scripted model and a
 * fake search that counts its calls: the saved research answers what it can without any research;
 * a question it can't settle starts bounded, focused research once, whose findings are saved and
 * answer the same question next time; and a failure is never read as missing evidence. Scripted
 * answers prove the plumbing, not how a real model judges evidence (see chat.live.test).
 */
let db: TestDatabase;
let storyId: string;

const QUESTION = 'When was Thandi Nkosi appointed chief curator at Zeitz MOCAA?';
const RESEARCH_QUESTION = 'When was Thandi Nkosi appointed chief curator of Zeitz MOCAA?';
const FACT_QUOTE = 'Zeitz MOCAA appointed Thandi Nkosi as its chief curator in March 2024';
/** A page the follow-up's search finds: it establishes the exact fact asked. */
const appointment: FixtureArticle = {
  url: 'https://museum-news.example/zeitz-mocaa-chief-curator',
  title: 'Zeitz MOCAA names Thandi Nkosi chief curator',
  snippet: 'Zeitz MOCAA names Thandi Nkosi chief curator.',
  publishedDate: 'Tue, 12 Mar 2024 08:00:00 GMT',
  score: 0.9,
  content: `${FACT_QUOTE}, the museum said on Tuesday. (Development fixture text.)`,
  images: [],
};

beforeAll(async () => {
  db = await startTestDatabase();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  await seedFixtureNewsroom();
  const { Story } = await getModels();
  const story = (await Story.findOne({ headline: /Zeitz MOCAA opens/ }).lean())!;
  storyId = String(story._id);
  // The story's saved research: one brief from fixtures, which doesn't mention the appointment.
  const { taskKey } = await requestResearch({ storyId, userId: 'editor-1', depth: 'standard' });
  await runResearch({
    taskKey,
    deps: {
      llm: createFixtureResearchLlm(),
      search: fixtureResearchSearch(researchResultsFor(story)),
      now: () => new Date(),
    },
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const question = (prompt: string) => /^QUESTION: (.*)$/m.exec(prompt)?.[1] ?? '';

/** The chat's structured answer, its keys in the schema's order. */
const answer = (fields: Record<string, unknown>) => ({
  assessment: 'sufficient',
  scope: 'about_story',
  statements: [],
  evidence: 'sufficient',
  researchQuestion: '',
  researchDepth: 'focused',
  ...fields,
});

/**
 * A model standing in for a careful one: it answers from a saved follow-up when one researched
 * the question; otherwise it says the saved research doesn't establish the appointment date.
 */
const chat: ScriptHandler = (prompt) => {
  const earlier = promptFollowUps(prompt).find((f) => sameQuestion(f.question, question(prompt)));
  if (earlier?.found)
    return answer({
      statements: [
        {
          type: 'fact',
          text: 'Thandi Nkosi was appointed chief curator in March 2024.',
          sources: [earlier.found.label],
          excerpt: earlier.found.quote,
        },
      ],
    });
  if (/appointed/i.test(question(prompt)))
    return answer({
      assessment: 'needs_research',
      statements: [
        {
          type: 'open_question',
          text: 'The saved research doesn’t say when she was appointed.',
          sources: [],
          excerpt: '',
        },
      ],
      evidence: 'insufficient',
      researchQuestion: RESEARCH_QUESTION,
    });
  const first = promptSources(prompt)[0]!;
  return answer({
    statements: [
      {
        type: 'fact',
        text: 'The Kwame Asante retrospective at Zeitz MOCAA is drawing crowds.',
        sources: [first.label],
        excerpt: first.line.slice(0, 60),
      },
    ],
  });
};

/** The focused research's answer: cites the page that establishes the date, word for word. */
const focused: ScriptHandler = (prompt) => {
  const page = promptSources(prompt).find((s) => s.headline.startsWith('Zeitz MOCAA names'));
  return page
    ? {
        answer: [
          {
            type: 'fact',
            text: 'Zeitz MOCAA appointed Thandi Nkosi chief curator in March 2024.',
            sources: [page.label],
            excerpt: FACT_QUOTE,
          },
          // An unknown label: removed by the checks, never shown as a citation.
          { type: 'fact', text: 'She trained in Berlin.', sources: ['S99'], excerpt: 'Berlin' },
        ],
        evidence: 'sufficient',
        toConfirm: [],
        nextSteps: [],
      }
    : {
        answer: [
          { type: 'open_question', text: 'The sources don’t say.', sources: [], excerpt: '' },
        ],
        evidence: 'insufficient',
        toConfirm: [],
        nextSteps: [],
      };
};

function harness(options: { searchResults?: FixtureArticle[]; search?: SearchClient } = {}) {
  const model = createScriptedLlm({ chat, focused });
  const fake = createFakeSearch(options.searchResults ?? [appointment]);
  const search = options.search ?? fake.client;
  async function ask(content: string) {
    const { taskKey } = await postChatMessage({ storyId, userId: 'editor-1', content });
    const events: ChatEvent[] = [];
    const result = await streamChatReply({
      taskKey,
      deps: { llm: model.llm, now: () => new Date() },
      onEvent: (event) => events.push(event),
    });
    const { ChatMessage } = await getModels();
    const reply = (await ChatMessage.findById(result.messageId).lean())!;
    return { ...result, events, reply };
  }
  /** Runs a follow-up as the worker would. */
  const research = (taskKey: string) =>
    runResearch({ taskKey, deps: { llm: model.llm, search, now: () => new Date() } });
  return { model, fake, ask, research };
}

const researchTasks = async () => {
  const { Task } = await getModels();
  return Task.countDocuments({ kind: 'research', requestKind: { $ne: 'manual' } });
};

describe('answers from the saved research first', () => {
  it('1. answers from saved evidence without research, search or another model call', async () => {
    const h = harness();
    const before = await researchTasks();
    const { reply, events, followUp } = await h.ask('What opened this week?');
    expect(reply).toMatchObject({ assessment: 'sufficient', evidence: 'sufficient' });
    expect(reply.claims?.[0]?.citationStatus).toBe('verified');
    expect(followUp).toBeNull();
    expect(events.map((e) => e.type)).not.toContain('research');
    expect(await researchTasks()).toBe(before);
    expect(h.fake.calls).toMatchObject({ search: 0, extract: 0 });
    expect(h.model.calls.map((c) => c.operation)).toEqual(['chat']);
  });

  it('6. redirects an out-of-scope question without research', async () => {
    const model = createScriptedLlm({
      chat: () =>
        answer({
          assessment: 'out_of_scope',
          statements: [{ type: 'analysis', text: 'No.', sources: [], excerpt: '' }],
          evidence: 'insufficient',
          researchQuestion: 'How do I rename files?',
        }),
    });
    const { taskKey } = await postChatMessage({
      storyId,
      userId: 'editor-1',
      content: 'Write me a script to rename files.',
    });
    const result = await streamChatReply({
      taskKey,
      deps: { llm: model.llm, now: () => new Date() },
    });
    const { ChatMessage } = await getModels();
    expect(await ChatMessage.findById(result.messageId).lean()).toMatchObject({
      scope: 'unrelated',
      assessment: 'out_of_scope',
    });
    expect(result.followUp).toBeNull();
    expect(await researchTasks()).toBe(0);
  });
});

describe('researching what the saved research doesn’t establish', () => {
  it('2–5. starts focused research once, saves what it finds, and answers the same question from it next time', async () => {
    const h = harness();
    // 2. The saved research doesn't establish the date: research starts on its own.
    const first = await h.ask(QUESTION);
    expect(first.reply).toMatchObject({
      assessment: 'needs_research',
      followUp: { status: 'started', question: RESEARCH_QUESTION },
    });
    const types = first.events.map((e) => e.type);
    expect(types.slice(-2)).toEqual(['research', 'done']);
    expect(first.followUp?.taskKey).toBe(`research:standard:${storyId}:${String(first.reply._id)}`);
    const { Task, ResearchBrief, SourceArticle } = await getModels();
    expect(await Task.findOne({ key: first.followUp!.taskKey }).lean()).toMatchObject({
      kind: 'research',
      status: 'queued',
      requestKind: 'followup',
      focus: RESEARCH_QUESTION,
      fromMessageId: first.reply._id,
      requestedBy: 'editor-1',
    });
    expect(h.model.calls.map((c) => c.operation)).toEqual(['chat']);

    // 4. The worker runs it through the existing focused path: sources and findings are saved.
    await h.research(first.followUp!.taskKey);
    const brief = (await ResearchBrief.findOne({ taskId: first.followUp!.taskKey }).lean())!;
    expect(brief).toMatchObject({ requestKind: 'followup', focus: RESEARCH_QUESTION });
    expect(String(brief.fromMessageId)).toBe(String(first.reply._id));
    const found = brief.sections.find((s) => s.kind === 'answer')!.claims;
    expect(found.map((c) => [c.type, c.citationStatus])).toEqual([['fact', 'verified']]);
    expect(brief.droppedClaims).toHaveLength(1);
    expect(await SourceArticle.exists({ url: appointment.url, origin: 'research' })).not.toBeNull();
    expect(h.fake.calls.search).toBeGreaterThan(0);

    // 5. Asking again: answered from the saved follow-up, with no new research or search.
    const searches = h.fake.calls.search;
    const second = await h.ask(QUESTION);
    expect(second.reply.assessment).toBe('sufficient');
    expect(second.reply.followUp).toBeUndefined();
    expect(second.reply.claims?.[0]).toMatchObject({
      text: 'Thandi Nkosi was appointed chief curator in March 2024.',
      citationStatus: 'verified',
    });
    expect(second.followUp).toBeNull();
    expect(h.fake.calls.search).toBe(searches);
    expect(await Task.countDocuments({ kind: 'research', requestKind: 'followup' })).toBe(1);
    // The new source is in the reply's own sources (labelled first, never crowded out).
    const prompt = h.model.calls.at(-1)!.prompt;
    expect(prompt).toContain(`follow-up question: ${RESEARCH_QUESTION}`);
    expect(prompt).toContain(`Quote: "${FACT_QUOTE}"`);
    expect(promptSources(prompt).map((s) => s.headline)).toContain(appointment.title);
  });

  it('3. treats related facts as related, not as the answer, and says how each point was checked', async () => {
    const h = harness();
    await h.ask(QUESTION);
    const prompt = h.model.calls[0]!.prompt;
    // The saved points reach the model with how they were checked: found quotes are passed on,
    // and anything unconfirmed is marked so, never as a plain fact.
    expect(prompt).toMatch(/^- \((fact|attributed), quote found\) .+ Quote: "/m);
    expect(prompt).toMatch(/^BRIEF \d{4}-\d{2}-\d{2}:/m);
    expect(prompt).not.toMatch(/^- \((fact|attributed)\) /m);
    // The rules that keep a related fact from passing for the answer.
    const { CHAT_SYSTEM_PROMPT } = await import('./prompts.js');
    expect(CHAT_SYSTEM_PROMPT).toMatch(/Related information is not enough/);
    expect(CHAT_SYSTEM_PROMPT).toMatch(
      /an earlier role is not the date of a specific appointment or title; an announcement is not an opening; a nomination is not a win/,
    );
    expect(CHAT_SYSTEM_PROMPT).toMatch(
      /"unconfirmed" or "sources disagree" is not established: never state it as fact/,
    );
  });

  it('asks for research only with a usable question and evidence not judged sufficient', () => {
    const plan = (fields: Partial<Parameters<typeof planFollowUp>[0]['answer']>) =>
      planFollowUp({
        answer: {
          assessment: 'needs_research',
          evidence: 'insufficient',
          researchQuestion: RESEARCH_QUESTION,
          researchDepth: 'focused',
          ...fields,
        },
        briefs: [],
        now: new Date(),
      });
    expect(plan({})).toEqual({
      kind: 'research',
      plan: { question: RESEARCH_QUESTION, depth: 'standard' },
    });
    expect(plan({ researchDepth: 'broad' })).toMatchObject({ plan: { depth: 'in_depth' } });
    expect(plan({ assessment: 'sufficient' })).toBeNull();
    // A contradiction (research asked for, evidence called sufficient) spends nothing.
    expect(plan({ evidence: 'sufficient' })).toBeNull();
    expect(plan({ researchQuestion: '  ' })).toBeNull();
  });

  it('never repeats recent research on the same question, even if asked to', () => {
    const now = new Date('2026-10-17T12:00:00Z');
    const decision = (focus: string, ageDays: number) =>
      planFollowUp({
        answer: {
          assessment: 'needs_research',
          evidence: 'insufficient',
          researchQuestion: RESEARCH_QUESTION,
          researchDepth: 'focused',
        },
        briefs: [{ focus, createdAt: new Date(now.getTime() - ageDays * 86_400_000) }],
        now,
      });
    expect(decision(QUESTION, 1)).toEqual({
      kind: 'already_researched',
      question: RESEARCH_QUESTION,
    });
    expect(decision(QUESTION, 8)?.kind).toBe('research');
    expect(
      sameQuestion(
        'How many visitors came in the first month?',
        'Visitors in the first month: how many?',
      ),
    ).toBe(true);
    expect(
      sameQuestion(
        'How many visitors did the wing get in its first month?',
        'How many visitors did the wing get in its first year?',
      ),
    ).toBe(false);
  });
});

describe('failures are failures, never missing evidence', () => {
  it('7a. a model outage ends the reply as a failure, with no research', async () => {
    const h = harness();
    h.model.failNextWithOutage('chat');
    await expect(h.ask(QUESTION)).rejects.toBeTruthy();
    expect(await researchTasks()).toBe(0);
  });

  it('7b. a database failure while reading the research ends the reply as a failure, with no research', async () => {
    const h = harness();
    const { SourceArticle } = await getModels();
    vi.spyOn(SourceArticle, 'find').mockImplementationOnce(() => {
      throw new Error('database unreachable');
    });
    const { taskKey } = await postChatMessage({ storyId, userId: 'editor-1', content: QUESTION });
    const events: ChatEvent[] = [];
    await expect(
      streamChatReply({
        taskKey,
        deps: { llm: h.model.llm, now: () => new Date() },
        onEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow('database unreachable');
    expect(events.at(-1)).toMatchObject({ type: 'failed', code: 'error' });
    expect(await researchTasks()).toBe(0);
    expect(h.model.calls).toHaveLength(0);
  });

  it('7c. a usage limit hit while searching stops the research instead of answering without it', async () => {
    const limited: SearchClient = {
      search: () => Promise.reject(new UsageLimitError('The usage limit of 20 search credits…')),
      extract: () => Promise.reject(new Error('not reached')),
    };
    const h = harness({ search: limited });
    const { followUp } = await h.ask(QUESTION);
    await expect(h.research(followUp!.taskKey)).rejects.toBeInstanceOf(UsageLimitError);
    const { ResearchBrief } = await getModels();
    expect(await ResearchBrief.exists({ taskId: followUp!.taskKey })).toBeNull();
  });

  it('7d. a follow-up whose every search failed fails (to be retried), rather than saying “not established”', async () => {
    const down: SearchClient = {
      search: () => Promise.reject(new SearchError('unavailable', 'search service down')),
      extract: () => Promise.reject(new Error('not reached')),
    };
    const h = harness({ search: down });
    const { followUp } = await h.ask(QUESTION);
    const failure = await h.research(followUp!.taskKey).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: 'SearchError', retryable: true });
    const { ResearchBrief } = await getModels();
    expect(await ResearchBrief.exists({ taskId: followUp!.taskKey })).toBeNull();
  });

  it('records searches that failed on a brief that could still be written', async () => {
    let calls = 0;
    const flaky: SearchClient = {
      search: (query, options, context) => {
        calls += 1;
        if (calls === 1) return Promise.reject(new SearchError('unavailable', 'one search failed'));
        return createFakeSearch([appointment]).client.search(query, options, context);
      },
      extract: (urls, context, options) =>
        createFakeSearch([appointment]).client.extract(urls, context, options),
    };
    const h = harness({ search: flaky });
    const { followUp } = await h.ask(QUESTION);
    await h.research(followUp!.taskKey);
    const brief = (await getResearchView(storyId)).briefs.at(-1)!;
    expect(brief).toMatchObject({ requestKind: 'followup', searchFailures: 1 });
  });
});

describe('never twice, within limits, and recoverable after a refresh', () => {
  it('8. starts research for a reply at most once, and refuses a second request for it', async () => {
    const h = harness();
    const { followUp, reply } = await h.ask(QUESTION);
    const again = await startFollowUpResearch({
      storyId: reply.storyId,
      messageId: reply._id,
      requestedBy: 'editor-1',
      plan: { question: RESEARCH_QUESTION, depth: 'standard' },
      now: new Date(),
    });
    expect(again).toEqual({ taskKey: followUp!.taskKey });
    const { Task } = await getModels();
    expect(await Task.countDocuments({ fromMessageId: reply._id })).toBe(1);
    await expect(
      requestResearch({
        storyId,
        userId: 'editor-2',
        depth: 'standard',
        fromMessageId: String(reply._id),
      }),
    ).rejects.toMatchObject({ code: 'ALREADY_RESEARCHED' });
    // A second question while the research holds the story is refused, so nothing piles up.
    await expect(
      postChatMessage({ storyId, userId: 'editor-2', content: 'And who else?' }),
    ).rejects.toMatchObject({ code: 'STORY_BUSY' });
  });

  it('doesn’t start research the daily limits would stop, and says why', async () => {
    vi.stubEnv('SEARCH_DAILY_CREDIT_LIMIT', '2');
    const h = harness();
    const { followUp, reply, events } = await h.ask(QUESTION);
    expect(followUp).toBeNull();
    expect(reply.followUp).toMatchObject({ status: 'skipped', reason: 'usage_limit' });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'research_skipped', reason: 'usage_limit' }),
    );
    expect(await researchTasks()).toBe(0);
  });

  it('says so when the story is busy, and the question can be researched by hand later', async () => {
    const h = harness();
    const { ChatMessage, Task } = await getModels();
    const { taskKey } = await postChatMessage({ storyId, userId: 'editor-1', content: QUESTION });
    const result = await streamChatReply({
      taskKey,
      deps: {
        llm: {
          ...h.model.llm,
          // Someone else's research takes the story's lock the moment this reply releases it.
          streamObject: async (request) => {
            const out = await h.model.llm.streamObject(request);
            await Task.updateOne({ key: taskKey }, { $unset: { activeLock: '' } });
            await requestResearch({ storyId, userId: 'editor-2', depth: 'standard' });
            return out;
          },
        },
        now: () => new Date(),
      },
    });
    expect(result.followUp).toBeNull();
    const reply = (await ChatMessage.findById(result.messageId).lean())!;
    expect(reply.followUp).toMatchObject({ status: 'skipped', reason: 'busy' });
    expect(reply.suggestedFocus).toBe(RESEARCH_QUESTION);
  });

  it('10. shows the reply and its research in progress after a refresh, then its findings, once', async () => {
    const h = harness();
    const { followUp, reply } = await h.ask(QUESTION);
    const during = await getResearchView(storyId);
    expect(during.messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
    expect(during.messages.at(-1)).toMatchObject({
      id: String(reply._id),
      followUp: { status: 'started', taskKey: followUp!.taskKey },
    });
    expect(during.activeTask).toMatchObject({
      key: followUp!.taskKey,
      kind: 'research',
      requestKind: 'followup',
      fromMessageId: String(reply._id),
    });
    await h.research(followUp!.taskKey);
    const after = await getResearchView(storyId);
    expect(after.activeTask).toBeNull();
    expect(after.briefs.filter((b) => b.fromMessageId === String(reply._id))).toHaveLength(1);
    expect(after.messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
    // 11. Every citation the findings show resolves to a stored source.
    const brief = after.briefs.at(-1)!;
    for (const claim of brief.sections.flatMap((s) => s.claims))
      for (const label of claim.sourceLabels) {
        const id = brief.sources.find((s) => s.label === label)?.sourceId;
        expect(id && after.sources[id]).toBeTruthy();
      }
  });

  it('retries a follow-up that failed as a follow-up, keeping its question', async () => {
    const h = harness();
    const { followUp, reply } = await h.ask(QUESTION);
    const { Task } = await getModels();
    await Task.updateOne(
      { key: followUp!.taskKey },
      { $set: { status: 'failed' }, $unset: { activeLock: '' } },
    );
    const { taskKey } = await requestResearch({
      storyId,
      userId: 'editor-1',
      depth: 'standard',
      fromMessageId: String(reply._id),
    });
    expect(await Task.findOne({ key: taskKey }).lean()).toMatchObject({
      requestKind: 'followup',
      focus: RESEARCH_QUESTION,
    });
  });
});
