/**
 * Contract tests for the provider adapters against recorded-shape HTTP responses. They pin down
 * what each adapter sends (model, system prompt, schema dialect, effort) and how it normalizes
 * what comes back, without network access or credentials.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';

import { toNeutralJsonSchema } from '../json-schema.js';
import { LlmError, type ProviderRequest } from '../types.js';
import { createAnthropicProvider } from './anthropic.js';
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
      cache_creation_input_tokens: 0,
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
      max_tokens: 500,
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
      usage: { inputTokens: 200, outputTokens: 40, cachedInputTokens: 150, reasoningTokens: 25 },
    });
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
