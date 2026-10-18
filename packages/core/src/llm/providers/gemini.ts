import {
  ApiError,
  FinishReason,
  GoogleGenAI,
  ThinkingLevel,
  type GenerateContentConfig,
  type GenerateContentResponse,
  type HttpRetryOptions,
} from '@google/genai';

import { adaptJsonSchema } from '../json-schema.js';
import {
  LlmError,
  type AttemptLog,
  type Effort,
  type LlmProvider,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderStream,
  type RetryPolicy,
  type StopReason,
} from '../types.js';

/**
 * Keywords we send in `responseJsonSchema`. Gemini documents a subset (no `minLength`,
 * `maxLength`, `pattern` or `const`), and in practice it also rejects large schemas with a bare
 * 400 INVALID_ARGUMENT. Our 9.6k-character evaluation schema with 130 enum values, numeric
 * ranges and array bounds failed live on 2026-10-15 while smaller schemas passed. Community
 * reports point to a constrained-decoding "state" budget (about 120 enum values; numeric and
 * array bounds add states). So bounds also go into descriptions, and large enums are described
 * rather than enforced. The client still validates the full Zod contract (with one repair round).
 */
const GEMINI_SCHEMA_KEYWORDS = new Set([
  '$id',
  '$defs',
  '$ref',
  '$anchor',
  'type',
  'format',
  'title',
  'description',
  'enum',
  'items',
  'prefixItems',
  'anyOf',
  'oneOf',
  'properties',
  'additionalProperties',
  'required',
  'propertyOrdering',
]);

/** Enums longer than this are listed in the description instead of being enforced natively. */
export const GEMINI_MAX_NATIVE_ENUM = 20;

function geminiNode(node: Record<string, unknown>): Record<string, unknown> {
  let out = node;
  // No `const`: a single-value enum is equivalent.
  if ('const' in out) {
    const { const: value, ...rest } = out;
    out = { ...rest, enum: [value] };
  }
  if (Array.isArray(out.enum) && out.enum.length > GEMINI_MAX_NATIVE_ENUM) {
    const { enum: values, ...rest } = out;
    const allowed = `Allowed values: ${(values as unknown[]).join(', ')}.`;
    out = {
      ...rest,
      description:
        typeof rest.description === 'string' ? `${rest.description} ${allowed}` : allowed,
    };
  }
  return out;
}

export function toGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return adaptJsonSchema(schema, GEMINI_SCHEMA_KEYWORDS, geminiNode);
}

const THINKING_LEVEL: Record<Effort, ThinkingLevel> = {
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

/**
 * Gemini counts reasoning tokens against `maxOutputTokens`, so without headroom a long think can
 * truncate the JSON answer. These budgets are added on top of the caller's answer budget.
 */
const THINKING_HEADROOM: Record<Effort, number> = { low: 1_024, medium: 4_096, high: 8_192 };

const SAFETY_REASONS = new Set<FinishReason | undefined>([
  FinishReason.SAFETY,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.BLOCKLIST,
  FinishReason.SPII,
  FinishReason.RECITATION,
]);

function stopReason(reason: FinishReason | undefined): StopReason {
  if (reason === FinishReason.STOP) return 'complete';
  // With automatic continuation off, CONTINUATION means the answer is incomplete: treat it as
  // cut short, never as a finished answer.
  if (reason === FinishReason.MAX_TOKENS || reason === FinishReason.CONTINUATION)
    return 'max_tokens';
  if (SAFETY_REASONS.has(reason)) return 'safety';
  return 'other';
}

function toLlmError(error: unknown, attempts?: AttemptLog): LlmError {
  if (error instanceof LlmError) return error;
  if (error instanceof ApiError) {
    const { status } = error;
    const kind =
      status === 429
        ? 'rate_limited'
        : status >= 500
          ? 'unavailable'
          : status === 401 || status === 403
            ? 'auth'
            : 'invalid_request';
    return new LlmError(kind, `Gemini API error ${status}: ${error.message}`, 'gemini', {
      cause: error,
      status,
      attempts,
    });
  }
  // Network failures surface as plain errors from fetch; a cancelled request as an AbortError
  // (the client decides whether that was its deadline or a cancellation).
  return new LlmError('unavailable', `Gemini request failed: ${String(error)}`, 'gemini', {
    cause: error,
    attempts,
  });
}

/**
 * Quick retries for momentary overload ("high demand" 503s) and rate limits (429), inside one
 * call: a rejected request isn't billed, and without this a few seconds' spike fails a whole
 * background attempt. Bounded to about 15 seconds; longer outages are left to task retries.
 * (Observed live on 2026-10-16: three consecutive 503s from gemini-3.8-flash failed a run.)
 * Callers can pass a tighter `retry` policy (the chat does), and the client's deadline bounds
 * every attempt and delay either way.
 */
export const GEMINI_RETRY = { attempts: 4, initialDelay: 2, maxDelay: 10, expBase: 2 } as const;

/** Statuses the SDK retries (its documented defaults); used to tell the caller "retrying". */
const RETRIED_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function retryOptions(
  policy: RetryPolicy | undefined,
  attempts: number | undefined,
): HttpRetryOptions {
  if (policy)
    return {
      attempts: attempts ?? policy.attempts,
      initialDelay: policy.initialDelayMs / 1000,
      maxDelay: policy.maxDelayMs / 1000,
      expBase: 2,
    };
  return { ...GEMINI_RETRY, attempts: attempts ?? GEMINI_RETRY.attempts };
}

/**
 * A fetch for one call that counts its HTTP attempts and remembers the status of each failed
 * one, so retries inside a call are recorded instead of invisible (they were before 2026-10-16).
 * It looks `fetch` up on every request, so tests can stub it.
 */
function attemptTracker(maxAttempts: number, onRetry?: (status: number) => void) {
  const log: AttemptLog = { attempts: 0, retryStatuses: [] };
  const trackedFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    log.attempts += 1;
    let response: Response;
    try {
      response = await globalThis.fetch(input, init);
    } catch (error) {
      log.retryStatuses.push(0);
      if (!init?.signal?.aborted && log.attempts < maxAttempts) onRetry?.(0);
      throw error;
    }
    if (!response.ok) {
      log.retryStatuses.push(response.status);
      if (RETRIED_STATUSES.has(response.status) && log.attempts < maxAttempts)
        onRetry?.(response.status);
    }
    return response;
  };
  return { log, trackedFetch };
}

function usageOf(response: GenerateContentResponse | undefined) {
  const usage = response?.usageMetadata;
  return {
    inputTokens: usage?.promptTokenCount ?? 0,
    outputTokens: usage?.candidatesTokenCount ?? 0,
    cachedInputTokens: usage?.cachedContentTokenCount ?? 0,
    reasoningTokens: usage?.thoughtsTokenCount ?? 0,
  };
}

export function createGeminiProvider(options: {
  apiKey: string;
  /** Override the number of attempts (1 turns the quick retries off). */
  retries?: number;
}): LlmProvider {
  const client = new GoogleGenAI({
    apiKey: options.apiKey,
    httpOptions: { retryOptions: retryOptions(undefined, options.retries) },
  });

  function request(provider: ProviderRequest, trackedFetch: typeof fetch, streamed: boolean) {
    const retry = retryOptions(provider.retry, options.retries);
    const config: GenerateContentConfig = {
      systemInstruction: provider.system,
      maxOutputTokens: provider.maxOutputTokens + THINKING_HEADROOM[provider.effort],
      thinkingConfig: { thinkingLevel: THINKING_LEVEL[provider.effort] },
      ...(provider.jsonSchema
        ? {
            responseMimeType: 'application/json',
            responseJsonSchema: toGeminiSchema(provider.jsonSchema),
          }
        : {}),
      abortSignal: provider.signal,
      httpOptions: {
        retryOptions: retry,
        fetch: trackedFetch,
        ...(provider.attemptTimeoutMs ? { timeout: provider.attemptTimeoutMs } : {}),
      },
      // A stream that resumed after a drop could hand back text already shown; a stream either
      // completes or fails, and the caller decides what to do.
      ...(streamed ? { automaticContinuation: false } : {}),
    };
    return {
      model: provider.model,
      contents: provider.messages.map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
      })),
      config,
      attempts: retry.attempts ?? GEMINI_RETRY.attempts,
    };
  }

  return {
    name: 'gemini',

    async generate(provider: ProviderRequest): Promise<ProviderResponse> {
      const tracker = attemptTracker(
        retryOptions(provider.retry, options.retries).attempts ?? GEMINI_RETRY.attempts,
        provider.onRetry,
      );
      const { attempts: _attempts, ...params } = request(provider, tracker.trackedFetch, false);
      let response: GenerateContentResponse;
      try {
        response = await client.models.generateContent(params);
      } catch (error) {
        throw toLlmError(error, tracker.log);
      }

      if (response.promptFeedback?.blockReason) {
        throw new LlmError(
          'safety_blocked',
          `Gemini blocked the prompt (${response.promptFeedback.blockReason}).`,
          'gemini',
          { attempts: tracker.log },
        );
      }

      return {
        text: response.text ?? '',
        model: response.modelVersion ?? provider.model,
        stopReason: stopReason(response.candidates?.[0]?.finishReason),
        usage: usageOf(response),
        attempts: tracker.log,
      };
    },

    async *stream(provider: ProviderRequest): ProviderStream {
      const tracker = attemptTracker(
        retryOptions(provider.retry, options.retries).attempts ?? GEMINI_RETRY.attempts,
        provider.onRetry,
      );
      const { attempts: _attempts, ...params } = request(provider, tracker.trackedFetch, true);
      let text = '';
      let last: GenerateContentResponse | undefined;
      let finish: FinishReason | undefined;
      try {
        const chunks = await client.models.generateContentStream(params);
        for await (const chunk of chunks) {
          if (chunk.promptFeedback?.blockReason)
            throw new LlmError(
              'safety_blocked',
              `Gemini blocked the prompt (${chunk.promptFeedback.blockReason}).`,
              'gemini',
              { attempts: tracker.log },
            );
          if (chunk.usageMetadata) last = chunk;
          finish = chunk.candidates?.[0]?.finishReason ?? finish;
          // Thought parts are excluded from `text`; only the visible answer is passed on.
          const piece = chunk.text ?? '';
          if (piece) {
            text += piece;
            yield piece;
          }
        }
      } catch (error) {
        throw toLlmError(error, tracker.log);
      }
      return {
        text,
        model: last?.modelVersion ?? provider.model,
        stopReason: stopReason(finish),
        usage: usageOf(last),
        attempts: tracker.log,
      };
    },
  };
}
