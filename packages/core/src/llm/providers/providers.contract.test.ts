/**
 * Contract tests for the provider adapters against recorded-shape HTTP responses. They pin down
 * what each adapter sends (model, system prompt, schema dialect, effort) and how it normalizes
 * what comes back, without network access or credentials.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';

import { toNeutralJsonSchema } from '../json-schema.js';
import { LlmError, type ProviderRequest } from '../types.js';
import { createAnthropicProvider, toAnthropicMessages } from './anthropic.js';
import { createGeminiProvider } from './gemini.js';

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function stubFetch(status: number, payload: unknown) {
  const captured: Captured[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      captured.push({
        url,
        headers: new Headers(init?.headers ?? request?.headers),
        body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
          string,
          unknown
        >,
      });
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
  return captured;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const jsonSchema = toNeutralJsonSchema(
  z.object({ pillar: z.string().min(2), score: z.number().int().min(0).max(5) }),
);

function request(model: string, withSchema = true): ProviderRequest {
  return {
    model,
    system: 'You are Omenai’s editorial assistant.',
    messages: [
      { role: 'user', content: 'Classify this.' },
      { role: 'assistant', content: '{"pillar":"art"}' },
      { role: 'user', content: 'Include a score.' },
    ],
    maxOutputTokens: 500,
    effort: 'medium',
    jsonSchema: withSchema ? jsonSchema : undefined,
  };
}

describe('Gemini adapter', () => {
  const okPayload = {
    candidates: [
      {
        content: { role: 'model', parts: [{ text: '{"pillar":"art","score":4}' }] },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: {
      promptTokenCount: 120,
      candidatesTokenCount: 14,
      thoughtsTokenCount: 30,
      cachedContentTokenCount: 100,
      totalTokenCount: 164,
    },
    modelVersion: 'gemini-3.8-flash',
  };

  it('sends the system instruction, mapped roles, adapted schema, thinking level and headroom', async () => {
    const captured = stubFetch(200, okPayload);
    const result = await createGeminiProvider({ apiKey: 'test-key' }).generate(
      request('gemini-3.8-flash'),
    );

    const call = captured[0]!;
    expect(call.url).toContain('models/gemini-3.8-flash:generateContent');
    expect(JSON.stringify(call.body)).toContain('Omenai’s editorial assistant');
    const contents = call.body.contents as Array<{ role: string }>;
    expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
    const config = call.body.generationConfig as Record<string, unknown>;
    expect(config.responseMimeType).toBe('application/json');
    expect(JSON.stringify(config.responseJsonSchema)).not.toContain('minLength');
    expect(config.maxOutputTokens).toBeGreaterThan(500);
    expect(config.thinkingConfig).toMatchObject({ thinkingLevel: 'MEDIUM' });

    expect(result).toEqual({
      text: '{"pillar":"art","score":4}',
      model: 'gemini-3.8-flash',
      stopReason: 'complete',
      usage: { inputTokens: 120, outputTokens: 14, cachedInputTokens: 100, reasoningTokens: 30 },
      attempts: { attempts: 1, retryStatuses: [] },
    });
  });

  it('sends a message with a cacheable opening unchanged (Gemini caches implicitly)', async () => {
    const captured = stubFetch(200, okPayload);
    await createGeminiProvider({ apiKey: 'k' }).generate({
      ...request('gemini-3.8-flash'),
      messages: [
        { role: 'user', content: 'STORY AND BRIEFS\n\nQUESTION', cacheablePrefixLength: 18 },
      ],
    });
    expect(captured[0]!.body.contents).toEqual([
      { role: 'user', parts: [{ text: 'STORY AND BRIEFS\n\nQUESTION' }] },
    ]);
  });

  it('reports MAX_TOKENS and safety finishes', async () => {
    stubFetch(200, {
      ...okPayload,
      candidates: [{ ...okPayload.candidates[0], finishReason: 'MAX_TOKENS' }],
    });
    expect((await createGeminiProvider({ apiKey: 'k' }).generate(request('m'))).stopReason).toBe(
      'max_tokens',
    );
    stubFetch(200, {
      ...okPayload,
      candidates: [{ ...okPayload.candidates[0], finishReason: 'SAFETY' }],
    });
    expect((await createGeminiProvider({ apiKey: 'k' }).generate(request('m'))).stopReason).toBe(
      'safety',
    );
  });

  it.each([
    [429, 'rate_limited', true],
    [503, 'unavailable', true],
    [403, 'auth', false],
    [400, 'invalid_request', false],
  ] as const)('maps HTTP %d to %s (retryable: %s)', async (status, kind, retryable) => {
    stubFetch(status, { error: { code: status, message: 'nope', status: 'X' } });
    const error = await createGeminiProvider({ apiKey: 'k', retries: 1 })
      .generate(request('m'))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ kind, retryable, provider: 'gemini', status });
  });

  it('retries a momentary overload inside the call before reporting a failure', async () => {
    const answer = {
      candidates: [
        { content: { parts: [{ text: '{"pillar":"art","score":3}' }] }, finishReason: 'STOP' },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      modelVersion: 'm',
    };
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        calls += 1;
        return Promise.resolve(
          calls === 1
            ? new Response(JSON.stringify({ error: { code: 503, message: 'high demand' } }), {
                status: 503,
                headers: { 'content-type': 'application/json' },
              })
            : new Response(JSON.stringify(answer), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }),
        );
      }),
    );
    const result = await createGeminiProvider({ apiKey: 'k' }).generate(request('m'));
    expect(result.stopReason).toBe('complete');
    expect(calls).toBe(2);
  }, 30_000);
});

describe('Anthropic adapter', () => {
  const message = (overrides: Record<string, unknown> = {}) => ({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5-5',
    content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: '{"pillar":"art","score":4}' },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 200,
      output_tokens: 40,
      cache_read_input_tokens: 150,
      cache_creation_input_tokens: 30,
      output_tokens_details: { thinking_tokens: 25 },
    },
    ...overrides,
  });

  it('sends a cached system prompt, closed schema and effort; enables refusal fallback on Sonnet', async () => {
    const captured = stubFetch(200, message());
    const provider = createAnthropicProvider({ apiKey: 'test-key', maxRetries: 0 });
    const result = await provider.generate(request('claude-sonnet-5-5'));

    const call = captured[0]!;
    expect(call.url).toContain('/v1/messages');
    expect(call.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(call.body).toMatchObject({
      model: 'claude-sonnet-5-5',
      // The 500-token answer budget plus medium-effort thinking headroom: max_tokens caps
      // thinking and answer together, and these models think by default.
      max_tokens: 500 + 4_096,
      fallbacks: 'default',
      system: [{ type: 'text', cache_control: { type: 'ephemeral' } }],
      output_config: { effort: 'medium', format: { type: 'json_schema' } },
    });
    const schema = (call.body.output_config as { format: { schema: Record<string, unknown> } })
      .format.schema;
    expect(schema.additionalProperties).toBe(false);
    expect(JSON.stringify(schema)).not.toMatch(/"minimum"|"maximum"|"minLength"/);

    // Thinking blocks are ignored; only the answer text is returned.
    expect(result).toEqual({
      text: '{"pillar":"art","score":4}',
      model: 'claude-sonnet-5-5',
      stopReason: 'complete',
      usage: {
        inputTokens: 200,
        outputTokens: 40,
        cachedInputTokens: 150,
        cacheWriteTokens: 30,
        reasoningTokens: 25,
      },
      attempts: { attempts: 1, retryStatuses: [] },
    });
  });

  it.each([
    ['low', 1_024],
    ['high', 8_192],
  ] as const)('adds %s-effort thinking headroom to the answer budget', async (effort, headroom) => {
    const captured = stubFetch(200, message());
    await createAnthropicProvider({ apiKey: 'k', maxRetries: 0 }).generate({
      ...request('claude-haiku-5-5'),
      effort,
    });
    expect(captured[0]!.body.max_tokens).toBe(500 + headroom);
  });

  it('sends a cacheable opening as its own cached block, with the text unchanged', async () => {
    const captured = stubFetch(200, message());
    await createAnthropicProvider({ apiKey: 'k', maxRetries: 0 }).generate({
      ...request('claude-sonnet-5-5'),
      messages: [
        { role: 'user', content: 'STORY AND BRIEFS\n\nQUESTION', cacheablePrefixLength: 18 },
      ],
    });
    expect(captured[0]!.body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'STORY AND BRIEFS\n\n', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'QUESTION' },
        ],
      },
    ]);
  });

  it('ignores a cacheable length outside the text, and caps message breakpoints at three', () => {
    const plain = { role: 'user' as const, content: 'abc' };
    expect(toAnthropicMessages([{ ...plain, cacheablePrefixLength: 0 }])).toEqual([plain]);
    expect(toAnthropicMessages([{ ...plain, cacheablePrefixLength: 9 }])).toEqual([plain]);
    expect(toAnthropicMessages([{ ...plain, cacheablePrefixLength: 3 }])).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'abc', cache_control: { type: 'ephemeral' } }],
      },
    ]);
    const many = toAnthropicMessages(
      Array.from({ length: 5 }, () => ({ ...plain, cacheablePrefixLength: 1 })),
    );
    // With the system prompt's, four in all: the most recent three messages keep theirs.
    expect(many.map((m) => typeof m.content !== 'string')).toEqual([
      false,
      false,
      true,
      true,
      true,
    ]);
  });

  it('does not request a refusal fallback for Haiku, and sends no schema for text calls', async () => {
    const captured = stubFetch(200, message({ model: 'claude-haiku-5-5' }));
    await createAnthropicProvider({ apiKey: 'k', maxRetries: 0 }).generate(
      request('claude-haiku-5-5', false),
    );
    expect(captured[0]!.body.fallbacks).toBeUndefined();
    expect(captured[0]!.headers.get('anthropic-beta') ?? '').not.toContain('server-side-fallback');
    expect((captured[0]!.body.output_config as Record<string, unknown>).format).toBeUndefined();
  });

  it('reports refusals and truncation', async () => {
    stubFetch(200, message({ stop_reason: 'refusal' }));
    expect(
      (await createAnthropicProvider({ apiKey: 'k', maxRetries: 0 }).generate(request('m')))
        .stopReason,
    ).toBe('refusal');
    stubFetch(200, message({ stop_reason: 'max_tokens' }));
    expect(
      (await createAnthropicProvider({ apiKey: 'k', maxRetries: 0 }).generate(request('m')))
        .stopReason,
    ).toBe('max_tokens');
  });

  it.each([
    [429, 'rate_limited', true],
    [529, 'unavailable', true],
    [401, 'auth', false],
    [400, 'invalid_request', false],
  ] as const)('maps HTTP %d to %s (retryable: %s)', async (status, kind, retryable) => {
    stubFetch(status, { type: 'error', error: { type: 'x', message: 'nope' } });
    const error = await createAnthropicProvider({ apiKey: 'k', maxRetries: 0 })
      .generate(request('m'))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ kind, retryable, provider: 'anthropic', status });
  });

  function respondInTurn(responses: Array<() => Response>) {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(responses[Math.min(calls++, responses.length - 1)]!())),
    );
    return () => calls;
  }
  const overloaded = () =>
    new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error' } }), {
      status: 529,
      headers: { 'content-type': 'application/json', 'retry-after-ms': '5' },
    });
  const ok = () =>
    new Response(JSON.stringify(message()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it("follows the caller's retry policy, and records and reports each retry", async () => {
    const calls = respondInTurn([overloaded, ok]);
    const retried: number[] = [];
    const result = await createAnthropicProvider({ apiKey: 'k' }).generate({
      ...request('claude-sonnet-5-5'),
      retry: { attempts: 2, initialDelayMs: 10, maxDelayMs: 20 },
      onRetry: (status) => retried.push(status),
    });
    expect(calls()).toBe(2);
    expect(retried).toEqual([529]);
    expect(result).toMatchObject({
      stopReason: 'complete',
      attempts: { attempts: 2, retryStatuses: [529] },
    });
  });

  it('stops at the policy and keeps the attempts on an Anthropic-labelled error', async () => {
    const calls = respondInTurn([overloaded]);
    const error = await createAnthropicProvider({ apiKey: 'k' })
      .generate({ ...request('m'), retry: { attempts: 2, initialDelayMs: 10, maxDelayMs: 20 } })
      .catch((e: unknown) => e);
    expect(calls()).toBe(2);
    expect(error).toMatchObject({
      kind: 'unavailable',
      retryable: true,
      provider: 'anthropic',
      status: 529,
      attempts: { attempts: 2, retryStatuses: [529, 529] },
    });
    expect((error as Error).message).toMatch(/^Anthropic API error 529/);
  });

  it('passes the per-attempt timeout and abort signal to the request', async () => {
    let seen: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: unknown, init?: RequestInit) => {
        seen = init?.signal ?? undefined;
        return new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          ),
        );
      }),
    );
    const controller = new AbortController();
    const pending = createAnthropicProvider({ apiKey: 'k', maxRetries: 0 })
      .generate({ ...request('m'), signal: controller.signal, attemptTimeoutMs: 60_000 })
      .catch((e: unknown) => e);
    await vi.waitFor(() => expect(seen).toBeDefined());
    controller.abort();
    // The request itself was cancelled (not merely abandoned), and the failure is not retryable.
    expect(seen!.aborted).toBe(true);
    expect(await pending).toMatchObject({ kind: 'aborted', retryable: false });
  });
});

describe('Anthropic adapter, streamed', () => {
  const sse = (events: Array<Record<string, unknown>>) =>
    new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          for (const event of events)
            controller.enqueue(
              encoder.encode(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`),
            );
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  const start = {
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 200,
        output_tokens: 1,
        cache_read_input_tokens: 150,
        cache_creation_input_tokens: 30,
      },
    },
  };
  const events = [
    start,
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '{"pillar":' } },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: '"art","score":4}' },
    },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 40, output_tokens_details: { thinking_tokens: 25 } },
    },
    { type: 'message_stop' },
  ];

  async function drain(stream: AsyncGenerator<string, unknown>) {
    const yielded: string[] = [];
    for (;;) {
      const next = await stream.next();
      if (next.done) return { yielded, result: next.value };
      yielded.push(next.value);
    }
  }

  it('streams only the answer text, then reports usage, finish, model and attempts', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: unknown, init?: RequestInit) => {
        bodies.push(
          JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>,
        );
        return Promise.resolve(sse(events));
      }),
    );
    const { yielded, result } = await drain(
      createAnthropicProvider({ apiKey: 'k', maxRetries: 0 }).stream!(request('claude-sonnet-5-5')),
    );
    expect(bodies[0]).toMatchObject({ stream: true, model: 'claude-sonnet-5-5' });
    expect(yielded).toEqual(['{"pillar":', '"art","score":4}']);
    expect(result).toEqual({
      text: '{"pillar":"art","score":4}',
      model: 'claude-sonnet-5-5',
      stopReason: 'complete',
      usage: {
        inputTokens: 200,
        outputTokens: 40,
        cachedInputTokens: 150,
        cacheWriteTokens: 30,
        reasoningTokens: 25,
      },
      attempts: { attempts: 1, retryStatuses: [] },
    });
  });

  it('turns an overload in the middle of the stream into a retryable Anthropic error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          sse([
            start,
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"p' } },
            { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
          ]),
        ),
      ),
    );
    const error = await drain(
      createAnthropicProvider({ apiKey: 'k', maxRetries: 0 }).stream!(request('m')),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ kind: 'unavailable', retryable: true, provider: 'anthropic' });
  });

  it('ends the request when the consumer stops reading early', async () => {
    let seen: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: unknown, init?: RequestInit) => {
        seen = init?.signal ?? undefined;
        return Promise.resolve(sse(events));
      }),
    );
    const stream = createAnthropicProvider({ apiKey: 'k', maxRetries: 0 }).stream!(request('m'));
    expect((await stream.next()).value).toBe('{"pillar":');
    await stream.return(undefined as never);
    expect(seen?.aborted).toBe(true);
  });
});

describe('Gemini adapter, streamed', () => {
  const sse = (events: unknown[]) =>
    new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          for (const event of events)
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\r\n\r\n`));
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  const pieces = [
    {
      candidates: [{ content: { role: 'model', parts: [{ text: '{"pillar":' }] } }],
      modelVersion: 'gemini-3.5-flash-lite',
    },
    {
      candidates: [
        {
          content: { role: 'model', parts: [{ text: '"art","score":4}' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 14, thoughtsTokenCount: 3 },
      modelVersion: 'gemini-3.5-flash-lite',
    },
  ];

  async function drain(stream: AsyncGenerator<string, unknown>) {
    const yielded: string[] = [];
    for (;;) {
      const next = await stream.next();
      if (next.done) return { yielded, result: next.value };
      yielded.push(next.value);
    }
  }

  it('streams the answer piece by piece, then reports usage, finish and attempts', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request) => {
        urls.push(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        return Promise.resolve(sse(pieces));
      }),
    );
    const provider = createGeminiProvider({ apiKey: 'k' });
    const { yielded, result } = await drain(
      provider.stream!({ ...request('gemini-3.5-flash-lite'), attemptTimeoutMs: 25_000 }),
    );
    expect(urls[0]).toContain('models/gemini-3.5-flash-lite:streamGenerateContent');
    expect(urls[0]).toContain('alt=sse');
    expect(yielded).toEqual(['{"pillar":', '"art","score":4}']);
    expect(result).toEqual({
      text: '{"pillar":"art","score":4}',
      model: 'gemini-3.5-flash-lite',
      stopReason: 'complete',
      usage: { inputTokens: 120, outputTokens: 14, cachedInputTokens: 0, reasoningTokens: 3 },
      attempts: { attempts: 1, retryStatuses: [] },
    });
  });

  it('retries a rejected request before any text, and records and reports the retry', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        calls += 1;
        return Promise.resolve(
          calls === 1
            ? new Response(JSON.stringify({ error: { code: 503, message: 'high demand' } }), {
                status: 503,
                headers: { 'content-type': 'application/json' },
              })
            : sse(pieces),
        );
      }),
    );
    const retried: number[] = [];
    const { result } = await drain(
      createGeminiProvider({ apiKey: 'k' }).stream!({
        ...request('m'),
        retry: { attempts: 2, initialDelayMs: 10, maxDelayMs: 20 },
        onRetry: (status) => retried.push(status),
      }),
    );
    expect(calls).toBe(2);
    expect(retried).toEqual([503]);
    expect(result).toMatchObject({ attempts: { attempts: 2, retryStatuses: [503] } });
  });

  it('does not retry past the policy, and keeps the attempts on the error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { code: 429, message: 'slow down' } }), {
            status: 429,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      ),
    );
    const retried: number[] = [];
    const error = await drain(
      createGeminiProvider({ apiKey: 'k' }).stream!({
        ...request('m'),
        retry: { attempts: 2, initialDelayMs: 10, maxDelayMs: 20 },
        onRetry: (status) => retried.push(status),
      }),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({
      kind: 'rate_limited',
      attempts: { attempts: 2, retryStatuses: [429, 429] },
    });
    // Told once: the second failure is the last attempt, so nothing more is coming.
    expect(retried).toEqual([429]);
  });
});
