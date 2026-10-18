import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import { createLlmClient } from './client.js';
import {
  LlmError,
  type LlmProvider,
  type ProviderRequest,
  type ProviderResponse,
} from './types.js';
import type { LlmUsageRecord } from './usage.js';

const usage = { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, reasoningTokens: 2 };

function fakeProvider(responses: Array<Partial<ProviderResponse> | Error>) {
  const requests: ProviderRequest[] = [];
  const provider: LlmProvider = {
    name: 'gemini',
    generate: (request) => {
      requests.push(request);
      const next = responses.shift();
      if (!next) throw new Error('no more fake responses');
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve({
        text: '',
        model: request.model,
        stopReason: 'complete',
        usage,
        ...next,
      });
    },
  };
  return { provider, requests };
}

function client(responses: Array<Partial<ProviderResponse> | Error>) {
  const { provider, requests } = fakeProvider(responses);
  const records: LlmUsageRecord[] = [];
  const llm = createLlmClient({
    provider,
    models: { triage: 'fast-model', primary: 'main-model', escalation: 'deep-model' },
    recordUsage: (record) => {
      records.push(record);
      return Promise.resolve();
    },
  });
  return { llm, requests, records };
}

const schema = z.object({ pillar: z.enum(['art', 'ideas']), score: z.number().min(0).max(5) });
const base = {
  operation: 'test.classify',
  system: 'You classify stories.',
  messages: [{ role: 'user' as const, content: 'A museum in Lagos.' }],
  maxOutputTokens: 200,
  schema,
};

describe('LlmClient.generateObject', () => {
  it('resolves the model from the tier, applies default effort and validates output', async () => {
    const { llm, requests, records } = client([{ text: '{"pillar":"art","score":4}' }]);
    const result = await llm.generateObject({ ...base, tier: 'triage', context: { runKey: 'r1' } });

    expect(result.data).toEqual({ pillar: 'art', score: 4 });
    expect(requests[0]).toMatchObject({ model: 'fast-model', effort: 'low' });
    expect(requests[0]!.jsonSchema).toMatchObject({ type: 'object' });
    expect(records).toEqual([
      expect.objectContaining({
        operation: 'test.classify',
        outcome: 'ok',
        context: { runKey: 'r1' },
      }),
    ]);
  });

  it('accepts JSON wrapped in a Markdown fence', async () => {
    const { llm } = client([{ text: '```json\n{"pillar":"ideas","score":1}\n```' }]);
    await expect(llm.generateObject({ ...base, tier: 'primary' })).resolves.toMatchObject({
      data: { pillar: 'ideas', score: 1 },
    });
  });

  it('repairs once by showing the model its validation errors', async () => {
    const { llm, requests, records } = client([
      { text: '{"pillar":"fashion","score":9}' },
      { text: '{"pillar":"art","score":5}' },
    ]);
    const repairs: number[] = [];
    const result = await llm.generateObject({
      ...base,
      tier: 'primary',
      // Lets progress say the response is being redone, before the second request goes out.
      onRepair: () => repairs.push(requests.length),
    });

    expect(result.data).toEqual({ pillar: 'art', score: 5 });
    expect(repairs).toEqual([1]);
    const repair = requests[1]!.messages.at(-1)!.content;
    expect(repair).toContain('pillar');
    expect(repair).toContain('score');
    expect(records).toHaveLength(2);
  });

  it('gives up after one repair with a non-retryable invalid_output error', async () => {
    const { llm } = client([{ text: 'not json' }, { text: '{"pillar":"x"}' }]);
    const error = await llm.generateObject({ ...base, tier: 'primary' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).kind).toBe('invalid_output');
    expect((error as LlmError).retryable).toBe(false);
  });

  it.each([
    ['refusal', 'refusal'],
    ['safety', 'safety_blocked'],
    ['max_tokens', 'truncated'],
  ] as const)('maps a %s stop to %s and records it', async (stopReason, kind) => {
    const { llm, records } = client([{ text: '{}', stopReason }]);
    const error = await llm.generateObject({ ...base, tier: 'primary' }).catch((e: unknown) => e);
    expect((error as LlmError).kind).toBe(kind);
    expect(records[0]).toMatchObject({ outcome: 'error', errorKind: kind });
  });

  it('passes provider errors through unchanged and records them', async () => {
    const limited = new LlmError('rate_limited', 'slow down', 'gemini', { status: 429 });
    const { llm, records } = client([limited]);
    await expect(llm.generateObject({ ...base, tier: 'primary' })).rejects.toBe(limited);
    expect(limited.retryable).toBe(true);
    expect(records[0]).toMatchObject({ outcome: 'error', errorKind: 'rate_limited' });
  });
});

describe('LlmClient.generateText', () => {
  it('returns text and honours an explicit effort', async () => {
    const { llm, requests } = client([{ text: 'A considered paragraph.' }]);
    const result = await llm.generateText({
      operation: 'test.text',
      tier: 'escalation',
      effort: 'medium',
      system: 's',
      messages: [{ role: 'user', content: 'write' }],
      maxOutputTokens: 100,
    });
    expect(result.data).toBe('A considered paragraph.');
    expect(requests[0]).toMatchObject({ model: 'deep-model', effort: 'medium' });
  });
});

/** A provider that streams `text` in pieces, pausing between them (and honouring aborts). */
function streamingProvider(text: string, options: { pieces?: number; pauseMs?: number } = {}) {
  const requests: ProviderRequest[] = [];
  const provider: LlmProvider = {
    name: 'gemini',
    generate: () => Promise.reject(new Error('the streamed path was expected')),
    async *stream(request) {
      requests.push(request);
      const size = Math.ceil(text.length / (options.pieces ?? 4));
      for (let at = 0; at < text.length; at += size) {
        await new Promise((resolve) => setTimeout(resolve, options.pauseMs ?? 5));
        if (request.signal?.aborted) throw new Error('aborted');
        yield text.slice(at, at + size);
      }
      return {
        text,
        model: request.model,
        stopReason: 'complete',
        usage,
        attempts: { attempts: 2, retryStatuses: [503] },
      };
    },
  };
  return { provider, requests };
}

describe('LlmClient.streamObject', () => {
  it('passes text on as it arrives, then validates the whole answer and records the timing', async () => {
    const { provider, requests } = streamingProvider('{"pillar":"art","score":4}', { pieces: 4 });
    const records: LlmUsageRecord[] = [];
    let budgetChecks = 0;
    const llm = createLlmClient({
      provider,
      models: { triage: 'fast-model', primary: 'main-model', escalation: 'deep-model' },
      recordUsage: (record) => {
        records.push(record);
        return Promise.resolve();
      },
      beforeCall: () => {
        budgetChecks += 1;
        return Promise.resolve();
      },
    });
    const seen: string[] = [];
    let resolved = false;
    const call = llm
      .streamObject({ ...base, tier: 'primary', onText: (text) => seen.push(text) })
      .then((result) => {
        resolved = true;
        return result;
      });
    const result = await call;
    expect(resolved).toBe(true);
    expect(seen.length).toBe(4);
    expect(seen.at(-1)).toBe('{"pillar":"art","score":4}');
    expect(result.data).toEqual({ pillar: 'art', score: 4 });
    expect(budgetChecks).toBe(1);
    expect(requests[0]).toMatchObject({ model: 'main-model', effort: 'medium' });
    expect(requests[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(records[0]).toMatchObject({
      outcome: 'ok',
      attempts: 2,
      retryStatuses: [503],
      firstChunkMs: expect.any(Number) as number,
      latencyMs: expect.any(Number) as number,
    });
  });

  it('repairs a streamed answer that fails validation with one normal call', async () => {
    const { provider } = streamingProvider('{"pillar":"fashion","score":9}');
    const repaired = {
      ...provider,
      generate: () =>
        Promise.resolve({
          text: '{"pillar":"ideas","score":2}',
          model: 'main-model',
          stopReason: 'complete' as const,
          usage,
        }),
    };
    const records: LlmUsageRecord[] = [];
    const llm = createLlmClient({
      provider: repaired,
      models: { triage: 'a', primary: 'main-model', escalation: 'c' },
      recordUsage: (record) => {
        records.push(record);
        return Promise.resolve();
      },
    });
    const result = await llm.streamObject({ ...base, tier: 'primary', onText: () => undefined });
    expect(result.data).toEqual({ pillar: 'ideas', score: 2 });
    expect(records).toHaveLength(2);
    expect(records[1]!.repairReason).toMatch(/pillar/);
  });

  it('hands a whole answer over once when the provider cannot stream', async () => {
    const { llm } = client([{ text: '{"pillar":"art","score":1}' }]);
    const seen: string[] = [];
    await llm.streamObject({ ...base, tier: 'primary', onText: (text) => seen.push(text) });
    expect(seen).toEqual(['{"pillar":"art","score":1}']);
  });

  it('cancels when the caller aborts, and records it', async () => {
    const { provider } = streamingProvider('{"pillar":"art","score":4}', {
      pieces: 8,
      pauseMs: 20,
    });
    const records: LlmUsageRecord[] = [];
    const llm = createLlmClient({
      provider,
      models: { triage: 'a', primary: 'b', escalation: 'c' },
      recordUsage: (record) => {
        records.push(record);
        return Promise.resolve();
      },
    });
    const controller = new AbortController();
    const error = await llm
      .streamObject({
        ...base,
        tier: 'primary',
        signal: controller.signal,
        onText: () => controller.abort(),
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'aborted', retryable: false });
    expect(records[0]).toMatchObject({ outcome: 'error', errorKind: 'aborted' });
  });
});

describe('the hard deadline of a call', () => {
  it('returns at the deadline even when the provider ignores aborts and keeps retrying', async () => {
    // Retries forever, sleeping between attempts, and never looks at the abort signal.
    const stubborn: LlmProvider = {
      name: 'gemini',
      generate: async () => {
        for (;;) await new Promise((resolve) => setTimeout(resolve, 50));
      },
    };
    const records: LlmUsageRecord[] = [];
    const llm = createLlmClient({
      provider: stubborn,
      models: { triage: 'a', primary: 'b', escalation: 'c' },
      recordUsage: (record) => {
        records.push(record);
        return Promise.resolve();
      },
    });
    const started = Date.now();
    const error = await llm
      .generateObject({ ...base, tier: 'primary', deadlineAt: Date.now() + 200 })
      .catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(error).toMatchObject({ kind: 'timeout', retryable: true });
    expect(records).toEqual([expect.objectContaining({ outcome: 'error', errorKind: 'timeout' })]);
  });

  it('caps one attempt at the time left, and skips a repair round there is no time for', async () => {
    const { llm, requests, records } = client([
      { text: '{"pillar":"fashion","score":9}' },
      { text: '{"pillar":"art","score":5}' },
    ]);
    const error = await llm
      .generateObject({
        ...base,
        tier: 'primary',
        deadlineAt: Date.now() + 1_000,
        attemptTimeoutMs: 60_000,
        minRepairMs: 5_000,
      })
      .catch((e: unknown) => e);
    expect(requests[0]!.attemptTimeoutMs).toBeLessThanOrEqual(1_000);
    expect(requests).toHaveLength(1);
    expect(records).toHaveLength(1);
    expect(error).toMatchObject({ kind: 'invalid_output' });
    expect((error as Error).message).toMatch(/no time left for a repair/);
  });
});
