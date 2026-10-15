import { ApiError, FinishReason, GoogleGenAI, ThinkingLevel } from '@google/genai';

import { adaptJsonSchema } from '../json-schema.js';
import {
  LlmError,
  type Effort,
  type LlmProvider,
  type ProviderRequest,
  type ProviderResponse,
  type StopReason,
} from '../types.js';

/**
 * Keywords `responseJsonSchema` accepts (per the @google/genai 2.30 type docs). Notably absent:
 * `minLength`, `maxLength`, `pattern`, `const`, exclusive bounds.
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
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'anyOf',
  'oneOf',
  'properties',
  'additionalProperties',
  'required',
  'propertyOrdering',
]);

/** Gemini has no `const`; a single-value enum is equivalent. */
function rewriteConst(node: Record<string, unknown>): Record<string, unknown> {
  if ('const' in node) {
    const { const: value, ...rest } = node;
    return { ...rest, enum: [value] };
  }
  return node;
}

export function toGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return adaptJsonSchema(schema, GEMINI_SCHEMA_KEYWORDS, rewriteConst);
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
  if (reason === FinishReason.MAX_TOKENS) return 'max_tokens';
  if (SAFETY_REASONS.has(reason)) return 'safety';
  return 'other';
}

function toLlmError(error: unknown): LlmError {
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
    });
  }
  // Network failures surface as plain errors from fetch.
  return new LlmError('unavailable', `Gemini request failed: ${String(error)}`, 'gemini', {
    cause: error,
  });
}

export function createGeminiProvider(options: { apiKey: string }): LlmProvider {
  const client = new GoogleGenAI({ apiKey: options.apiKey });

  return {
    name: 'gemini',
    async generate(request: ProviderRequest): Promise<ProviderResponse> {
      let response;
      try {
        response = await client.models.generateContent({
          model: request.model,
          contents: request.messages.map((message) => ({
            role: message.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: message.content }],
          })),
          config: {
            systemInstruction: request.system,
            maxOutputTokens: request.maxOutputTokens + THINKING_HEADROOM[request.effort],
            thinkingConfig: { thinkingLevel: THINKING_LEVEL[request.effort] },
            ...(request.jsonSchema
              ? {
                  responseMimeType: 'application/json',
                  responseJsonSchema: toGeminiSchema(request.jsonSchema),
                }
              : {}),
          },
        });
      } catch (error) {
        throw toLlmError(error);
      }

      if (response.promptFeedback?.blockReason) {
        throw new LlmError(
          'safety_blocked',
          `Gemini blocked the prompt (${response.promptFeedback.blockReason}).`,
          'gemini',
        );
      }

      const usage = response.usageMetadata;
      return {
        text: response.text ?? '',
        model: response.modelVersion ?? request.model,
        stopReason: stopReason(response.candidates?.[0]?.finishReason),
        usage: {
          inputTokens: usage?.promptTokenCount ?? 0,
          outputTokens: usage?.candidatesTokenCount ?? 0,
          cachedInputTokens: usage?.cachedContentTokenCount ?? 0,
          reasoningTokens: usage?.thoughtsTokenCount ?? 0,
        },
      };
    },
  };
}
