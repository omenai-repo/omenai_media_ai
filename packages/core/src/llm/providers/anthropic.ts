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
  type LlmMessage,
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

/** Schema nodes (objects, arrays, values), the measure the grammar limit below is set in. */
export function grammarNodes(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((n: number, child) => n + grammarNodes(child), 0);
  if (!node || typeof node !== 'object') return 0;
  let count = 1;
  for (const [key, value] of Object.entries(node))
    if (key === 'properties' || key === '$defs')
      for (const child of Object.values(value as Record<string, unknown>))
        count += grammarNodes(child);
    else if (key === 'items' || key === 'anyOf' || key === 'allOf') count += grammarNodes(value);
  return count;
}

/**
 * Anthropic compiles a response schema into a decoding grammar and refuses one that is too large
 * ("The compiled grammar is too large", 400), at a size it doesn't publish. Probed 2026-10-22
 * (ADR-046): every schema up to 45 nodes compiled (the research brief, triage, a flat object of
 * 29 fields); every form of the assessment from 86 to 113 nodes was refused, with its large enums
 * described, its scores as an array, or regrouped so no object had more than eight fields. A
 * schema over this limit is therefore sent without the grammar: it goes in the system prompt,
 * and the client validates the answer against the full contract as always (one repair round).
 */
export const ANTHROPIC_MAX_GRAMMAR_NODES = 50;

/** Anthropic's 400 for a schema it can't compile; the wording is all that sets it apart. */
const SCHEMA_REJECTED = /compiled grammar is too large|too complex for compilation/i;

/** The instruction that carries a schema too large for the grammar. Stable per schema (cached). */
export function schemaInstruction(schema: Record<string, unknown>): string {
  return `RESPONSE FORMAT: reply with one JSON object and nothing else: no prose before or after it, no Markdown code fence. It must conform to this JSON Schema, including every required field, each field's type, the allowed values listed for it, and the lengths and counts given in descriptions:\n${JSON.stringify(schema)}`;
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

/** Anthropic allows four cache breakpoints per request; the system prompt always uses one. */
const MAX_MESSAGE_BREAKPOINTS = 3;

/**
 * A message with a cacheable prefix becomes two text blocks, the first marked for the prompt
 * cache. The text is unchanged: the blocks join back into the same content. Only the last few
 * marked messages keep their marker, within Anthropic's breakpoint limit.
 */
export function toAnthropicMessages(
  messages: ReadonlyArray<LlmMessage>,
): MessageCreateParamsBase['messages'] {
  const marked = messages
    .map((m, index) => ({ m, index }))
    .filter(({ m }) => {
      const n = m.cacheablePrefixLength ?? 0;
      return n > 0 && n <= m.content.length;
    })
    .slice(-MAX_MESSAGE_BREAKPOINTS)
    .map(({ index }) => index);
  return messages.map((m, index) => {
    if (!marked.includes(index)) return { role: m.role, content: m.content };
    const cut = m.cacheablePrefixLength!;
    const rest = m.content.slice(cut);
    return {
      role: m.role,
      content: [
        {
          type: 'text' as const,
          text: m.content.slice(0, cut),
          cache_control: { type: 'ephemeral' as const },
        },
        ...(rest ? [{ type: 'text' as const, text: rest }] : []),
      ],
    };
  });
}

/** The SDK's own default; callers pass a tighter policy where they need one (the chat does). */
const DEFAULT_ATTEMPTS = 3;

/** Statuses the SDK retries (its documented defaults), to tell the caller "retrying". */
function isRetriedStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function mergeLogs(a: AttemptLog, b: AttemptLog): AttemptLog {
  return {
    attempts: a.attempts + b.attempts,
    retryStatuses: [...a.retryStatuses, ...b.retryStatuses],
  };
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
    // Not part of input_tokens: Anthropic reports uncached, cache-read and cache-written input
    // separately, and bills writes above the input rate.
    cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
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
  if (error instanceof Anthropic.BadRequestError && SCHEMA_REJECTED.test(error.message))
    return wrap('schema_rejected', 400);
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

  /** Schemas this adapter was refused a grammar for, by content: never sent as a grammar again. */
  const refusedGrammars = new Set<string>();

  /**
   * How a request's schema is sent: as a decoding grammar when it fits, otherwise in the system
   * prompt (`instructed`). Either way the client validates the answer against the full contract.
   */
  function schemaMode(request: ProviderRequest) {
    if (!request.jsonSchema) return null;
    const schema = toAnthropicSchema(request.jsonSchema);
    const key = JSON.stringify(schema);
    const fits = grammarNodes(schema) <= ANTHROPIC_MAX_GRAMMAR_NODES && !refusedGrammars.has(key);
    return { schema, key, grammar: fits };
  }

  function params(
    request: ProviderRequest,
    mode: ReturnType<typeof schemaMode>,
  ): MessageCreateParamsBase {
    const useFallback = REFUSAL_FALLBACK_MODELS.test(request.model);
    const system =
      mode && !mode.grammar
        ? `${request.system}\n\n${schemaInstruction(mode.schema)}`
        : request.system;
    return {
      model: request.model,
      max_tokens: request.maxOutputTokens + THINKING_HEADROOM[request.effort],
      // The system prompt is identical across calls of an operation, so cache it.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: toAnthropicMessages(request.messages),
      output_config: {
        effort: request.effort,
        ...(mode?.grammar ? { format: { type: 'json_schema', schema: mode.schema } } : {}),
      },
      ...(useFallback ? { betas: [REFUSAL_FALLBACK_BETA], fallbacks: 'default' as const } : {}),
    };
  }

  /**
   * Sends the request; if Anthropic refuses to compile its schema, sends it once more with the
   * schema in the prompt instead (a materially different request), and never sends that grammar
   * again. Any other failure, or a refusal of the second request, is the caller's.
   */
  async function send<T>(
    request: ProviderRequest,
    create: (
      body: MessageCreateParamsBase,
      sdkOptions: ReturnType<typeof requestOptions>['options'],
    ) => Promise<T>,
  ): Promise<{ result: T; log: AttemptLog }> {
    const mode = schemaMode(request);
    const first = requestOptions(request);
    try {
      return { result: await create(params(request, mode), first.options), log: first.tracker.log };
    } catch (error) {
      const failure = toLlmError(error, first.tracker.log);
      if (!(failure.kind === 'schema_rejected' && mode?.grammar)) throw failure;
      refusedGrammars.add(mode.key);
      const second = requestOptions(request);
      try {
        const result = await create(params(request, { ...mode, grammar: false }), second.options);
        return { result, log: mergeLogs(first.tracker.log, second.tracker.log) };
      } catch (retryError) {
        throw toLlmError(retryError, mergeLogs(first.tracker.log, second.tracker.log));
      }
    }
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
      const { result: message, log } = await send(request, (body, sdkOptions) =>
        client.beta.messages.create({ ...body, stream: false }, sdkOptions),
      );

      const text = message.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('');

      return {
        text,
        model: message.model,
        stopReason: stopReason(message.stop_reason),
        usage: usageOf(message.usage),
        attempts: log,
      };
    },

    async *stream(request: ProviderRequest): ProviderStream {
      let text = '';
      let model = request.model;
      let finish: BetaStopReason | null = null;
      let usage = usageOf(null);
      const { result: events, log } = await send(request, (body, sdkOptions) =>
        client.beta.messages.create({ ...body, stream: true }, sdkOptions),
      );
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
              cacheWriteTokens:
                event.usage.cache_creation_input_tokens ?? usage.cacheWriteTokens ?? 0,
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
        throw toLlmError(error, log);
      } finally {
        // Leaving early (deadline, cancellation, a consumer that stops reading) ends the request.
        if (!completed) events.controller.abort();
      }
      return { text, model, stopReason: stopReason(finish), usage, attempts: log };
    },
  };
}
