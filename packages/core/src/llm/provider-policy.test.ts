/**
 * Production is Anthropic only; live development is Gemini only. These tests drive the real
 * configuration, factory, client and adapters over intercepted HTTP, and spy on the Gemini
 * factory, so they prove which adapter is built and which API is called, not just which string
 * is configured.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';

import { ConfigError } from '../config/env.js';
import { getLlmClient, resetLlmClientForTesting } from './client.js';
import { readLlmConfig } from './config.js';
import { createAnthropicProvider } from './providers/anthropic.js';
import { createGeminiProvider } from './providers/gemini.js';
import { LlmError } from './types.js';

// No database here: usage recording is covered elsewhere.
vi.mock('./usage.js', () => ({ recordUsageInDatabase: () => Promise.resolve() }));
vi.mock('./providers/gemini.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./providers/gemini.js')>();
  return { ...actual, createGeminiProvider: vi.fn(actual.createGeminiProvider) };
});
vi.mock('./providers/anthropic.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./providers/anthropic.js')>();
  return { ...actual, createAnthropicProvider: vi.fn(actual.createAnthropicProvider) };
});

const ENV_KEYS = [
  'OMENAI_RUNTIME',
  'LLM_PROVIDER',
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_MODEL_TRIAGE',
  'GEMINI_MODEL_PRIMARY',
  'GEMINI_MODEL_ESCALATION',
  'ANTHROPIC_MODEL_TRIAGE',
  'ANTHROPIC_MODEL_PRIMARY',
  'ANTHROPIC_MODEL_ESCALATION',
  'AI_DAILY_CALL_LIMIT',
] as const;
let savedEnv: Record<string, string | undefined>;

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  vi.mocked(createGeminiProvider).mockClear();
  vi.mocked(createAnthropicProvider).mockClear();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  resetLlmClientForTesting();
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetLlmClientForTesting();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Production with Gemini fully configured alongside: the stale or secondary setting to ignore. */
const PRODUCTION_WITH_GEMINI_LEFTOVERS = {
  OMENAI_RUNTIME: 'production',
  LLM_PROVIDER: 'anthropic',
  ANTHROPIC_API_KEY: 'anthropic-test-key',
  GEMINI_API_KEY: 'gemini-test-key',
  GEMINI_MODEL_TRIAGE: 'gemini-3.5-flash-lite',
  GEMINI_MODEL_PRIMARY: 'gemini-3.8-flash',
  GEMINI_MODEL_ESCALATION: 'gemini-3.8-flash',
} as const;

const verdict = z.object({ pillar: z.string(), confident: z.boolean() });

/** Answers as each provider's API would, recording every host and model requested. */
function stubProviderApis(anthropic: (call: number) => Response | Promise<Response>) {
  const calls: Array<{ host: string; model: unknown }> = [];
  let anthropicCalls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const host = new URL(url).host;
      const body =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as { model?: unknown }) : {};
      calls.push({ host, model: body.model });
      if (host === 'api.anthropic.com') return anthropic(++anthropicCalls);
      return Promise.resolve(
        new Response(
          JSON.stringify({ error: { code: 500, message: 'Gemini must not be called' } }),
          {
            status: 500,
          },
        ),
      );
    }),
  );
  return calls;
}

const anthropicMessage = (text: string, model = 'claude-haiku-5-5') =>
  new Response(
    JSON.stringify({
      id: 'msg',
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 40, output_tokens: 12 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const anthropicOverloaded = () =>
  new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error' } }), {
    status: 529,
    headers: { 'content-type': 'application/json', 'retry-after-ms': '5' },
  });

function classify(tier: 'triage' | 'primary' | 'escalation' = 'triage') {
  return getLlmClient().generateObject({
    operation: 'test.classify',
    tier,
    system: 'Classify the story.',
    messages: [{ role: 'user', content: 'A retrospective at Zeitz MOCAA.' }],
    maxOutputTokens: 200,
    schema: verdict,
    retry: { attempts: 2, initialDelayMs: 5, maxDelayMs: 10 },
  });
}

describe('provider resolution', () => {
  it('resolves production to Anthropic and its default tier models', () => {
    setEnv({ OMENAI_RUNTIME: 'production', LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' });
    expect(readLlmConfig()).toEqual({
      provider: 'anthropic',
      apiKey: 'k',
      models: {
        triage: 'claude-haiku-5-5',
        primary: 'claude-sonnet-5-5',
        escalation: 'claude-opus-5-5',
      },
    });
  });

  it('ignores a configured Gemini key and Gemini model overrides in production', () => {
    setEnv(PRODUCTION_WITH_GEMINI_LEFTOVERS);
    const config = readLlmConfig();
    expect(config.provider).toBe('anthropic');
    expect(config.apiKey).toBe('anthropic-test-key');
    expect(Object.values(config.models).every((m) => m.startsWith('claude-'))).toBe(true);
  });

  it('refuses LLM_PROVIDER=gemini in production instead of running on Gemini', () => {
    setEnv({ ...PRODUCTION_WITH_GEMINI_LEFTOVERS, LLM_PROVIDER: 'gemini' });
    expect(() => readLlmConfig()).toThrow(ConfigError);
    expect(() => getLlmClient()).toThrow(/LLM_PROVIDER.*production uses anthropic only/);
    expect(createGeminiProvider).not.toHaveBeenCalled();
  });

  it('fails clearly when the Anthropic key is missing, even with a Gemini key at hand', () => {
    setEnv({ ...PRODUCTION_WITH_GEMINI_LEFTOVERS, ANTHROPIC_API_KEY: '' });
    expect(() => getLlmClient()).toThrow(/ANTHROPIC_API_KEY/);
    expect(createGeminiProvider).not.toHaveBeenCalled();
    expect(createAnthropicProvider).not.toHaveBeenCalled();
  });

  it.each(['openai', 'Anthropic', 'gemini,anthropic', ''])(
    'refuses an unsupported provider value (%j) rather than choosing one',
    (value) => {
      setEnv({ ...PRODUCTION_WITH_GEMINI_LEFTOVERS, LLM_PROVIDER: value });
      expect(() => getLlmClient()).toThrow(/LLM_PROVIDER/);
      expect(createGeminiProvider).not.toHaveBeenCalled();
    },
  );

  it('refuses an Anthropic model override that names another provider’s model', () => {
    setEnv({ ...PRODUCTION_WITH_GEMINI_LEFTOVERS, ANTHROPIC_MODEL_PRIMARY: 'gemini-3.8-flash' });
    expect(() => readLlmConfig()).toThrow(/ANTHROPIC_MODEL_PRIMARY.*not one of anthropic's models/);
  });

  it('keeps live development on Gemini, with its model overrides', () => {
    setEnv({
      OMENAI_RUNTIME: 'live-dev',
      LLM_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'g',
      ANTHROPIC_API_KEY: 'a',
      GEMINI_MODEL_PRIMARY: 'gemini-3.5-flash-lite',
    });
    const llm = getLlmClient();
    expect(llm.provider).toBe('gemini');
    expect(llm.modelFor('primary')).toBe('gemini-3.5-flash-lite');
    expect(createGeminiProvider).toHaveBeenCalledTimes(1);
    expect(createAnthropicProvider).not.toHaveBeenCalled();
  });

  it('still refuses Anthropic in live development', () => {
    setEnv({ OMENAI_RUNTIME: 'live-dev', LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'a' });
    expect(() => getLlmClient()).toThrow(/live development uses gemini only/);
  });

  it('leaves the provider to configuration in tests and fixtures', () => {
    for (const runtime of ['test', 'fixtures'])
      for (const [provider, key] of [
        ['gemini', 'GEMINI_API_KEY'],
        ['anthropic', 'ANTHROPIC_API_KEY'],
      ] as const) {
        setEnv({ OMENAI_RUNTIME: runtime, LLM_PROVIDER: provider, [key]: 'k' });
        expect(readLlmConfig().provider).toBe(provider);
      }
  });
});

describe('production invocation boundary', () => {
  it('sends every tier to the Anthropic API with its Claude model, and never builds Gemini', async () => {
    setEnv(PRODUCTION_WITH_GEMINI_LEFTOVERS);
    const calls = stubProviderApis(() => anthropicMessage('{"pillar":"art","confident":true}'));
    for (const tier of ['triage', 'primary', 'escalation'] as const)
      await expect(classify(tier)).resolves.toMatchObject({
        provider: 'anthropic',
        data: { pillar: 'art', confident: true },
      });
    expect(calls).toEqual([
      { host: 'api.anthropic.com', model: 'claude-haiku-5-5' },
      { host: 'api.anthropic.com', model: 'claude-sonnet-5-5' },
      { host: 'api.anthropic.com', model: 'claude-opus-5-5' },
    ]);
    expect(createGeminiProvider).not.toHaveBeenCalled();
  });

  it('retries Anthropic within the policy, then fails as Anthropic; no Gemini fallback', async () => {
    setEnv(PRODUCTION_WITH_GEMINI_LEFTOVERS);
    const calls = stubProviderApis(() => anthropicOverloaded());
    const error = await classify().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ provider: 'anthropic', kind: 'unavailable', retryable: true });
    expect((error as Error).message).not.toMatch(/gemini/i);
    // Exactly the policy's two attempts, both to Anthropic.
    expect(calls.map((c) => c.host)).toEqual(['api.anthropic.com', 'api.anthropic.com']);
    expect(createGeminiProvider).not.toHaveBeenCalled();
  });

  it('keeps the repair round on Anthropic when the first answer is invalid', async () => {
    setEnv(PRODUCTION_WITH_GEMINI_LEFTOVERS);
    const calls = stubProviderApis((n) =>
      anthropicMessage(n === 1 ? 'not json' : '{"pillar":"film","confident":false}'),
    );
    await expect(classify()).resolves.toMatchObject({ data: { pillar: 'film' } });
    expect(calls.map((c) => c.host)).toEqual(['api.anthropic.com', 'api.anthropic.com']);
  });

  it('reports a request Anthropic rejects as a permanent Anthropic error', async () => {
    setEnv(PRODUCTION_WITH_GEMINI_LEFTOVERS);
    stubProviderApis(
      () =>
        new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const error = await classify().catch((e: unknown) => e);
    expect(error).toMatchObject({
      provider: 'anthropic',
      kind: 'invalid_request',
      retryable: false,
    });
    expect((error as Error).message).toMatch(/^Anthropic API error 400/);
  });

  it('rebuilds a warm process’s client when its configuration changes, never keeping Gemini', () => {
    setEnv({ OMENAI_RUNTIME: 'live-dev', LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'g' });
    expect(getLlmClient().provider).toBe('gemini');

    setEnv(PRODUCTION_WITH_GEMINI_LEFTOVERS);
    const production = getLlmClient();
    expect(production.provider).toBe('anthropic');
    expect(getLlmClient()).toBe(production);

    process.env.ANTHROPIC_MODEL_PRIMARY = 'claude-opus-5-5';
    expect(getLlmClient().modelFor('primary')).toBe('claude-opus-5-5');
    expect(createGeminiProvider).toHaveBeenCalledTimes(1);
  });

  it('logs which provider and models a process uses, never the key', () => {
    setEnv(PRODUCTION_WITH_GEMINI_LEFTOVERS);
    getLlmClient();
    const logged = JSON.stringify(vi.mocked(console.info).mock.calls);
    expect(logged).toContain('anthropic');
    expect(logged).toContain('claude-sonnet-5-5');
    expect(logged).not.toContain('anthropic-test-key');
    expect(logged).not.toContain('gemini-test-key');
  });
});
