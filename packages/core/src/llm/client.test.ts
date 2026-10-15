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
    const result = await llm.generateObject({ ...base, tier: 'primary' });

    expect(result.data).toEqual({ pillar: 'art', score: 5 });
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
