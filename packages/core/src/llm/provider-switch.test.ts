/**
 * Proves the provider is a configuration choice: the same business function, using only
 * `LlmClient`, produces the same validated result whether LLM_PROVIDER is gemini or anthropic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';

import { ConfigError } from '../config/env.js';
import { getLlmClient, resetLlmClientForTesting, type LlmClient } from './client.js';

// Usage recording is covered elsewhere; this test has no database.
vi.mock('./usage.js', () => ({ recordUsageInDatabase: () => Promise.resolve() }));

// A stand-in for a pipeline stage: it knows nothing about providers.
const classification = z.object({
  pillar: z.enum(['art_creative_expression', 'ideas_history_cultural_change']),
  rationale: z.string().min(10),
});

async function classifyStory(llm: LlmClient, text: string) {
  const result = await llm.generateObject({
    operation: 'test.classify',
    tier: 'triage',
    system: 'Assign the primary Omenai pillar.',
    messages: [{ role: 'user', content: text }],
    maxOutputTokens: 300,
    schema: classification,
  });
  return result.data;
}

const answer = { pillar: 'art_creative_expression', rationale: 'A retrospective of a sculptor.' };

/** Answers like each provider's API would, so the real adapters run end to end. */
function stubProviderApis() {
  const hosts: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      hosts.push(new URL(url).host);
      const body = url.includes('anthropic')
        ? {
            id: 'm',
            type: 'message',
            role: 'assistant',
            model: 'claude-haiku-5-5',
            content: [{ type: 'text', text: JSON.stringify(answer) }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 50, output_tokens: 20 },
          }
        : {
            candidates: [
              {
                content: { role: 'model', parts: [{ text: JSON.stringify(answer) }] },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20 },
          };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
  return hosts;
}

const ENV_KEYS = [
  'LLM_PROVIDER',
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_MODEL_TRIAGE',
] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  resetLlmClientForTesting();
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetLlmClientForTesting();
  vi.unstubAllGlobals();
});

describe('switching LLM providers through configuration', () => {
  it.each([
    ['gemini', 'GEMINI_API_KEY', 'generativelanguage.googleapis.com', 'gemini-3.5-flash-lite'],
    ['anthropic', 'ANTHROPIC_API_KEY', 'api.anthropic.com', 'claude-haiku-5-5'],
  ] as const)(
    'LLM_PROVIDER=%s runs the same business logic',
    async (provider, keyVar, host, triageModel) => {
      process.env.LLM_PROVIDER = provider;
      process.env[keyVar] = 'test-key';
      const hosts = stubProviderApis();

      const llm = getLlmClient();
      expect(llm.provider).toBe(provider);
      expect(llm.modelFor('triage')).toBe(triageModel);
      await expect(classifyStory(llm, 'A retrospective at Zeitz MOCAA.')).resolves.toEqual(answer);
      expect(hosts).toEqual([host]);
    },
  );

  it('lets an environment variable override a model ID', () => {
    process.env.LLM_PROVIDER = 'gemini';
    process.env.GEMINI_API_KEY = 'k';
    process.env.GEMINI_MODEL_TRIAGE = 'gemini-3.1-flash-lite';
    expect(getLlmClient().modelFor('triage')).toBe('gemini-3.1-flash-lite');
  });

  it('names the missing variable when the provider or its key is not configured', () => {
    expect(() => getLlmClient()).toThrow(ConfigError);
    process.env.LLM_PROVIDER = 'openai';
    expect(() => getLlmClient()).toThrow(/LLM_PROVIDER/);
    process.env.LLM_PROVIDER = 'anthropic';
    expect(() => getLlmClient()).toThrow(/ANTHROPIC_API_KEY/);
  });
});
