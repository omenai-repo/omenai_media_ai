import { ConfigError, optionalEnv, requireEnv } from '../config/env.js';
import { LLM_PROVIDERS, type LlmProviderName, type ModelTier } from './types.js';

/**
 * Default model per provider and tier: the single place model IDs live in code. Every entry can
 * be overridden with `<PROVIDER>_MODEL_<TIER>`, e.g. `GEMINI_MODEL_PRIMARY`.
 *
 * Gemini (development): the free tier on our key returns 429 for Pro-class models
 * (gemini-4-argon, gemini-3.1-pro-preview), so escalation uses Flash with high thinking.
 * Anthropic (production target): the agreed routing of ADR-004.
 */
export const DEFAULT_MODELS: Record<LlmProviderName, Record<ModelTier, string>> = {
  gemini: {
    triage: 'gemini-3.5-flash-lite',
    primary: 'gemini-3.8-flash',
    escalation: 'gemini-3.8-flash',
  },
  anthropic: {
    triage: 'claude-haiku-5-5',
    primary: 'claude-sonnet-5-5',
    escalation: 'claude-opus-5-5',
  },
};

const API_KEY_VARIABLE: Record<LlmProviderName, string> = {
  gemini: 'GEMINI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

export interface LlmConfig {
  provider: LlmProviderName;
  apiKey: string;
  models: Record<ModelTier, string>;
}

export function readLlmConfig(): LlmConfig {
  const provider = requireEnv('LLM_PROVIDER');
  if (!(LLM_PROVIDERS as readonly string[]).includes(provider)) {
    throw new ConfigError('LLM_PROVIDER', `expected one of ${LLM_PROVIDERS.join(', ')}`);
  }
  const name = provider as LlmProviderName;
  const prefix = name.toUpperCase();
  const defaults = DEFAULT_MODELS[name];

  return {
    provider: name,
    apiKey: requireEnv(API_KEY_VARIABLE[name]),
    models: {
      triage: optionalEnv(`${prefix}_MODEL_TRIAGE`) ?? defaults.triage,
      primary: optionalEnv(`${prefix}_MODEL_PRIMARY`) ?? defaults.primary,
      escalation: optionalEnv(`${prefix}_MODEL_ESCALATION`) ?? defaults.escalation,
    },
  };
}
