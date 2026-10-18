import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getModels } from '../db/models.js';
import { createLlmClient } from '../llm/client.js';
import type { LlmProvider, ModelTier } from '../llm/types.js';
import type { LlmUsageRecord } from '../llm/usage.js';
import { CHAT_STOPPED_MESSAGE } from '../tasks/service.js';
import { createScriptedLlm, type ScriptHandler } from '../testing/fake-llm.js';
import { startTestDatabase, type TestDatabase } from '../testing/index.js';
import { createFixtureResearchLlm } from '../testing/scenarios/executor.js';
import {
  fixtureResearchSearch,
  promptSources,
  researchResultsFor,
} from '../testing/scenarios/research-script.js';
import { seedFixtureNewsroom } from '../testing/seed.js';
import {
  CHAT_DEADLINE_MS,
  outOfScopeReply,
  readAnswerPreview,
  requestChatStop,
  runChatReply,
  streamChatReply,
  type ChatEvent,
} from './chat.js';
import { CHAT_SYSTEM_PROMPT } from './prompts.js';
import { getResearchView } from './queries.js';
import { postChatMessage, requestResearch, runResearch } from './service.js';

/**
 * The research chat (ADR-035/036) with a scripted, streamed model: one call per question, the
 * scope decided in that call, every statement's quote checked, and every way a reply can end
 * (saved, redirected, stopped, failed, timed out) leaving the story unlocked and nothing partial
 * saved. Scripted answers prove the plumbing, not how a real model answers (see chat.live.test).
 */
let db: TestDatabase;
let storyId: string;
let headline: string;

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
  headline = story.headline;
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
  vi.restoreAllMocks();
});

/** The first line of the first source in the prompt: present word for word in its stored text. */
const firstSource = (prompt: string) => {
  const source = promptSources(prompt)[0]!;
  return { label: source.label, quote: source.line.slice(0, 80) };
};

function chatModel(handler: ScriptHandler, stream = { chunkChars: 16, chunkDelayMs: 0 }) {
  const usage: LlmUsageRecord[] = [];
  const scripted = createScriptedLlm(
    { chat: handler },
    {
      stream,
      recordUsage: (record) => {
        usage.push(record);
        return Promise.resolve();
      },
    },
  );
  return { ...scripted, usage };
}

async function ask(content: string, llm: ReturnType<typeof chatModel>['llm'], receivedAt?: number) {
  const { taskKey } = await postChatMessage({ storyId, userId: 'editor-1', content });
  const events: ChatEvent[] = [];
  let error: unknown = null;
  try {
    await streamChatReply({
      taskKey,
      deps: { llm, now: () => new Date() },
      onEvent: (event) => events.push(event),
      receivedAt,
    });
  } catch (e) {
    error = e;
  }
  const { Task, ChatMessage } = await getModels();
  const task = (await Task.findOne({ key: taskKey }).lean())!;
  const reply = await ChatMessage.findOne({ taskId: taskKey }).lean();
  return { taskKey, events, error, task, reply };
}

/** An answer in the chat's structured form, its keys in the schema's order (as the model writes it). */
const answer = (fields: Record<string, unknown>) => ({
  assessment: 'sufficient',
  scope: 'about_story',
  statements: [],
  evidence: 'sufficient',
  researchQuestion: '',
  researchDepth: 'focused',
  ...fields,
});

describe('one call per question, with the scope decided in that call', () => {
  it('1. answers whether the story suits Omenai’s focus instead of refusing it', async () => {
    const model = chatModel(() =>
      answer({
        scope: 'editorial',
        statements: [
          {
            type: 'analysis',
            text: 'Partly: it is an institutional story more than a contemporary-art one.',
            sources: [],
            excerpt: '',
          },
        ],
        evidence: 'partial',
      }),
    );
    const { reply, task } = await ask(
      'Does this story suit Omenai’s focus on contemporary art?',
      model.llm,
    );
    expect(model.calls.map((c) => c.operation)).toEqual(['chat']);
    expect(reply).toMatchObject({
      scope: 'editorial',
      content: 'Partly: it is an institutional story more than a contemporary-art one.',
    });
    expect(reply?.content).not.toBe(outOfScopeReply(headline));
    expect(task).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(task.activeLock).toBeUndefined();
    // The prompt itself no longer restricts the conversation to the exact story.
    expect(CHAT_SYSTEM_PROMPT).toMatch(/editorial: how the story fits Omenai/);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/Going beyond the exact story is never by itself a reason/);
    expect(CHAT_SYSTEM_PROMPT).not.toMatch(/Do not answer general questions or drift/);
  });

  it('2. answers a direct follow-up with each quote checked on its own statement', async () => {
    const model = chatModel((prompt) => {
      const source = firstSource(prompt);
      return answer({
        scope: 'about_story',
        statements: [
          {
            type: 'fact',
            text: 'Zeitz MOCAA’s Kwame Asante retrospective is drawing crowds in Cape Town.',
            sources: [source.label],
            excerpt: source.quote,
          },
          { type: 'analysis', text: 'That interest matters for us.', sources: [], excerpt: '' },
        ],
      });
    });
    const { reply } = await ask('Is the retrospective drawing visitors?', model.llm);
    expect(reply?.claims?.map((c) => [c.type, c.citationStatus])).toEqual([
      ['fact', 'verified'],
      ['analysis', 'uncited'],
    ]);
    const view = await getResearchView(storyId);
    const message = view.messages.at(-1)!;
    expect(message.claims?.[0]?.sourceLabels).toHaveLength(1);
    // Every cited source resolves to a stored source record.
    const ids = message.claims!.flatMap((c) => c.sourceLabels);
    expect(ids.length).toBeGreaterThan(0);
    expect(Object.keys(view.sources).length).toBeGreaterThan(0);
  });

  it('3. takes a wider art-and-culture question, and researches it when the saved research is thin', async () => {
    const model = chatModel(() =>
      answer({
        assessment: 'needs_research',
        scope: 'related',
        statements: [
          {
            type: 'analysis',
            text: 'It belongs to a wider argument about who keeps African art, which this research only touches.',
            sources: [],
            excerpt: '',
          },
        ],
        evidence: 'partial',
        researchQuestion: 'How have European museums responded to restitution claims since 2020?',
      }),
    );
    const { reply, events } = await ask(
      'How does this connect to restitution debates in Europe?',
      model.llm,
    );
    expect(reply).toMatchObject({ scope: 'related', evidence: 'partial' });
    expect(reply?.suggestedFocus).toMatch(/European museums/);
    expect(events.map((e) => e.type)).toContain('research');
  });

  it('4. redirects an unrelated question in the server’s words, without showing the model’s text', async () => {
    const model = chatModel(() =>
      answer({
        assessment: 'out_of_scope',
        statements: [
          {
            type: 'analysis',
            text: 'Here is a long answer about renaming files that must never be shown. '.repeat(
              10,
            ),
            sources: [],
            excerpt: '',
          },
        ],
        evidence: 'insufficient',
      }),
    );
    const { reply, events, task } = await ask(
      'Write me a Python script to rename files.',
      model.llm,
    );
    expect(reply).toMatchObject({ scope: 'unrelated', content: outOfScopeReply(headline) });
    expect(events.filter((e) => e.type === 'text')).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    // The model was stopped as soon as its scope was known, and that call still counts.
    expect(model.usage).toEqual([
      expect.objectContaining({ operation: 'chat.reply', errorKind: 'aborted' }),
    ]);
    expect(task.activeLock).toBeUndefined();
  });

  it('5. flags a date its quote can’t back; the prompt forbids substituting a related fact', async () => {
    const model = chatModel((prompt) => {
      const source = firstSource(prompt);
      return answer({
        scope: 'about_story',
        statements: [
          // A guessed year, quoting a passage that doesn't contain it.
          {
            type: 'fact',
            text: 'The director was appointed in 2003.',
            sources: [source.label],
            excerpt: source.quote,
          },
        ],
      });
    });
    const { reply } = await ask('When was the director appointed?', model.llm);
    expect(reply?.claims?.[0]?.citationStatus).toBe('detail_not_in_excerpt');
    expect(CHAT_SYSTEM_PROMPT).toMatch(/Never substitute a related fact for the one requested/);
    expect(CHAT_SYSTEM_PROMPT).toMatch(
      /an earlier role is not the date of a specific appointment or title; an announcement is not an opening; a nomination is not a win/,
    );
  });

  it('6. records thin evidence honestly and starts research on it, once', async () => {
    const model = chatModel(() =>
      answer({
        assessment: 'needs_research',
        statements: [
          {
            type: 'open_question',
            text: 'None of the sources gives a visitor figure.',
            sources: [],
            excerpt: '',
          },
        ],
        evidence: 'insufficient',
        researchQuestion: 'What visitor figures has the museum published?',
      }),
    );
    const { reply } = await ask('How many visitors came?', model.llm);
    expect(reply).toMatchObject({
      evidence: 'insufficient',
      followUp: { status: 'started', question: 'What visitor figures has the museum published?' },
    });
    // Already under way for this reply: asking for it by hand doesn't start it again.
    await expect(
      requestResearch({
        storyId,
        userId: 'editor-1',
        depth: 'standard',
        fromMessageId: String(reply!._id),
      }),
    ).rejects.toMatchObject({ code: 'ALREADY_RESEARCHED' });
  });

  it('7. drops statements with unknown or no sources and keeps labels out of the text', async () => {
    const model = chatModel((prompt) => {
      const source = firstSource(prompt);
      return answer({
        scope: 'about_story',
        statements: [
          {
            type: 'fact',
            text: 'It opened [S1] this week.',
            sources: [source.label],
            excerpt: source.quote,
          },
          { type: 'fact', text: 'A sequel is planned.', sources: ['S9'], excerpt: 'a sequel' },
          { type: 'fact', text: 'It was free to enter.', sources: [], excerpt: '' },
        ],
      });
    });
    const { reply } = await ask('Tell me about the opening.', model.llm);
    expect(reply).toMatchObject({ content: 'It opened this week.', droppedClaims: 2 });
    expect(reply?.content).not.toMatch(/\[S\d+\]/);
  });

  it('8. stores an ordinary answer as its statements, nothing added around them', async () => {
    const model = chatModel(() =>
      answer({
        scope: 'about_story',
        statements: [
          { type: 'analysis', text: 'Short answer first.', sources: [], excerpt: '' },
          { type: 'analysis', text: 'Then one helpful sentence.', sources: [], excerpt: '' },
        ],
      }),
    );
    const { reply } = await ask('Is this worth a feature?', model.llm);
    expect(reply?.content).toBe('Short answer first. Then one helpful sentence.');
    expect(CHAT_SYSTEM_PROMPT).toMatch(/Never add briefing sections or headings/);
  });
});

describe('streaming and every way a reply can end', () => {
  const plain = () =>
    answer({
      scope: 'about_story',
      statements: [
        {
          type: 'analysis',
          text: 'The first statement arrives in pieces.',
          sources: [],
          excerpt: '',
        },
        { type: 'analysis', text: 'So does the second one.', sources: [], excerpt: '' },
      ],
    });

  it('passes the text on as it arrives, before checking and saving', async () => {
    const model = chatModel(plain, { chunkChars: 8, chunkDelayMs: 15 });
    const { events, reply, task } = await ask('Tell me more.', model.llm);
    const types = events.map((e) => e.type);
    expect(types.slice(0, 2)).toEqual(['started', 'context']);
    // What the answer is written from, said before any of it arrives.
    const context = events[1] as Extract<ChatEvent, { type: 'context' }>;
    expect(context.briefs).toBe(1);
    expect(context.sources).toBeGreaterThan(0);
    expect(types.slice(-2)).toEqual(['checking', 'done']);
    // The same steps are on the task record, with the reply saved.
    expect(task.progress?.steps?.map((s) => s.step)).toEqual(['read', 'compose', 'write', 'check']);
    expect(task.progress?.steps?.[0]?.counts).toEqual({
      briefs: 1,
      sources: context.sources,
    });
    const texts = events.flatMap((e) => (e.type === 'text' ? [e.text] : []));
    expect(texts.length).toBeGreaterThanOrEqual(3);
    // Each update extends the last, and the last is what was saved.
    texts.slice(1).forEach((text, i) => expect(text.startsWith(texts[i]!.slice(0, -1))).toBe(true));
    expect(texts.at(-1)).toBe(reply?.content);
    expect(model.usage[0]).toMatchObject({
      outcome: 'ok',
      firstChunkMs: expect.any(Number) as number,
    });
  });

  it('shows a page opened mid-reply where the reply has got to, from the task record', async () => {
    const model = chatModel(plain, { chunkChars: 4, chunkDelayMs: 40 });
    const { taskKey } = await postChatMessage({ storyId, userId: 'editor-1', content: 'More?' });
    let firstText!: () => void;
    const writing = new Promise<void>((resolve) => (firstText = resolve));
    const reply = streamChatReply({
      taskKey,
      deps: { llm: model.llm, now: () => new Date() },
      onEvent: (event) => {
        if (event.type === 'text') firstText();
      },
    });
    await writing;
    // A refresh reads the view, not the stream: the step on record is the one under way.
    let active = (await getResearchView(storyId)).activeTask;
    for (let i = 0; i < 50 && active?.step !== 'write'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      active = (await getResearchView(storyId)).activeTask;
    }
    expect(active).toMatchObject({ kind: 'chat', status: 'running', step: 'write' });
    expect(active?.steps.map((s) => s.step)).toEqual(['read', 'compose', 'write']);
    expect(active?.stepStartedAt).toEqual(expect.any(String));
    await reply;
    expect((await getResearchView(storyId)).activeTask).toBeNull();
  });

  it('fails cleanly when the provider is down, keeping the question and saving nothing', async () => {
    const model = chatModel(plain);
    model.failNextWithOutage('chat');
    const { events, task, reply } = await ask('Tell me more.', model.llm);
    expect(events.at(-1)).toMatchObject({ type: 'failed', code: 'unavailable' });
    expect(reply).toBeNull();
    expect(task).toMatchObject({ status: 'failed' });
    expect(task.activeLock).toBeUndefined();
    const view = await getResearchView(storyId);
    expect(view.messages.at(-1)).toMatchObject({ role: 'user', content: 'Tell me more.' });
    expect(view.lastFailure).toMatchObject({ kind: 'chat' });
    expect(view.activeTask).toBeNull();
  });

  it('saves nothing partial when the stream breaks off midway', async () => {
    const model = chatModel(plain, { chunkChars: 8, chunkDelayMs: 0 });
    model.failNextStreamMidway('chat');
    const { events, task, reply } = await ask('Tell me more.', model.llm);
    expect(events.some((e) => e.type === 'text')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'failed', code: 'unavailable' });
    expect(reply).toBeNull();
    expect(task.status).toBe('failed');
    expect(task.activeLock).toBeUndefined();
  });

  it('stops within about a second of Stop, saves nothing, and says so after a refresh', async () => {
    const model = chatModel(plain, { chunkChars: 2, chunkDelayMs: 60 });
    const { taskKey } = await postChatMessage({
      storyId,
      userId: 'editor-1',
      content: 'Tell me more.',
    });
    const events: Array<ChatEvent & { at: number }> = [];
    let stoppedAt = 0;
    const running = streamChatReply({
      taskKey,
      deps: { llm: model.llm, now: () => new Date() },
      onEvent: (event) => {
        events.push({ ...event, at: Date.now() });
        if (event.type === 'text' && !stoppedAt) {
          stoppedAt = Date.now();
          void requestChatStop({ storyId, taskKey });
        }
      },
    });
    await expect(running).rejects.toThrow(/stopped/i);
    const last = events.at(-1)!;
    expect(last).toMatchObject({ type: 'failed', code: 'stopped' });
    // Handled by the process running the reply: at once.
    expect(last.at - stoppedAt).toBeLessThan(500);
    const { Task, ChatMessage } = await getModels();
    expect(await ChatMessage.countDocuments({ taskId: taskKey })).toBe(0);
    const task = (await Task.findOne({ key: taskKey }).lean())!;
    expect(task).toMatchObject({ status: 'failed', lastError: CHAT_STOPPED_MESSAGE });
    expect(task.activeLock).toBeUndefined();
    expect((await getResearchView(storyId)).lastFailure).toMatchObject({
      kind: 'chat',
      lastError: CHAT_STOPPED_MESSAGE,
    });
  });

  it('also stops when another server instance received the Stop (the flag on the task)', async () => {
    const model = chatModel(plain, { chunkChars: 2, chunkDelayMs: 60 });
    const { taskKey } = await postChatMessage({
      storyId,
      userId: 'editor-1',
      content: 'Tell me more.',
    });
    const { Task } = await getModels();
    let flaggedAt = 0;
    let failedAt = 0;
    await streamChatReply({
      taskKey,
      deps: { llm: model.llm, now: () => new Date() },
      onEvent: (event) => {
        if (event.type === 'text' && !flaggedAt) {
          flaggedAt = Date.now();
          // Set directly, as an instance not running this reply would.
          void Task.updateOne({ key: taskKey }, { $set: { cancelRequested: true } }).exec();
        }
        if (event.type === 'failed') failedAt = Date.now();
      },
    }).catch(() => undefined);
    expect(failedAt).toBeGreaterThan(0);
    expect(failedAt - flaggedAt).toBeLessThan(1_500);
    expect((await Task.findOne({ key: taskKey }).lean())?.lastError).toBe(CHAT_STOPPED_MESSAGE);
  });

  it('keeps going and saves the reply when nobody is listening any more', async () => {
    const model = chatModel(plain, { chunkChars: 8, chunkDelayMs: 0 });
    const { taskKey } = await postChatMessage({
      storyId,
      userId: 'editor-1',
      content: 'Tell me more.',
    });
    await streamChatReply({
      taskKey,
      deps: { llm: model.llm, now: () => new Date() },
      onEvent: (event) => {
        // A closed connection: every write after the first piece of text throws.
        if (event.type === 'text') throw new Error('The connection was closed.');
      },
    });
    const { Task, ChatMessage } = await getModels();
    expect(await ChatMessage.countDocuments({ taskId: taskKey })).toBe(1);
    expect((await Task.findOne({ key: taskKey }).lean())?.status).toBe('succeeded');
  });

  it('never writes a reply twice', async () => {
    const model = chatModel(plain);
    const { taskKey } = await postChatMessage({
      storyId,
      userId: 'editor-1',
      content: 'Tell me more.',
    });
    const first = await runChatReply({ taskKey, deps: { llm: model.llm, now: () => new Date() } });
    const again = await runChatReply({ taskKey, deps: { llm: model.llm, now: () => new Date() } });
    expect(again.messageId).toBe(first.messageId);
    const { ChatMessage } = await getModels();
    expect(await ChatMessage.countDocuments({ taskId: taskKey })).toBe(1);
    expect(model.calls).toHaveLength(1);
  });

  it('reports a database failure on save as a failure and releases the story', async () => {
    const model = chatModel(plain);
    const { ChatMessage } = await getModels();
    const create = ChatMessage.create.bind(ChatMessage);
    vi.spyOn(ChatMessage, 'create').mockImplementation(((doc: { role?: string }) =>
      doc.role === 'assistant'
        ? Promise.reject(new Error('database unavailable'))
        : create(doc as never)) as never);
    const { events, task } = await ask('Tell me more.', model.llm);
    expect(events.at(-1)).toMatchObject({ type: 'failed', code: 'error' });
    expect(task.status).toBe('failed');
    expect(task.activeLock).toBeUndefined();
  });

  it('ends at its deadline even when the provider ignores cancellation and never answers', async () => {
    const hanging: LlmProvider = {
      name: 'gemini',
      generate: () => new Promise(() => undefined),
      // eslint-disable-next-line require-yield
      async *stream() {
        await new Promise(() => undefined);
        throw new Error('unreachable');
      },
    };
    const usage: LlmUsageRecord[] = [];
    const llm = createLlmClient({
      provider: hanging,
      models: { triage: 'm', primary: 'm', escalation: 'm' } satisfies Record<ModelTier, string>,
      recordUsage: (record) => {
        usage.push(record);
        return Promise.resolve();
      },
    });
    // As if the request had arrived 55.4 s ago: the model has about 0.6 s left of its share.
    const receivedAt = Date.now() - (CHAT_DEADLINE_MS - 5_000 - 600);
    const started = Date.now();
    const { events, task } = await ask('Tell me more.', llm, receivedAt);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(events.at(-1)).toMatchObject({ type: 'failed', code: 'timeout' });
    expect(usage).toEqual([expect.objectContaining({ errorKind: 'timeout' })]);
    expect(task.status).toBe('failed');
    expect(task.activeLock).toBeUndefined();
  });

  it('treats a reply quiet for 2 minutes as stopped, and lets the next question take over', async () => {
    const { Task } = await getModels();
    const { taskKey } = await postChatMessage({ storyId, userId: 'editor-1', content: 'Hello?' });
    await Task.collection.updateOne(
      { key: taskKey },
      { $set: { status: 'running', updatedAt: new Date(Date.now() - 90_000) } },
    );
    // Within the window it is still writing.
    expect((await getResearchView(storyId)).activeTask?.key).toBe(taskKey);
    await Task.collection.updateOne(
      { key: taskKey },
      { $set: { updatedAt: new Date(Date.now() - 3 * 60_000) } },
    );
    const view = await getResearchView(storyId);
    expect(view.activeTask).toBeNull();
    expect(view.lastFailure).toMatchObject({ key: taskKey, kind: 'chat' });
    // The next question takes over the abandoned lock instead of waiting 45 minutes.
    await expect(
      postChatMessage({ storyId, userId: 'editor-1', content: 'Hello again?' }),
    ).resolves.toHaveProperty('taskKey');
    expect((await Task.findOne({ key: taskKey }).lean())?.lastError).toMatch(/2 minutes/);
  });
});

describe('reading an answer while it streams', () => {
  it('shows statement text as it arrives, and the assessment only once it is complete', () => {
    expect(readAnswerPreview('{"assessment":"out_of_sc')).toEqual({ assessment: null, text: '' });
    expect(readAnswerPreview('{"assessment":"out_of_scope"')).toEqual({
      assessment: 'out_of_scope',
      text: '',
    });
    expect(
      readAnswerPreview(
        '{"assessment":"sufficient","scope":"about_story","statements":[{"type":"fact","text":"It opened [S1] on Monday.","sources":["S1"]},{"type":"analysis","text":"That ma',
      ),
    ).toEqual({ assessment: 'sufficient', text: 'It opened on Monday. That ma' });
  });
});
