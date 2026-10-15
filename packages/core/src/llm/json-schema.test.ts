import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import { toNeutralJsonSchema } from './json-schema.js';
import { toAnthropicSchema } from './providers/anthropic.js';
import { toGeminiSchema } from './providers/gemini.js';

const schema = z.object({
  headline: z.string().min(5).max(140),
  score: z.number().int().min(0).max(5),
  kind: z.literal('story'),
  tags: z.array(z.enum(['heritage', 'craft'])).max(3),
  source: z.object({ url: z.url(), note: z.string().nullable() }),
});

type Node = Record<string, unknown>;
const prop = (s: Node, name: string) => (s.properties as Record<string, Node>)[name]!;

describe('provider schema adaptation', () => {
  const neutral = toNeutralJsonSchema(schema);

  it('produces draft 2020-12 JSON Schema without the $schema marker', () => {
    expect(neutral.$schema).toBeUndefined();
    expect(neutral.type).toBe('object');
  });

  it('Gemini: keeps numeric/array bounds, drops string-length limits into the description', () => {
    const gemini = toGeminiSchema(neutral);
    expect(prop(gemini, 'score')).toMatchObject({ minimum: 0, maximum: 5 });
    expect(prop(gemini, 'tags')).toMatchObject({ maxItems: 3 });
    expect(prop(gemini, 'headline').minLength).toBeUndefined();
    expect(prop(gemini, 'headline').description).toContain('min length 5');
    // No `const` support: rewritten as a single-value enum.
    expect(prop(gemini, 'kind')).toMatchObject({ enum: ['story'] });
    expect(prop(gemini, 'kind').const).toBeUndefined();
  });

  it('Anthropic: closes every object and drops unsupported constraints into descriptions', () => {
    const anthropic = toAnthropicSchema(neutral);
    expect(anthropic.additionalProperties).toBe(false);
    expect(prop(anthropic, 'source').additionalProperties).toBe(false);
    expect(prop(anthropic, 'score').minimum).toBeUndefined();
    expect(prop(anthropic, 'score').description).toContain('minimum 0');
    expect(prop(anthropic, 'tags').maxItems).toBeUndefined();
    expect(prop(anthropic, 'kind').const).toBe('story');
  });

  it('never mutates the neutral schema', () => {
    const before = JSON.stringify(neutral);
    toGeminiSchema(neutral);
    toAnthropicSchema(neutral);
    expect(JSON.stringify(neutral)).toBe(before);
  });
});
