/**
 * TEST FIXTURE ONLY. A scripted LLM provider that answers by recognising which pipeline prompt it
 * received. It runs behind the real `LlmClient`, so schema validation and the repair round are
 * exercised exactly as in production. It proves nothing about real model behaviour.
 */
import { DRAFT_SYSTEM_PROMPT } from '../drafts/prompts.js';
import { createLlmClient, type LlmClient } from '../llm/client.js';
import type { UsageRecorder } from '../llm/usage.js';
import {
  CHAT_SYSTEM_PROMPT,
  FOCUSED_RESEARCH_SYSTEM_PROMPT,
  RESEARCH_SYSTEM_PROMPT,
} from '../research/prompts.js';
import {
  LlmError,
  type LlmProvider,
  type ModelTier,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderStream,
} from '../llm/types.js';
import {
  CHANGE_SYSTEM_PROMPT,
  CLUSTER_SYSTEM_PROMPT,
  EVALUATION_SYSTEM_PROMPT,
  TRIAGE_SYSTEM_PROMPT,
} from '../discovery/prompts.js';

export type ScriptedOperation =
  'triage' | 'cluster' | 'evaluate' | 'change' | 'research' | 'focused' | 'chat' | 'draft';

export interface ScriptedCall {
  operation: ScriptedOperation;
  tier: ModelTier;
  prompt: string;
}

export type ScriptHandler = (prompt: string, tier: ModelTier) => unknown;

const MODEL_TIER: Record<string, ModelTier> = {
  'fake-triage': 'triage',
  'fake-primary': 'primary',
  'fake-escalation': 'escalation',
};

function operationFor(system: string): ScriptedOperation {
  if (system === TRIAGE_SYSTEM_PROMPT) return 'triage';
  if (system === CLUSTER_SYSTEM_PROMPT) return 'cluster';
  if (system === EVALUATION_SYSTEM_PROMPT) return 'evaluate';
  if (system === CHANGE_SYSTEM_PROMPT) return 'change';
  if (system === RESEARCH_SYSTEM_PROMPT) return 'research';
  if (system === FOCUSED_RESEARCH_SYSTEM_PROMPT) return 'focused';
  if (system === CHAT_SYSTEM_PROMPT) return 'chat';
  if (system === DRAFT_SYSTEM_PROMPT) return 'draft';
  throw new Error('Scripted LLM received an unknown system prompt');
}

/** A question containing this makes the scripted stream break off halfway (development fixtures). */
export const FIXTURE_FAIL_MIDSTREAM = '[fixture: fail midway]';

export interface ScriptedStreamOptions {
  /** Characters per streamed piece. */
  chunkChars?: number;
  /** Pause before each piece, so streaming can be watched (0 in tests). */
  chunkDelayMs?: number;
  /** Pause before the first piece instead (a real model's wait before it starts answering). */
  firstChunkDelayMs?: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

const abortError = () =>
  Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });

const USAGE = { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, reasoningTokens: 0 };

export function createScriptedLlm(
  script: Partial<Record<ScriptedOperation, ScriptHandler>>,
  options: { recordUsage?: UsageRecorder; stream?: ScriptedStreamOptions } = {},
): {
  llm: LlmClient;
  calls: ScriptedCall[];
  /** Makes the next call for `operation` fail with a transient provider error. */
  failNextWithOutage: (operation: ScriptedOperation) => void;
  /** Makes the next streamed call for `operation` break off halfway with a dropped connection. */
  failNextStreamMidway: (operation: ScriptedOperation) => void;
} {
  const calls: ScriptedCall[] = [];
  const outages = new Set<ScriptedOperation>();
  const drops = new Set<ScriptedOperation>();

  /** The scripted answer for a request, or the failure scripted for it. */
  function answer(request: ProviderRequest): { operation: ScriptedOperation; text: string } {
    const operation = operationFor(request.system);
    const tier = MODEL_TIER[request.model] ?? 'primary';
    const prompt = request.messages[0]?.content ?? '';
    calls.push({ operation, tier, prompt });
    if (outages.delete(operation))
      throw new LlmError('unavailable', 'scripted outage', 'gemini', { status: 503 });
    const handler = script[operation];
    if (!handler) throw new Error(`No scripted handler for ${operation}`);
    return { operation, text: JSON.stringify(handler(prompt, tier)) };
  }

  const provider: LlmProvider = {
    name: 'gemini',
    generate: (request: ProviderRequest): Promise<ProviderResponse> => {
      try {
        const { text } = answer(request);
        return Promise.resolve({
          text,
          model: request.model,
          stopReason: 'complete',
          usage: USAGE,
        });
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    async *stream(request: ProviderRequest): ProviderStream {
      const { operation, text } = answer(request);
      const prompt = request.messages[0]?.content ?? '';
      // Only the question being answered, not earlier ones in the conversation.
      const question = /^QUESTION: (.*)$/m.exec(prompt)?.[1] ?? '';
      const dropAt =
        drops.delete(operation) || question.includes(FIXTURE_FAIL_MIDSTREAM)
          ? Math.floor(text.length / 2)
          : Infinity;
      const size = Math.max(1, options.stream?.chunkChars ?? 24);
      const pause = options.stream?.chunkDelayMs ?? 0;
      for (let at = 0; at < text.length; at += size) {
        await sleep(
          at === 0 ? (options.stream?.firstChunkDelayMs ?? pause) : pause,
          request.signal,
        );
        if (at >= dropAt)
          throw new LlmError('unavailable', 'scripted connection drop mid-stream', 'gemini');
        yield text.slice(at, at + size);
      }
      return { text, model: request.model, stopReason: 'complete', usage: USAGE };
    },
  };

  const llm = createLlmClient({
    provider,
    models: { triage: 'fake-triage', primary: 'fake-primary', escalation: 'fake-escalation' },
    recordUsage: options.recordUsage ?? (() => Promise.resolve()),
  });
  return {
    llm,
    calls,
    failNextWithOutage: (operation) => outages.add(operation),
    failNextStreamMidway: (operation) => drops.add(operation),
  };
}

/** Parses the "A1 | publisher | date | headline" lines our prompts use. */
export function promptArticles(prompt: string): Array<{ ref: string; headline: string }> {
  return [...prompt.matchAll(/^(A\d+) \| [^|]+\| [^|]+\| (.+)$/gm)].map((m) => ({
    ref: m[1]!,
    headline: m[2]!.trim(),
  }));
}

/** Parses the "S1 | date | headline | …" lines of the clustering prompt. */
export function promptStories(prompt: string): Array<{ ref: string; headline: string }> {
  return [...prompt.matchAll(/^(S\d+) \| [^|]+\| ([^|]+)/gm)].map((m) => ({
    ref: m[1]!,
    headline: m[2]!.trim(),
  }));
}
