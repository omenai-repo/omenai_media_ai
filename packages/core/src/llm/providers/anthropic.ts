import Anthropic from '@anthropic-ai/sdk';
import type { Middleware } from '@anthropic-ai/sdk';
import type {
  BetaMessageDeltaUsage,
  BetaStopReason,
  BetaUsage,
  MessageCreateParamsBase,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';

import { adaptJsonSchema } from '../json-schema.js';
import {
  LlmError,
  type AttemptLog,
  type Effort,
  type LlmProvider,
  type LlmUsage,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderStream,
  type StopReason,
} from '../types.js';

/**
 * Keywords Claude structured outputs accept. Numeric, string-length and array-size constraints
 * are not supported, and every object must set `additionalProperties: false`.
 */
const ANTHROPIC_SCHEMA_KEYWORDS = new Set([
  '$defs',
  '$ref',
  'type',
  'format',
  'title',
  'description',
  'enum',
  'const',
  'items',
  'anyOf',
  'allOf',
  'properties',
  'required',
  'additionalProperties',
]);

const SUPPORTED_FORMATS = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'uri',
  'ipv4',
  'ipv6',
  'uuid',
]);

function closeObjects(node: Record<string, unknown>): Record<string, unknown> {
  const out = { ...node };
  if (out.type === 'object' || 'properties' in out) out.additionalProperties = false;
  if (typeof out.format === 'string' && !SUPPORTED_FORMATS.has(out.format)) delete out.format;
  return out;
}

export function toAnthropicSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return adaptJsonSchema(schema, ANTHROPIC_SCHEMA_KEYWORDS, closeObjects);
}

/**
 * Models that support server-side refusal fallbacks (`fallbacks: 'default'`): if a safety
 * classifier declines, the API reruns the request on a suitable model within the same call.
 * Haiku has no server-side fallback.
 */
const REFUSAL_FALLBACK_MODELS = /^claude-(opus-5|opus-5-5|sonnet-5-5|fable-5-1)$/;
const REFUSAL_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * The tier models (Haiku, Sonnet and Opus 5.5) think adaptively by default, and `max_tokens`
 * caps thinking and the answer together. Callers size `maxOutputTokens` for the visible answer,
 * so without headroom a long think truncates the JSON (the Gemini adapter adds the same).
 */
const THINKING_HEADROOM: Record<Effort, number> = { low: 1_024, medium: 4_096, high: 8_192 };

/** The SDK's own default; callers pass a tighter policy where they need one (the chat does). */
const DEFAULT_ATTEMPTS = 3;

/** Statuses the SDK retries (its documented defaults), to tell the caller "retrying". */
function isRetriedStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function stopReason(reason: BetaStopReason | null | undefined): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'complete';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

function usageOf(usage: BetaUsage | BetaMessageDeltaUsage | null | undefined): LlmUsage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cachedInputTokens: usage?.cache_read_input_tokens ?? 0,
    reasoningTokens: usage?.output_tokens_details?.thinking_tokens ?? 0,
  };
}

function toLlmError(error: unknown, attempts?: AttemptLog): LlmError {
  if (error instanceof LlmError) return error;
  const wrap = (kind: ConstructorParameters<typeof LlmError>[0], status?: number) =>
    new LlmError(
      kind,
      `Anthropic API error${status ? ` ${status}` : ''}: ${String(error)}`,
      'anthropic',
      { cause: error, status, attempts },
    );

  // Before APIError: an abort is an APIError subclass with no status. The client decides
  // whether its own deadline or a cancellation caused it.
  if (error instanceof Anthropic.APIUserAbortError) return wrap('aborted');
  if (error instanceof Anthropic.RateLimitError) return wrap('rate_limited', 429);
  if (error instanceof Anthropic.AuthenticationError) return wrap('auth', 401);
  if (error instanceof Anthropic.PermissionDeniedError) return wrap('auth', 403);
  if (error instanceof Anthropic.APIConnectionError) return wrap('unavailable');
  if (error instanceof Anthropic.APIError) {
    const status: number = typeof error.status === 'number' ? error.status : 0;
    // 5xx, including 529 "overloaded", is transient. A mid-stream `overloaded_error` event
    // arrives without an HTTP status; it is transient too.
    const overloaded = status === 0 && /overloaded/i.test(String(error.message));
    return wrap(
      status >= 500 || overloaded ? 'unavailable' : 'invalid_request',
      status || undefined,
    );
  }
  return wrap('unavailable');
}

/**
 * Per-request SDK middleware that counts HTTP attempts and remembers the status of each failed
 * one. It runs once per attempt, inside the SDK's retry loop, so retries inside a call are
 * recorded instead of invisible.
 */
function attemptTracker(maxAttempts: number, onRetry?: (status: number) => void) {
  const log: AttemptLog = { attempts: 0, retryStatuses: [] };
  const middleware: Middleware = async (request, next) => {
    log.attempts += 1;
    let response: Response;
    try {
      response = await next(request);
    } catch (error) {
      log.retryStatuses.push(0);
      if (!request.signal?.aborted && log.attempts < maxAttempts) onRetry?.(0);
      throw error;
    }
    if (!response.ok) {
      log.retryStatuses.push(response.status);
      if (isRetriedStatus(response.status) && log.attempts < maxAttempts)
        onRetry?.(response.status);
    }
    return response;
  };
  return { log, middleware };
}

export function createAnthropicProvider(options: {
  apiKey: string;
  /** Quick SDK-level retries for transient errors; task-level retries handle longer outages. */
  maxRetries?: number;
}): LlmProvider {
  const client = new Anthropic({ apiKey: options.apiKey, maxRetries: options.maxRetries ?? 2 });

  function params(request: ProviderRequest): MessageCreateParamsBase {
    const useFallback = REFUSAL_FALLBACK_MODELS.test(request.model);
    return {
      model: request.model,
      max_tokens: request.maxOutputTokens + THINKING_HEADROOM[request.effort],
      // The system prompt is identical across calls of an operation, so cache it.
      system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      output_config: {
        effort: request.effort,
        ...(request.jsonSchema
          ? { format: { type: 'json_schema', schema: toAnthropicSchema(request.jsonSchema) } }
          : {}),
      },
      ...(useFallback ? { betas: [REFUSAL_FALLBACK_BETA], fallbacks: 'default' as const } : {}),
    };
  }

  /** The call's own bounds, passed to the SDK so a deadline or cancellation stops the request. */
  function requestOptions(request: ProviderRequest) {
    const attempts =
      request.retry?.attempts ??
      (options.maxRetries === undefined ? DEFAULT_ATTEMPTS : options.maxRetries + 1);
    const tracker = attemptTracker(attempts, request.onRetry);
    return {
      tracker,
      options: {
        maxRetries: attempts - 1,
        ...(request.attemptTimeoutMs ? { timeout: request.attemptTimeoutMs } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
        middleware: [tracker.middleware],
      },
    };
  }

  return {
    name: 'anthropic',

    async generate(request: ProviderRequest): Promise<ProviderResponse> {
      const { tracker, options: sdkOptions } = requestOptions(request);
      let message;
      try {
        message = await client.beta.messages.create(
          { ...params(request), stream: false },
          sdkOptions,
        );
      } catch (error) {
        throw toLlmError(error, tracker.log);
      }

      const text = message.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('');

      return {
        text,
        model: message.model,
        stopReason: stopReason(message.stop_reason),
        usage: usageOf(message.usage),
        attempts: tracker.log,
      };
    },

    async *stream(request: ProviderRequest): ProviderStream {
      const { tracker, options: sdkOptions } = requestOptions(request);
      let text = '';
      let model = request.model;
      let finish: BetaStopReason | null = null;
      let usage = usageOf(null);
      let events;
      try {
        events = await client.beta.messages.create(
          { ...params(request), stream: true },
          sdkOptions,
        );
      } catch (error) {
        throw toLlmError(error, tracker.log);
      }
      let completed = false;
      try {
        for await (const event of events) {
          if (event.type === 'message_start') {
            model = event.message.model;
            usage = usageOf(event.message.usage);
          } else if (event.type === 'message_delta') {
            finish = event.delta.stop_reason ?? finish;
            // Output counts are cumulative; input counts, when repeated, are the final ones.
            const delta = usageOf(event.usage);
            usage = {
              inputTokens: event.usage.input_tokens ?? usage.inputTokens,
              outputTokens: delta.outputTokens,
              cachedInputTokens: event.usage.cache_read_input_tokens ?? usage.cachedInputTokens,
              reasoningTokens: delta.reasoningTokens || usage.reasoningTokens,
            };
          } else if (
            event.type === 'content_block_delta' &&
            event.delta.type === 'text_delta' &&
            event.delta.text
          ) {
            // Thinking deltas are never passed on; only the visible answer is.
            text += event.delta.text;
            yield event.delta.text;
          }
        }
        completed = true;
      } catch (error) {
        throw toLlmError(error, tracker.log);
      } finally {
        // Leaving early (deadline, cancellation, a consumer that stops reading) ends the request.
        if (!completed) events.controller.abort();
      }
      return { text, model, stopReason: stopReason(finish), usage, attempts: tracker.log };
    },
  };
}
