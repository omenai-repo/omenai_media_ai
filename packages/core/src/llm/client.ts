import * as z from 'zod';

import { readLlmConfig } from './config.js';
import { toNeutralJsonSchema } from './json-schema.js';
import { createAnthropicProvider } from './providers/anthropic.js';
import { createGeminiProvider } from './providers/gemini.js';
import {
  LlmError,
  type CallTiming,
  type Effort,
  type LlmMessage,
  type LlmProvider,
  type LlmProviderName,
  type LlmResult,
  type ModelTier,
  type ObjectRequest,
  type ProviderRequest,
  type ProviderResponse,
  type StreamObjectRequest,
  type TextRequest,
} from './types.js';
import { assertAiBudget } from '../ops/budget.js';
import { recordUsageInDatabase, type UsageRecorder } from './usage.js';

/**
 * The interface every pipeline stage uses. It never exposes which provider is behind it, so a
 * later router that sends different operations to different providers can implement it too.
 */
export interface LlmClient {
  readonly provider: LlmProviderName;
  modelFor(tier: ModelTier): string;
  /** Structured output, validated against `request.schema`. One bounded repair round. */
  generateObject<T>(request: ObjectRequest<T>): Promise<LlmResult<T>>;
  /**
   * The same, streamed: `onText` sees the raw text as it arrives (validation still happens on
   * the whole answer). A provider that can't stream hands the answer over in one piece.
   */
  streamObject<T>(request: StreamObjectRequest<T>): Promise<LlmResult<T>>;
  generateText(request: TextRequest): Promise<LlmResult<string>>;
}

const DEFAULT_EFFORT: Record<ModelTier, Effort> = {
  triage: 'low',
  primary: 'medium',
  escalation: 'high',
};

/**
 * Background calls (briefs, drafts, discovery) when the caller sets no budget. The slowest call
 * observed live took 132 s (a draft article, 2026-10-16), so one attempt may take 180 s and the
 * whole call, retries and repair included, 240 s. Before this there was no limit at all: the
 * SDK sets no client-side timeout, and one chat call once took 219 s.
 */
export const BACKGROUND_ATTEMPT_MS = 180_000;
export const BACKGROUND_CALL_MS = 240_000;
const DEFAULT_MIN_REPAIR_MS = 5_000;

/** Tolerates a Markdown code fence around JSON, which some models add despite instructions. */
function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return JSON.parse(fenced ? fenced[1]! : trimmed);
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 10)
    .map((issue) => `- ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}

/** Marks the reason a call's own abort signal fired, to tell a deadline from a cancellation. */
class DeadlineReached extends Error {}

/** Rejects as soon as `signal` aborts, with its reason. */
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason as Error);
    else signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
  });
}

interface CallOptions {
  deadlineAt: number;
  /** Streams the answer to this callback when the provider can. */
  onText?: (text: string) => void;
  /** Why this request is a repair round, for the usage record. */
  repairReason?: string;
}

export function createLlmClient(options: {
  provider: LlmProvider;
  models: Record<ModelTier, string>;
  recordUsage?: UsageRecorder;
  /** Runs before every provider request (and every repair round); throwing stops the call. */
  beforeCall?: () => Promise<void>;
}): LlmClient {
  const { provider, models } = options;
  const recordUsage = options.recordUsage ?? recordUsageInDatabase;

  /**
   * One provider request, hard-bounded by `deadlineAt`: the client stops waiting at that moment
   * even if the adapter or its SDK is still between retries, and aborts the request.
   */
  async function call(
    request: TextRequest,
    messages: LlmMessage[],
    jsonSchema: Record<string, unknown> | undefined,
    callOptions: CallOptions,
  ): Promise<{ response: ProviderResponse; timing: CallTiming }> {
    const model = models[request.tier];
    const base = {
      provider: provider.name,
      tier: request.tier,
      operation: request.operation,
      context: request.context,
    };
    const remaining = callOptions.deadlineAt - Date.now();
    if (request.signal?.aborted)
      throw new LlmError('aborted', `${request.operation}: cancelled.`, provider.name);
    if (remaining <= 0)
      throw new LlmError(
        'timeout',
        `${request.operation}: no time left for a request to the AI service.`,
        provider.name,
      );

    await options.beforeCall?.();

    const controller = new AbortController();
    const cancel = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(new DeadlineReached()), remaining);
    const providerRequest: ProviderRequest = {
      model,
      system: request.system,
      messages,
      maxOutputTokens: request.maxOutputTokens,
      effort: request.effort ?? DEFAULT_EFFORT[request.tier],
      jsonSchema,
      signal: controller.signal,
      attemptTimeoutMs: Math.min(request.attemptTimeoutMs ?? BACKGROUND_ATTEMPT_MS, remaining),
      retry: request.retry,
      onRetry: request.onRetry,
    };

    const started = performance.now();
    let firstChunkMs: number | null = null;
    const elapsed = () => Math.round(performance.now() - started);

    async function streamed(): Promise<ProviderResponse> {
      const stream = provider.stream!(providerRequest);
      let text = '';
      try {
        for (;;) {
          const next = await stream.next();
          // After a deadline or cancellation nothing more is passed on, even if the provider
          // keeps sending.
          if (controller.signal.aborted) throw controller.signal.reason as Error;
          if (next.done) return { ...next.value, text: next.value.text || text };
          firstChunkMs ??= elapsed();
          text += next.value;
          callOptions.onText?.(text);
        }
      } finally {
        // Stops the underlying request if we leave early (deadline, cancellation, error).
        void stream.return(undefined as never).catch(() => undefined);
      }
    }

    let response: ProviderResponse;
    try {
      const work =
        callOptions.onText && provider.stream
          ? streamed()
          : provider.generate(providerRequest).then((r) => {
              if (callOptions.onText && r.text) {
                firstChunkMs ??= elapsed();
                callOptions.onText(r.text);
              }
              return r;
            });
      // The provider may settle after we stop waiting; that must never surface as unhandled.
      work.catch(() => undefined);
      response = await Promise.race([work, untilAborted(controller.signal)]);
    } catch (error) {
      const reason: unknown = controller.signal.reason;
      const failure = !controller.signal.aborted
        ? error instanceof LlmError
          ? error
          : new LlmError('unavailable', `${request.operation}: ${String(error)}`, provider.name, {
              cause: error,
            })
        : reason instanceof DeadlineReached
          ? new LlmError(
              'timeout',
              `${request.operation}: the AI service didn't finish within ${Math.round(remaining / 1000)} s.`,
              provider.name,
              { cause: error },
            )
          : new LlmError('aborted', `${request.operation}: cancelled.`, provider.name, {
              cause: error,
            });
      const attempts = error instanceof LlmError ? error.attempts : undefined;
      await recordUsage({
        ...base,
        model,
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 },
        outcome: 'error',
        errorKind: failure.kind,
        latencyMs: elapsed(),
        firstChunkMs,
        attempts: attempts?.attempts ?? null,
        retryStatuses: attempts?.retryStatuses ?? [],
        repairReason: callOptions.repairReason ?? null,
      });
      throw failure;
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', cancel);
    }

    const timing: CallTiming = {
      latencyMs: elapsed(),
      firstChunkMs,
      attempts: response.attempts?.attempts ?? null,
    };
    const failure =
      response.stopReason === 'refusal'
        ? new LlmError('refusal', 'The model declined this request.', provider.name)
        : response.stopReason === 'safety'
          ? new LlmError('safety_blocked', 'The provider blocked the response.', provider.name)
          : response.stopReason === 'max_tokens'
            ? new LlmError(
                'truncated',
                `The response hit the ${request.maxOutputTokens}-token limit for ${request.operation}.`,
                provider.name,
              )
            : null;

    await recordUsage({
      ...base,
      model: response.model,
      usage: response.usage,
      outcome: failure ? 'error' : 'ok',
      errorKind: failure?.kind,
      latencyMs: timing.latencyMs,
      firstChunkMs,
      attempts: timing.attempts,
      retryStatuses: response.attempts?.retryStatuses ?? [],
      repairReason: callOptions.repairReason ?? null,
    });
    if (failure) throw failure;
    return { response, timing };
  }

  /**
   * Attempt 1 (streamed when asked), then at most one repair round that shows the model its own
   * mistake, if the deadline leaves time for it.
   */
  async function objectCall<T>(
    request: ObjectRequest<T> & Pick<StreamObjectRequest<T>, 'onText'>,
  ): Promise<LlmResult<T>> {
    const jsonSchema = toNeutralJsonSchema(request.schema);
    const deadlineAt = request.deadlineAt ?? Date.now() + BACKGROUND_CALL_MS;
    const minRepairMs = request.minRepairMs ?? DEFAULT_MIN_REPAIR_MS;
    let messages = request.messages;
    let lastProblem = '';
    let latencyMs = 0;
    let repairSkipped = false;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (attempt === 2 && deadlineAt - Date.now() < minRepairMs) {
        repairSkipped = true;
        break;
      }
      if (attempt === 2) request.onRepair?.();
      const { response, timing } = await call(request, messages, jsonSchema, {
        deadlineAt,
        onText: attempt === 1 ? request.onText : undefined,
        repairReason: attempt === 2 ? lastProblem.slice(0, 500) : undefined,
      });
      latencyMs += timing.latencyMs;
      let candidate: unknown;
      try {
        candidate = parseJson(response.text);
      } catch {
        lastProblem = 'The response was not valid JSON.';
        messages = [
          ...request.messages,
          { role: 'assistant', content: response.text },
          { role: 'user', content: `${lastProblem} Return only the corrected JSON object.` },
        ];
        continue;
      }

      const parsed = request.schema.safeParse(candidate);
      if (parsed.success) {
        return {
          data: parsed.data,
          provider: provider.name,
          model: response.model,
          usage: response.usage,
          timing: { ...timing, latencyMs },
        };
      }
      lastProblem = describeIssues(parsed.error);
      messages = [
        ...request.messages,
        { role: 'assistant', content: response.text },
        {
          role: 'user',
          content: `Your JSON did not match the required schema:\n${lastProblem}\nReturn only the corrected JSON object.`,
        },
      ];
    }

    throw new LlmError(
      'invalid_output',
      `${request.operation}: output failed validation ${repairSkipped ? 'and there was no time left for a repair' : 'after a repair attempt'}.\n${lastProblem}`,
      provider.name,
    );
  }

  return {
    provider: provider.name,
    modelFor: (tier) => models[tier],

    async generateText(request) {
      const { response, timing } = await call(request, request.messages, undefined, {
        deadlineAt: request.deadlineAt ?? Date.now() + BACKGROUND_CALL_MS,
      });
      return {
        data: response.text,
        provider: provider.name,
        model: response.model,
        usage: response.usage,
        timing,
      };
    },

    generateObject: (request) => objectCall(request),

    streamObject: (request) => objectCall({ ...request, onText: request.onText ?? (() => {}) }),
  };
}

let cached: LlmClient | undefined;

/** The process-wide client for the configured provider (`LLM_PROVIDER`). */
export function getLlmClient(): LlmClient {
  if (!cached) {
    const config = readLlmConfig();
    const provider =
      config.provider === 'anthropic'
        ? createAnthropicProvider({ apiKey: config.apiKey })
        : createGeminiProvider({ apiKey: config.apiKey });
    // Every real request passes the daily usage limit first (required in live development).
    cached = createLlmClient({
      provider,
      models: config.models,
      beforeCall: () => assertAiBudget(),
    });
  }
  return cached;
}

/** Test hook: forget the cached client so a changed environment takes effect. */
export function resetLlmClientForTesting(): void {
  cached = undefined;
}
