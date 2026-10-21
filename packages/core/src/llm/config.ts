import { ConfigError, optionalEnv, requireEnv } from '../config/env.js';
import { readRuntime, type Runtime } from '../config/runtime.js';
import { LLM_PROVIDERS, MODEL_TIERS, type LlmProviderName, type ModelTier } from './types.js';

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

/** Every model ID a provider serves starts with this, so a stale override can't cross over. */
const MODEL_ID_PREFIX: Record<LlmProviderName, string> = {
  gemini: 'gemini-',
  anthropic: 'claude-',
};

/**
 * The only provider each runtime may use, where the runtime fixes one. Production is Anthropic
 * only: its prompts and data must never reach the Gemini free tier, where prompts may be
 * reviewed by people. Live development is Gemini only (moving it is its own approved milestone).
 * Fixtures and tests use whatever they configure; their model calls are scripted.
 */
const REQUIRED_PROVIDER: Partial<Record<Runtime, LlmProviderName>> = {
  production: 'anthropic',
  'live-dev': 'gemini',
};

/**
 * Throws unless `provider` may serve model calls in `runtime`. Checked when the configuration
 * is read and again where a provider is constructed, so no path builds a forbidden adapter.
 */
export function assertProviderAllowed(runtime: Runtime, provider: LlmProviderName): void {
  const required = REQUIRED_PROVIDER[runtime];
  if (required && provider !== required)
    throw new ConfigError(
      'LLM_PROVIDER',
      `${runtime === 'production' ? 'production' : 'live development'} uses ${required} only (is "${provider}")`,
    );
}

export interface LlmConfig {
  provider: LlmProviderName;
  apiKey: string;
  models: Record<ModelTier, string>;
}

/**
 * The single place the provider, its key and its models are resolved. Only the selected
 * provider's variables are read: another provider's key or model overrides are ignored, and
 * nothing falls back to a different provider when the selected one is missing or failing.
 */
export function readLlmConfig(): LlmConfig {
  const provider = requireEnv('LLM_PROVIDER');
  if (!(LLM_PROVIDERS as readonly string[]).includes(provider)) {
    throw new ConfigError('LLM_PROVIDER', `expected one of ${LLM_PROVIDERS.join(', ')}`);
  }
  const name = provider as LlmProviderName;
  assertProviderAllowed(readRuntime(), name);
  const prefix = name.toUpperCase();
  const defaults = DEFAULT_MODELS[name];

  const models = Object.fromEntries(
    MODEL_TIERS.map((tier) => {
      const variable = `${prefix}_MODEL_${tier.toUpperCase()}`;
      const model = optionalEnv(variable) ?? defaults[tier];
      if (!model.startsWith(MODEL_ID_PREFIX[name]))
        throw new ConfigError(
          variable,
          `"${model}" is not one of ${name}'s models (expected an ID starting with ${MODEL_ID_PREFIX[name]})`,
        );
      return [tier, model];
    }),
  ) as Record<ModelTier, string>;

  return { provider: name, apiKey: requireEnv(API_KEY_VARIABLE[name]), models };
}
