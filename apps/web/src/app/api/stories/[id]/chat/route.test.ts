import {
  ConfigError,
  createLlmClient,
  getModels,
  objectId,
  UnauthenticatedError,
  type LlmClient,
  type LlmProvider,
} from '@repo/core';
import { startTestDatabase, type TestDatabase } from '@repo/core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatStreamLine } from '@/components/research/chat-stream';

const requireUser = vi.fn();
const after = vi.fn();
const llmFor = vi.fn<() => LlmClient>();
const enqueueStoryTask = vi.fn<(kind: string, taskKey: string) => Promise<void>>();

vi.mock('next/server', () => ({ connection: () => Promise.resolve(), after }));
vi.mock('@/lib/session', () => ({ requireUser }));
vi.mock('@/lib/story-tasks', () => ({ enqueueStoryTask }));
vi.mock('@repo/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@repo/core')>()),
  getLlmClient: () => llmFor(),
}));

const { POST, DELETE } = await import('./route');

/** A model that streams one fixed answer in small pieces (no network). */
function streamingModel(answer: unknown, pauseMs = 0): LlmClient {
  const text = JSON.stringify(answer);
  const provider: LlmProvider = {
    name: 'gemini',
    generate: () =>
      Promise.resolve({
        text,
        model: 'test-model',
        stopReason: 'complete',
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningTokens: 0 },
      }),
    async *stream(request) {
      for (let at = 0; at < text.length; at += 10) {
        await new Promise((resolve) => setTimeout(resolve, pauseMs));
        if (request.signal?.aborted) throw new Error('aborted');
        yield text.slice(at, at + 10);
      }
      return {
        text,
        model: 'test-model',
        stopReason: 'complete',
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningTokens: 0 },
      };
    },
  };
  return createLlmClient({
    provider,
    models: { triage: 'test-model', primary: 'test-model', escalation: 'test-model' },
    recordUsage: () => Promise.resolve(),
  });
}

const editorialAnswer = {
  assessment: 'sufficient',
  scope: 'editorial',
  statements: [
    {
      type: 'analysis',
      text: 'Yes, largely: it is a current story about who shapes how this art is shown.',
      sources: [],
      excerpt: '',
    },
  ],
  evidence: 'partial',
  researchQuestion: '',
  researchDepth: 'focused',
};

/** The saved research doesn't establish the answer: research is asked for. */
const gapAnswer = {
  assessment: 'needs_research',
  scope: 'about_story',
  statements: [
    {
      type: 'open_question',
      text: 'The saved research doesn’t say when the director was appointed.',
      sources: [],
      excerpt: '',
    },
  ],
  evidence: 'insufficient',
  researchQuestion: 'When was the museum’s director appointed?',
  researchDepth: 'focused',
};

let db: TestDatabase;
beforeAll(async () => {
  db = await startTestDatabase();
});
afterAll(async () => {
  await db?.stop();
});

const storyId = objectId('6ad1f0000000000000000001');
const context = { params: Promise.resolve({ id: String(storyId) }) };
const call = (handler: typeof POST, method: string, body?: unknown) =>
  handler(
    new Request(`http://localhost/api/stories/${String(storyId)}/chat`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    context,
  );

/** The stream's lines, once it has ended. */
async function lines(response: Response): Promise<ChatStreamLine[]> {
  const text = await response.text();
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ChatStreamLine);
}

beforeEach(async () => {
  await db.reset();
  requireUser.mockReset().mockResolvedValue({ id: 'editor-1', role: 'editor' });
  after.mockReset();
  enqueueStoryTask.mockReset().mockResolvedValue(undefined);
  llmFor.mockReset().mockReturnValue(streamingModel(editorialAnswer));
  await db.db.collection('stories').insertOne({ _id: storyId, headline: 'A story' });
});

const addBrief = () =>
  db.db.collection('researchBriefs').insertOne({
    storyId,
    taskId: `research:standard:${String(storyId)}:6ad1f0000000000000000002`,
    sections: [],
    sources: [],
    createdAt: new Date(),
  });

describe('POST /api/stories/[id]/chat', () => {
  it('checks the session and permission on the server, and saves nothing when refused', async () => {
    requireUser.mockRejectedValue(new UnauthenticatedError());
    expect((await call(POST, 'POST', { message: 'Hello?' })).status).toBe(401);
    expect((await call(DELETE, 'DELETE', { taskKey: 'x' })).status).toBe(401);
    const { Task, ChatMessage } = await getModels();
    expect(await Task.countDocuments()).toBe(0);
    expect(await ChatMessage.countDocuments()).toBe(0);
  });

  it('refuses an empty question, a story without research and missing AI configuration as JSON, before saving anything', async () => {
    expect((await call(POST, 'POST', { message: '   ' })).status).toBe(400);

    const noBrief = await call(POST, 'POST', { message: 'Hello?' });
    expect(noBrief.status).toBe(409);
    expect(((await noBrief.json()) as { error: { code: string } }).error.code).toBe('NO_BRIEF');

    await addBrief();
    llmFor.mockImplementation(() => {
      throw new ConfigError('GEMINI_API_KEY');
    });
    const unconfigured = await call(POST, 'POST', { message: 'Hello?' });
    expect(unconfigured.status).toBe(503);
    const { Task, ChatMessage } = await getModels();
    expect(await Task.countDocuments()).toBe(0);
    expect(await ChatMessage.countDocuments()).toBe(0);
  });

  it('streams the reply as newline-delimited JSON, in order, and saves it once', async () => {
    await addBrief();
    const response = await call(POST, 'POST', {
      message: 'Does this suit Omenai’s focus on contemporary art?',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/x-ndjson');
    // Compression must not hold the stream back until it ends.
    expect(response.headers.get('Cache-Control')).toContain('no-transform');
    expect(requireUser).toHaveBeenCalledWith('chat:write');
    // The reply's work is held open after the response, so a closed tab doesn't lose it.
    expect(after).toHaveBeenCalledTimes(1);

    const received = await lines(response);
    const types = received.map((l) => l.type);
    expect(types[0]).toBe('accepted');
    expect(types[1]).toBe('started');
    expect(types.filter((t) => t === 'text').length).toBeGreaterThan(1);
    expect(types.slice(-2)).toEqual(['checking', 'done']);
    const done = received.at(-1) as Extract<ChatStreamLine, { type: 'done' }>;
    expect(done.message).toMatchObject({
      role: 'assistant',
      scope: 'editorial',
      content: 'Yes, largely: it is a current story about who shapes how this art is shown.',
    });

    const { ChatMessage, Task } = await getModels();
    expect(await ChatMessage.countDocuments({ role: 'assistant' })).toBe(1);
    const accepted = received[0] as Extract<ChatStreamLine, { type: 'accepted' }>;
    const task = (await Task.findOne({ key: accepted.taskKey }).lean())!;
    expect(task.status).toBe('succeeded');
    expect(task.activeLock).toBeUndefined();
  });

  it('starts research when the saved research doesn’t establish the answer, and hands it over after the stream', async () => {
    await addBrief();
    llmFor.mockReturnValue(streamingModel(gapAnswer));
    const response = await call(POST, 'POST', { message: 'When was the director appointed?' });
    const received = await lines(response);
    expect(received.map((l) => l.type).slice(-3)).toEqual(['checking', 'research', 'done']);
    const research = received.at(-2) as Extract<ChatStreamLine, { type: 'research' }>;
    const done = received.at(-1) as Extract<ChatStreamLine, { type: 'done' }>;
    expect(done.message).toMatchObject({
      assessment: 'needs_research',
      followUp: { status: 'started', taskKey: research.taskKey },
    });
    // Handed to the worker once the stream has closed, never before the editor has the answer.
    await (after.mock.calls[0]![0] as () => Promise<void>)();
    expect(enqueueStoryTask).toHaveBeenCalledWith('research', research.taskKey);
    const { Task } = await getModels();
    expect(await Task.findOne({ key: research.taskKey }).lean()).toMatchObject({
      kind: 'research',
      requestKind: 'followup',
      status: 'queued',
    });
  });

  it('starts no research for an answer from the saved research', async () => {
    await addBrief();
    const response = await call(POST, 'POST', { message: 'Does this suit Omenai?' });
    expect((await lines(response)).map((l) => l.type)).not.toContain('research');
    await (after.mock.calls[0]![0] as () => Promise<void>)();
    expect(enqueueStoryTask).not.toHaveBeenCalled();
  });

  it('refuses a second question while a reply is being written, as JSON', async () => {
    await addBrief();
    llmFor.mockReturnValue(streamingModel(editorialAnswer, 20));
    const first = await call(POST, 'POST', { message: 'First?' });
    const second = await call(POST, 'POST', { message: 'Second?' });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe('STORY_BUSY');
    await lines(first);
  });
});

describe('DELETE /api/stories/[id]/chat (Stop)', () => {
  it('stops a reply being written: nothing is saved and the question stays', async () => {
    await addBrief();
    llmFor.mockReturnValue(streamingModel(editorialAnswer, 150));
    const response = await call(POST, 'POST', { message: 'Tell me more.' });
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    const accepted = JSON.parse(first.split('\n')[0]!) as Extract<
      ChatStreamLine,
      { type: 'accepted' }
    >;

    const stop = await call(DELETE, 'DELETE', { taskKey: accepted.taskKey });
    expect(stop.status).toBe(202);
    expect(requireUser).toHaveBeenLastCalledWith('chat:write');

    let rest = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    const last = JSON.parse(rest.trim().split('\n').at(-1)!) as ChatStreamLine;
    expect(last).toMatchObject({ type: 'failed', code: 'stopped' });
    const { ChatMessage } = await getModels();
    expect(await ChatMessage.countDocuments({ role: 'assistant' })).toBe(0);
    expect(await ChatMessage.countDocuments({ role: 'user' })).toBe(1);

    // Nothing running any more: a second Stop changes nothing.
    expect((await call(DELETE, 'DELETE', { taskKey: accepted.taskKey })).status).toBe(200);
  });
});
