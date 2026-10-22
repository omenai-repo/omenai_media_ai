/**
 * The Anthropic structured-output path after the 2026-10-22 production incident (ADR-046): what
 * each production schema becomes on the wire, and how a refused schema, a cut-off answer and a
 * transient failure are each handled. Recorded-shape HTTP responses; no network, no credentials.
 * Proves request construction and error handling only, never what a real model compiles or writes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';

import {
  changeOutputSchema,
  clusterOutputSchema,
  evaluationOutputSchema,
  triageOutputSchema,
} from '../../discovery/schemas.js';
import { draftOutputSchema } from '../../drafts/schemas.js';
import {
  chatAnswerSchema,
  focusedAnswerOutputSchema,
  researchBriefOutputSchema,
} from '../../research/schemas.js';
import { isPermanentError, isRequestConfigurationError } from '../../tasks/errors.js';
import { createLlmClient } from '../client.js';
import { adaptJsonSchema, toNeutralJsonSchema } from '../json-schema.js';
import { LlmError } from '../types.js';
import type { LlmUsageRecord } from '../usage.js';
import {
  ANTHROPIC_MAX_GRAMMAR_NODES,
  createAnthropicProvider,
  grammarNodes,
  toAnthropicSchema,
} from './anthropic.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

type Node = Record<string, unknown>;

/** The counts Anthropic's published limits name: union-typed and optional parameters. */
function measure(schema: Node) {
  const m = { unions: 0, optional: 0 };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    const n = node as Node;
    if (n.properties) {
      const required = new Set((n.required as string[] | undefined) ?? []);
      for (const [key, child] of Object.entries(n.properties as Record<string, Node>)) {
        if (!required.has(key)) m.optional += 1;
        if (child.anyOf || Array.isArray(child.type)) m.unions += 1;
      }
    }
    for (const value of Object.values(n)) visit(value);
  };
  visit(schema);
  return m;
}

/** Each production schema, and whether it may be sent as a decoding grammar. */
const PRODUCTION_SCHEMAS = [
  ['discovery.triage', triageOutputSchema, true],
  ['discovery.revisit', changeOutputSchema, true],
  ['discovery.cluster', clusterOutputSchema, true],
  ['discovery.evaluate', evaluationOutputSchema, false],
  ['research.brief', researchBriefOutputSchema, true],
  ['research.focused', focusedAnswerOutputSchema, true],
  ['chat.reply', chatAnswerSchema, true],
  ['draft.generate', draftOutputSchema, true],
] as const;

describe('Anthropic schema sizes, for every production schema', () => {
  it.each(PRODUCTION_SCHEMAS)(
    '%s stays within the published limits, and goes as a grammar only if it fits',
    (_operation, schema, grammar) => {
      const wire = toAnthropicSchema(toNeutralJsonSchema(schema));
      const m = measure(wire);
      // Published: at most 16 union-typed and 24 optional parameters across a request's schemas.
      expect(m.unions).toBeLessThanOrEqual(16);
      expect(m.optional).toBeLessThanOrEqual(24);
      expect(grammarNodes(wire) <= ANTHROPIC_MAX_GRAMMAR_NODES).toBe(grammar);
    },
  );

  it('measures the schemas probed on 2026-10-22 as the limit assumes', () => {
    const nodes = (schema: z.ZodType) =>
      grammarNodes(toAnthropicSchema(toNeutralJsonSchema(schema)));
    // Compiled live: the research brief (45) and a flat object of 29 strings (30).
    expect(nodes(researchBriefOutputSchema)).toBe(45);
    expect(
      nodes(
        z.object(Object.fromEntries(Array.from({ length: 29 }, (_, i) => [`f${i}`, z.string()]))),
      ),
    ).toBe(30);
    // Refused live, in every form from 86 nodes up.
    expect(nodes(evaluationOutputSchema)).toBe(106);
    expect(nodes(evaluationOutputSchema)).toBeGreaterThan(ANTHROPIC_MAX_GRAMMAR_NODES);
  });

  it('sends the schemas that compiled in production exactly as before', () => {
    const before = (schema: Node) =>
      adaptJsonSchema(
        schema,
        new Set([
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
        ]),
        (node) =>
          node.type === 'object' || 'properties' in node
            ? { ...node, additionalProperties: false }
            : node,
      );
    for (const schema of [triageOutputSchema, clusterOutputSchema, researchBriefOutputSchema]) {
      const neutral = toNeutralJsonSchema(schema);
      expect(toAnthropicSchema(neutral)).toEqual(before(neutral));
    }
  });
});

const GRAMMAR_400 = {
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message:
      'The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools.',
  },
  request_id: 'req_test',
};

function respond(responses: Array<() => Response>) {
  const calls: Array<{ url: string; body: Node }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({
        url,
        body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Node,
      });
      return Promise.resolve(responses[Math.min(calls.length - 1, responses.length - 1)]!());
    }),
  );
  return calls;
}
const json =
  (status: number, payload: unknown, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
const message = (text: string, stop = 'end_turn') => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5-5',
  content: [{ type: 'text', text }],
  stop_reason: stop,
  usage: { input_tokens: 10, output_tokens: 5 },
});

const schemaA = z.object({ label: z.enum(['a', 'b']) });
const schemaB = z.object({ label: z.enum(['a', 'b']), note: z.string() });

function client(records: LlmUsageRecord[] = []) {
  return createLlmClient({
    provider: createAnthropicProvider({ apiKey: 'k' }),
    models: {
      triage: 'claude-haiku-5-5',
      primary: 'claude-sonnet-5-5',
      escalation: 'claude-opus-5-5',
    },
    recordUsage: (record) => {
      records.push(record);
      return Promise.resolve();
    },
  });
}
const ask = (llm: ReturnType<typeof client>, schema: z.ZodType) =>
  llm.generateObject({
    operation: 'discovery.evaluate',
    tier: 'primary',
    system: 's',
    messages: [{ role: 'user', content: 'u' }],
    maxOutputTokens: 100,
    schema,
    retry: { attempts: 3, initialDelayMs: 1, maxDelayMs: 2 },
  });

const generate = (schema: z.ZodType) =>
  createAnthropicProvider({ apiKey: 'k' }).generate({
    model: 'claude-sonnet-5-5',
    system: 'SYSTEM PROMPT',
    messages: [{ role: 'user', content: 'u' }],
    maxOutputTokens: 10,
    effort: 'medium',
    jsonSchema: toNeutralJsonSchema(schema),
    retry: { attempts: 3, initialDelayMs: 1, maxDelayMs: 2 },
  });
const systemText = (body: Node) => (body.system as Array<{ text: string }>)[0]!.text;
const format = (body: Node) => (body.output_config as { format?: unknown } | undefined)?.format;

describe('a schema too large for a grammar (the assessment)', () => {
  it('goes in the system prompt, with no grammar, and the answer is still validated in full', async () => {
    const calls = respond([json(200, message('{"headline":"only this"}'))]);
    const error = await ask(client(), evaluationOutputSchema).catch((e: unknown) => e);
    expect(calls).toHaveLength(2); // the answer, then its one repair round
    for (const call of calls) {
      expect(format(call.body)).toBeUndefined();
      expect(systemText(call.body)).toMatch(/^s\n\nRESPONSE FORMAT: reply with one JSON object/);
      expect(systemText(call.body)).toContain('"subcategories"');
    }
    // Identical system text both times, so it is cached like any system prompt.
    expect(systemText(calls[0]!.body)).toBe(systemText(calls[1]!.body));
    expect(error).toMatchObject({ kind: 'invalid_output' });
  });

  it('accepts a whole object wrapped in a sentence or a fence, never a part of one', async () => {
    respond([json(200, message('Here is the JSON:\n{"label":"a"}\nDone.'))]);
    await expect(ask(client(), schemaA)).resolves.toMatchObject({ data: { label: 'a' } });
    respond([json(200, message('```json\n{"label":"b"}\n```'))]);
    await expect(ask(client(), schemaA)).resolves.toMatchObject({ data: { label: 'b' } });
    respond([json(200, message('Here: {"label":"a", "note": '))]);
    await expect(ask(client(), schemaA)).rejects.toMatchObject({ kind: 'invalid_output' });
  });
});

describe('a grammar Anthropic refuses to compile', () => {
  it('is re-sent once with the schema in the prompt, and the refused grammar is never sent again', async () => {
    const calls = respond([json(400, GRAMMAR_400), json(200, message('{"label":"a"}'))]);
    const provider = createAnthropicProvider({ apiKey: 'k' });
    const request = {
      model: 'claude-sonnet-5-5',
      system: 'SYSTEM PROMPT',
      messages: [{ role: 'user' as const, content: 'u' }],
      maxOutputTokens: 10,
      effort: 'medium' as const,
      jsonSchema: toNeutralJsonSchema(schemaA),
    };
    const first = await provider.generate(request);
    expect(first).toMatchObject({
      text: '{"label":"a"}',
      attempts: { attempts: 2, retryStatuses: [400] },
    });
    expect(format(calls[0]!.body)).toBeDefined();
    expect(format(calls[1]!.body)).toBeUndefined();
    expect(systemText(calls[1]!.body)).toContain('RESPONSE FORMAT');
    await provider.generate(request);
    expect(calls).toHaveLength(3);
    expect(format(calls[2]!.body)).toBeUndefined();
  });

  it('is a permanent configuration error if even that is refused: never retried by the SDK', async () => {
    const calls = respond([json(400, GRAMMAR_400)]);
    const error = await generate(schemaA).catch((e: unknown) => e);
    expect(calls).toHaveLength(2);
    expect(error).toMatchObject({
      kind: 'schema_rejected',
      retryable: false,
      status: 400,
      provider: 'anthropic',
    });
    expect(isPermanentError(error)).toBe(true);
    expect(isRequestConfigurationError(error)).toBe(true);
  });

  it('is not sent again by the same client once refused; a different schema is', async () => {
    const records: LlmUsageRecord[] = [];
    const calls = respond([json(400, GRAMMAR_400)]);
    const llm = client(records);
    await expect(ask(llm, schemaA)).rejects.toMatchObject({ kind: 'schema_rejected' });
    await expect(ask(llm, schemaA)).rejects.toThrow(/not sent/);
    expect(calls).toHaveLength(2);
    expect(records.map((r) => r.errorKind)).toEqual(['schema_rejected']);
    await expect(ask(llm, schemaB)).rejects.toMatchObject({ kind: 'schema_rejected' });
    expect(calls).toHaveLength(4);
  });

  it('only matches the grammar refusal: another 400 stays an ordinary invalid request', async () => {
    const calls = respond([
      json(400, {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'max_tokens too large' },
      }),
    ]);
    await expect(ask(client(), schemaA)).rejects.toMatchObject({
      kind: 'invalid_request',
      retryable: false,
    });
    expect(calls).toHaveLength(1);
  });
});

describe('transient Anthropic failures', () => {
  it.each([
    [429, 'rate_limited'],
    [500, 'unavailable'],
    [503, 'unavailable'],
    [529, 'unavailable'],
  ] as const)(
    'HTTP %d is retried within the call’s policy, then answered',
    async (status, _kind) => {
      const calls = respond([
        json(
          status,
          { type: 'error', error: { type: 'x', message: 'busy' } },
          { 'retry-after-ms': '1' },
        ),
        json(200, message('{"label":"a"}')),
      ]);
      const result = await ask(client(), schemaA);
      expect(result.data).toEqual({ label: 'a' });
      expect(calls).toHaveLength(2);
    },
  );

  it.each([
    [429, 'rate_limited'],
    [503, 'unavailable'],
  ] as const)(
    'HTTP %d that persists stops at the policy as a retryable %s',
    async (status, kind) => {
      const calls = respond([
        json(
          status,
          { type: 'error', error: { type: 'x', message: 'busy' } },
          { 'retry-after-ms': '1' },
        ),
      ]);
      await expect(ask(client(), schemaA)).rejects.toMatchObject({ kind, retryable: true });
      expect(calls).toHaveLength(3);
    },
  );
});

describe('an answer cut off at its token limit', () => {
  it('is never accepted, even when the text so far parses', async () => {
    // A complete-looking object that stopped at max_tokens is still a cut-off answer.
    respond([json(200, message('{"label":"a"}', 'max_tokens'))]);
    const error = await ask(client(), schemaA).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ kind: 'truncated', retryable: false });
  });

  it('asks for the answer budget plus thinking room, so thinking can’t starve the JSON', async () => {
    const calls = respond([json(200, message('{"label":"a"}'))]);
    await client().generateObject({
      operation: 'discovery.triage',
      tier: 'triage',
      system: 's',
      messages: [{ role: 'user', content: 'u' }],
      maxOutputTokens: 2_000,
      schema: schemaA,
    });
    expect(calls[0]!.body).toMatchObject({
      model: 'claude-haiku-5-5',
      max_tokens: 2_000 + 1_024,
      output_config: { effort: 'low' },
    });
  });
});
