/**
 * Live check against the configured provider. Skipped unless LLM_LIVE_TESTS=1, because it spends
 * real quota. Run before switching providers:
 *
 *   LLM_LIVE_TESTS=1 node --env-file=../../apps/worker/.env node_modules/vitest/vitest.mjs run src/llm/live.test.ts
 */
import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import { getLlmClient } from './client.js';
import type { LlmUsageRecord } from './usage.js';

const live = process.env.LLM_LIVE_TESTS === '1';

// Shaped like the real evaluation output: enums, bounded integers, nested objects, nullable fields.
const evaluation = z.object({
  primaryPillar: z.enum([
    'art_creative_expression',
    'fashion_design_objects',
    'film_music_performance',
    'places_architecture_living',
    'people_influence_institutions',
    'ideas_history_cultural_change',
  ]),
  geography: z.object({ country: z.string().min(2), city: z.string().nullable() }),
  scores: z.array(
    z.object({
      dimension: z.enum(['cultural_significance', 'timeliness']),
      score: z.number().int().min(0).max(5),
      rationale: z.string().min(10),
    }),
  ),
  whyItMatters: z.string().min(20),
});

describe.skipIf(!live)('live provider check', () => {
  it('returns schema-valid structured output and usage', async () => {
    const llm = getLlmClient();
    const records: LlmUsageRecord[] = [];
    // Use the configured provider but capture usage locally instead of writing to MongoDB.
    const { createLlmClient } = await import('./client.js');
    const { readLlmConfig } = await import('./config.js');
    const config = readLlmConfig();
    const providerModule =
      config.provider === 'anthropic'
        ? (await import('./providers/anthropic.js')).createAnthropicProvider({
            apiKey: config.apiKey,
          })
        : (await import('./providers/gemini.js')).createGeminiProvider({ apiKey: config.apiKey });
    const client = createLlmClient({
      provider: providerModule,
      models: config.models,
      recordUsage: (r) => {
        records.push(r);
        return Promise.resolve();
      },
    });

    const result = await client.generateObject({
      operation: 'live.evaluate',
      tier: 'primary',
      system:
        'You assess contemporary culture stories for Omenai. Score cultural_significance and timeliness from 0 to 5 with specific rationales.',
      messages: [
        {
          role: 'user',
          content:
            'Story: Zeitz MOCAA in Cape Town opens the first major retrospective of a Ghanaian sculptor who works with reclaimed bottle caps.',
        },
      ],
      maxOutputTokens: 1_500,
      schema: evaluation,
    });

    expect(llm.provider).toBe(config.provider);
    expect(result.data.scores.length).toBeGreaterThan(0);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(records.every((r) => r.outcome === 'ok')).toBe(true);
    console.info(
      `[live] ${result.provider}/${result.model}: ${JSON.stringify(result.data.primaryPillar)}, usage ${JSON.stringify(result.usage)}, calls ${records.length}`,
    );
  }, 120_000);
});
