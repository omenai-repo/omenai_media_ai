import Anthropic from '@anthropic-ai/sdk';
import type { BetaStopReason } from '@anthropic-ai/sdk/resources/beta/messages/messages';

import { adaptJsonSchema } from '../json-schema.js';
import {
  LlmError,
  type LlmProvider,
  type ProviderRequest,
  type ProviderResponse,
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

function stopReason(reason: BetaStopReason | null): StopReason {
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

function toLlmError(error: unknown): LlmError {
  const wrap = (kind: ConstructorParameters<typeof LlmError>[0], status?: number) =>
    new LlmError(
      kind,
      `Anthropic API error${status ? ` ${status}` : ''}: ${String(error)}`,
      'anthropic',
      {
        cause: error,
        status,
      },
    );

  if (error instanceof Anthropic.RateLimitError) return wrap('rate_limited', 429);
  if (error instanceof Anthropic.AuthenticationError) return wrap('auth', 401);
  if (error instanceof Anthropic.PermissionDeniedError) return wrap('auth', 403);
  if (error instanceof Anthropic.APIConnectionError) return wrap('unavailable');
  if (error instanceof Anthropic.APIError) {
    const status: number = typeof error.status === 'number' ? error.status : 0;
    // 5xx, including 529 "overloaded", is transient.
    return wrap(status >= 500 ? 'unavailable' : 'invalid_request', status);
  }
  return wrap('unavailable');
}

export function createAnthropicProvider(options: {
  apiKey: string;
  /** Quick SDK-level retries for transient errors; task-level retries handle longer outages. */
  maxRetries?: number;
}): LlmProvider {
  const client = new Anthropic({ apiKey: options.apiKey, maxRetries: options.maxRetries ?? 2 });

  return {
    name: 'anthropic',
    async generate(request: ProviderRequest): Promise<ProviderResponse> {
      const useFallback = REFUSAL_FALLBACK_MODELS.test(request.model);
      let message;
      try {
        message = await client.beta.messages.create({
          model: request.model,
          max_tokens: request.maxOutputTokens,
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
        });
      } catch (error) {
        throw toLlmError(error);
      }

      const text = message.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('');

      return {
        text,
        model: message.model,
        stopReason: stopReason(message.stop_reason),
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          cachedInputTokens: message.usage.cache_read_input_tokens ?? 0,
          reasoningTokens: message.usage.output_tokens_details?.thinking_tokens ?? 0,
        },
      };
    },
  };
}
