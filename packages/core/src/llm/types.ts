import type * as z from 'zod';

/**
 * Provider-agnostic contracts for every model call in the newsroom. Pipeline stages (triage,
 * evaluation, research, chat, generation) depend only on these types and `LlmClient`; nothing
 * outside `llm/providers/` may import a provider SDK.
 */

export const LLM_PROVIDERS = ['gemini', 'anthropic'] as const;
export type LlmProviderName = (typeof LLM_PROVIDERS)[number];

/** Capability tiers. Each provider maps a tier to a concrete model via configuration. */
export const MODEL_TIERS = ['triage', 'primary', 'escalation'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** How hard the model should think. Adapters translate this to provider settings. */
export type Effort = 'low' | 'medium' | 'high';

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Links a call to the work it served, for usage records. */
export interface UsageContext {
  runKey?: string;
  taskId?: string;
  storyId?: string;
}

interface BaseRequest {
  /** Stable label for usage tracking, e.g. `discovery.triage`. */
  operation: string;
  tier: ModelTier;
  /** Stable instructions. Kept identical across calls so providers can cache them. */
  system: string;
  messages: LlmMessage[];
  /** Budget for the visible answer. Adapters add headroom for reasoning where needed. */
  maxOutputTokens: number;
  effort?: Effort;
  context?: UsageContext;
}

export type TextRequest = BaseRequest;

export interface ObjectRequest<T> extends BaseRequest {
  /** Full contract; the response is always validated against it after parsing. */
  schema: z.ZodType<T>;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the provider's prompt cache, when reported. */
  cachedInputTokens: number;
  /** Tokens spent on internal reasoning, when reported separately. */
  reasoningTokens: number;
}

export type StopReason = 'complete' | 'max_tokens' | 'refusal' | 'safety' | 'other';

export interface LlmResult<T> {
  data: T;
  provider: LlmProviderName;
  model: string;
  usage: LlmUsage;
}

/** What an adapter receives: the model is resolved, the schema already provider-neutral JSON. */
export interface ProviderRequest {
  model: string;
  system: string;
  messages: LlmMessage[];
  maxOutputTokens: number;
  effort: Effort;
  /** Provider-neutral JSON Schema (draft 2020-12); each adapter adapts it to what it supports. */
  jsonSchema?: Record<string, unknown>;
}

export interface ProviderResponse {
  text: string;
  model: string;
  stopReason: StopReason;
  usage: LlmUsage;
}

export interface LlmProvider {
  readonly name: LlmProviderName;
  generate(request: ProviderRequest): Promise<ProviderResponse>;
}

export type LlmErrorKind =
  | 'rate_limited'
  | 'unavailable'
  | 'auth'
  | 'invalid_request'
  | 'refusal'
  | 'safety_blocked'
  | 'truncated'
  | 'invalid_output';

const RETRYABLE: ReadonlySet<LlmErrorKind> = new Set(['rate_limited', 'unavailable']);

/**
 * The only error type that leaves the LLM layer. `retryable` tells background tasks whether a
 * later attempt can succeed (rate limits, outages) or the failure is permanent (bad credentials,
 * refusals, invalid requests) and should not be retried.
 */
export class LlmError extends Error {
  override readonly name = 'LlmError';
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly provider: LlmProviderName,
    options?: { cause?: unknown; status?: number },
  ) {
    super(message, { cause: options?.cause });
    this.retryable = RETRYABLE.has(kind);
    this.status = options?.status;
  }
}
