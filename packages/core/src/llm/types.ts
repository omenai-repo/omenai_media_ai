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
  /**
   * How many leading characters of `content` repeat across calls (a story's research; a prompt
   * that a follow-up call extends), so a provider with explicit prompt caching may cache up to
   * there. The text sent is the same either way; providers without it ignore this.
   */
  cacheablePrefixLength?: number;
}

/** Links a call to the work it served, for usage records. */
export interface UsageContext {
  runKey?: string;
  taskId?: string;
  storyId?: string;
}

/**
 * Retries of a rejected request (rate limited, overloaded, a dropped connection) inside one call,
 * before any answer arrives. Adapters map it to their SDK; the call's deadline still bounds them.
 */
export interface RetryPolicy {
  /** Attempts in all, counting the first. */
  attempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
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
  /**
   * Hard end of the whole call, as epoch milliseconds: every attempt, retry delay and repair
   * round. The client stops waiting at this moment whatever the provider is doing.
   */
  deadlineAt?: number;
  /** Limit for one attempt (one HTTP request), never longer than the time left. */
  attemptTimeoutMs?: number;
  retry?: RetryPolicy;
  /** A repair round starts only if at least this much time is left. */
  minRepairMs?: number;
  /** Cancels the call, e.g. when an editor stops a reply. */
  signal?: AbortSignal;
  /** Called when a rejected request is about to be retried (e.g. the provider is overloaded). */
  onRetry?: (status: number) => void;
}

export type TextRequest = BaseRequest;

export interface ObjectRequest<T> extends BaseRequest {
  /** Full contract; the response is always validated against it after parsing. */
  schema: z.ZodType<T>;
  /** Called when the answer didn't validate and a repair round is about to start. */
  onRepair?: () => void;
}

export interface StreamObjectRequest<T> extends ObjectRequest<T> {
  /** Called with all the text received so far, each time more arrives. */
  onText?: (text: string) => void;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the provider's prompt cache, when reported. */
  cachedInputTokens: number;
  /**
   * Input tokens written to the provider's prompt cache (Anthropic bills them above the normal
   * input rate). Absent for providers that don't charge for writes.
   */
  cacheWriteTokens?: number;
  /** Tokens spent on internal reasoning, when reported separately. */
  reasoningTokens: number;
}

export type StopReason = 'complete' | 'max_tokens' | 'refusal' | 'safety' | 'other';

/** How long a call took and how many requests it needed. */
export interface CallTiming {
  latencyMs: number;
  /** Streams only: time until the first piece of the answer arrived. */
  firstChunkMs: number | null;
  /** HTTP attempts, counting retries of rejected requests, when the adapter can tell. */
  attempts: number | null;
}

export interface LlmResult<T> {
  data: T;
  provider: LlmProviderName;
  model: string;
  usage: LlmUsage;
  timing?: CallTiming;
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
  /** Aborted at the call's deadline or on cancellation; adapters stop the request and retries. */
  signal?: AbortSignal;
  /** Limit for one attempt; adapters that can't apply it are still bounded by `signal`. */
  attemptTimeoutMs?: number;
  /** Retries of rejected requests inside the call (adapter default when absent). */
  retry?: RetryPolicy;
  /** Told about a failed attempt that will be retried (HTTP status, 0 for a network error). */
  onRetry?: (status: number) => void;
}

/** What an adapter could observe about the requests behind one call. */
export interface AttemptLog {
  attempts: number;
  /** Status of each failed attempt (0 for a network error), in order. */
  retryStatuses: number[];
}

export interface ProviderResponse {
  text: string;
  model: string;
  stopReason: StopReason;
  usage: LlmUsage;
  /** Present when the adapter tracks the HTTP attempts it made. */
  attempts?: AttemptLog;
}

/** A streamed call: yields pieces of the answer as they arrive, then returns the whole response. */
export type ProviderStream = AsyncGenerator<string, ProviderResponse, void>;

export interface LlmProvider {
  readonly name: LlmProviderName;
  generate(request: ProviderRequest): Promise<ProviderResponse>;
  /**
   * Optional: the same call, streamed. Without it the client makes a normal call and hands the
   * answer over in one piece, so nothing depends on a provider supporting streaming.
   */
  stream?(request: ProviderRequest): ProviderStream;
}

export type LlmErrorKind =
  | 'rate_limited'
  | 'unavailable'
  | 'auth'
  | 'invalid_request'
  | 'refusal'
  | 'safety_blocked'
  | 'truncated'
  | 'invalid_output'
  /** The call's deadline passed (every attempt and retry included). */
  | 'timeout'
  /** The caller cancelled the call. */
  | 'aborted';

const RETRYABLE: ReadonlySet<LlmErrorKind> = new Set(['rate_limited', 'unavailable', 'timeout']);

/**
 * The only error type that leaves the LLM layer. `retryable` tells background tasks whether a
 * later attempt can succeed (rate limits, outages) or the failure is permanent (bad credentials,
 * refusals, invalid requests) and should not be retried.
 */
export class LlmError extends Error {
  override readonly name = 'LlmError';
  readonly retryable: boolean;
  readonly status: number | undefined;
  /** The HTTP attempts behind the failure, when the adapter tracked them. */
  readonly attempts: AttemptLog | undefined;

  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly provider: LlmProviderName,
    options?: { cause?: unknown; status?: number; attempts?: AttemptLog },
  ) {
    super(message, { cause: options?.cause });
    this.retryable = RETRYABLE.has(kind);
    this.status = options?.status;
    this.attempts = options?.attempts;
  }
}
