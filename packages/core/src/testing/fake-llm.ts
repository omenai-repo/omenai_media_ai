/**
 * TEST FIXTURE ONLY. A scripted LLM provider that answers by recognising which pipeline prompt it
 * received. It runs behind the real `LlmClient`, so schema validation and the repair round are
 * exercised exactly as in production. It proves nothing about real model behaviour.
 */
import { createLlmClient, type LlmClient } from '../llm/client.js';
import {
  LlmError,
  type LlmProvider,
  type ModelTier,
  type ProviderRequest,
  type ProviderResponse,
} from '../llm/types.js';
import {
  CHANGE_SYSTEM_PROMPT,
  CLUSTER_SYSTEM_PROMPT,
  EVALUATION_SYSTEM_PROMPT,
  TRIAGE_SYSTEM_PROMPT,
} from '../discovery/prompts.js';

export type ScriptedOperation = 'triage' | 'cluster' | 'evaluate' | 'change';

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
  throw new Error('Scripted LLM received an unknown system prompt');
}

export function createScriptedLlm(script: Partial<Record<ScriptedOperation, ScriptHandler>>): {
  llm: LlmClient;
  calls: ScriptedCall[];
  /** Makes the next call for `operation` fail with a transient provider error. */
  failNextWithOutage: (operation: ScriptedOperation) => void;
} {
  const calls: ScriptedCall[] = [];
  const outages = new Set<ScriptedOperation>();

  const provider: LlmProvider = {
    name: 'gemini',
    generate: (request: ProviderRequest): Promise<ProviderResponse> => {
      const operation = operationFor(request.system);
      const tier = MODEL_TIER[request.model] ?? 'primary';
      const prompt = request.messages[0]?.content ?? '';
      calls.push({ operation, tier, prompt });
      if (outages.delete(operation)) {
        return Promise.reject(
          new LlmError('unavailable', 'scripted outage', 'gemini', { status: 503 }),
        );
      }
      const handler = script[operation];
      if (!handler) return Promise.reject(new Error(`No scripted handler for ${operation}`));
      return Promise.resolve({
        text: JSON.stringify(handler(prompt, tier)),
        model: request.model,
        stopReason: 'complete',
        usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, reasoningTokens: 0 },
      });
    },
  };

  const llm = createLlmClient({
    provider,
    models: { triage: 'fake-triage', primary: 'fake-primary', escalation: 'fake-escalation' },
    recordUsage: () => Promise.resolve(),
  });
  return { llm, calls, failNextWithOutage: (operation) => outages.add(operation) };
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
