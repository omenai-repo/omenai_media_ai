import * as z from 'zod';

import { readLlmConfig } from './config.js';
import { toNeutralJsonSchema } from './json-schema.js';
import { createAnthropicProvider } from './providers/anthropic.js';
import { createGeminiProvider } from './providers/gemini.js';
import {
  LlmError,
  type Effort,
  type LlmMessage,
  type LlmProvider,
  type LlmProviderName,
  type LlmResult,
  type ModelTier,
  type ObjectRequest,
  type ProviderRequest,
  type ProviderResponse,
  type TextRequest,
} from './types.js';
import { recordUsageInDatabase, type UsageRecorder } from './usage.js';

/** The interface every pipeline stage uses. It never exposes which provider is behind it. */
export interface LlmClient {
  readonly provider: LlmProviderName;
  modelFor(tier: ModelTier): string;
  /** Structured output, validated against `request.schema`. One bounded repair round. */
  generateObject<T>(request: ObjectRequest<T>): Promise<LlmResult<T>>;
  generateText(request: TextRequest): Promise<LlmResult<string>>;
}

const DEFAULT_EFFORT: Record<ModelTier, Effort> = {
  triage: 'low',
  primary: 'medium',
  escalation: 'high',
};

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

export function createLlmClient(options: {
  provider: LlmProvider;
  models: Record<ModelTier, string>;
  recordUsage?: UsageRecorder;
}): LlmClient {
  const { provider, models } = options;
  const recordUsage = options.recordUsage ?? recordUsageInDatabase;

  async function call(
    request: TextRequest,
    messages: LlmMessage[],
    jsonSchema?: Record<string, unknown>,
  ): Promise<ProviderResponse> {
    const model = models[request.tier];
    const providerRequest: ProviderRequest = {
      model,
      system: request.system,
      messages,
      maxOutputTokens: request.maxOutputTokens,
      effort: request.effort ?? DEFAULT_EFFORT[request.tier],
      jsonSchema,
    };
    const base = {
      provider: provider.name,
      tier: request.tier,
      operation: request.operation,
      context: request.context,
    };

    let response: ProviderResponse;
    try {
      response = await provider.generate(providerRequest);
    } catch (error) {
      const kind = error instanceof LlmError ? error.kind : 'unavailable';
      await recordUsage({
        ...base,
        model,
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 },
        outcome: 'error',
        errorKind: kind,
      });
      throw error;
    }

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
    });
    if (failure) throw failure;
    return response;
  }

  return {
    provider: provider.name,
    modelFor: (tier) => models[tier],

    async generateText(request) {
      const response = await call(request, request.messages);
      return {
        data: response.text,
        provider: provider.name,
        model: response.model,
        usage: response.usage,
      };
    },

    async generateObject<T>(request: ObjectRequest<T>): Promise<LlmResult<T>> {
      const jsonSchema = toNeutralJsonSchema(request.schema);
      let messages = request.messages;
      let lastProblem = '';

      // Attempt 1, then at most one repair round that shows the model its own mistake.
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const response = await call(request, messages, jsonSchema);
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
        `${request.operation}: output failed validation after a repair attempt.\n${lastProblem}`,
        provider.name,
      );
    },
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
    cached = createLlmClient({ provider, models: config.models });
  }
  return cached;
}

/** Test hook: forget the cached client so a changed environment takes effect. */
export function resetLlmClientForTesting(): void {
  cached = undefined;
}
