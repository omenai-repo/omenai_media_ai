import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';

import { getModels } from '../db/models.js';
import { createLlmClient } from '../llm/client.js';
import type { LlmProvider } from '../llm/types.js';
import { isPermanentError } from '../tasks/errors.js';
import { startTestDatabase, type TestDatabase } from '../testing/index.js';
import { assertAiBudget, assertSearchBudget, usageInWindow, UsageLimitError } from './budget.js';

let db: TestDatabase;
beforeAll(async () => {
  db = await startTestDatabase();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const now = new Date('2026-10-16T12:00:00Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

async function record(rows: Array<Record<string, unknown>>) {
  const { AiUsage } = await getModels();
  await AiUsage.collection.insertMany(rows);
}

describe('daily usage limits (live development)', () => {
  it('counts real usage in the last 24 hours only, never simulated fixture usage', async () => {
    await record([
      { provider: 'gemini', kind: 'llm', operation: 'x', outcome: 'ok', createdAt: hoursAgo(1) },
      { provider: 'gemini', kind: 'llm', operation: 'x', outcome: 'error', createdAt: hoursAgo(2) },
      { provider: 'gemini', kind: 'llm', operation: 'x', outcome: 'ok', createdAt: hoursAgo(30) },
      {
        provider: 'gemini',
        kind: 'llm',
        operation: 'x',
        outcome: 'ok',
        simulated: true,
        createdAt: hoursAgo(1),
      },
      {
        provider: 'tavily',
        kind: 'search',
        operation: 's',
        outcome: 'ok',
        units: 1,
        createdAt: hoursAgo(3),
      },
      {
        provider: 'tavily',
        kind: 'extract',
        operation: 'e',
        outcome: 'ok',
        units: 2,
        createdAt: hoursAgo(3),
      },
      // Credits not reported: counted as one, never as zero.
      {
        provider: 'tavily',
        kind: 'search',
        operation: 's',
        outcome: 'ok',
        units: null,
        createdAt: hoursAgo(3),
      },
      // A failed request costs nothing.
      {
        provider: 'tavily',
        kind: 'search',
        operation: 's',
        outcome: 'error',
        units: null,
        createdAt: hoursAgo(3),
      },
    ]);
    expect(await usageInWindow(now)).toMatchObject({ aiCalls: 2, searchCredits: 4 });
  });

  it('refuses the call that would pass a limit, as a permanent error', async () => {
    vi.stubEnv('OMENAI_RUNTIME', 'live-dev');
    vi.stubEnv('AI_DAILY_CALL_LIMIT', '2');
    vi.stubEnv('SEARCH_DAILY_CREDIT_LIMIT', '5');
    await record([
      { provider: 'gemini', kind: 'llm', operation: 'x', outcome: 'ok', createdAt: hoursAgo(1) },
      {
        provider: 'tavily',
        kind: 'search',
        operation: 's',
        outcome: 'ok',
        units: 4,
        createdAt: hoursAgo(1),
      },
    ]);
    await expect(assertAiBudget(now)).resolves.toBeUndefined();
    await expect(assertSearchBudget(1, now)).resolves.toBeUndefined();
    await expect(assertSearchBudget(2, now)).rejects.toBeInstanceOf(UsageLimitError);
    await record([
      { provider: 'gemini', kind: 'llm', operation: 'x', outcome: 'ok', createdAt: hoursAgo(1) },
    ]);
    const refused = await assertAiBudget(now).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(UsageLimitError);
    expect((refused as Error).message).toMatch(/2 AI calls in 24 hours/);
    // Retrying can't help, so background tasks stop instead of spending their attempts.
    expect(isPermanentError(refused)).toBe(true);
  });

  it('stops the request before it reaches the provider, repair rounds included', async () => {
    let sent = 0;
    const provider: LlmProvider = {
      name: 'gemini',
      generate: () => {
        sent += 1;
        return Promise.resolve({
          text: '{"ok": true}',
          model: 'm',
          stopReason: 'complete',
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningTokens: 0 },
        });
      },
    };
    let allowed = 1;
    const client = createLlmClient({
      provider,
      models: { triage: 'm', primary: 'm', escalation: 'm' },
      recordUsage: () => Promise.resolve(),
      beforeCall: () => {
        if (allowed-- <= 0) return Promise.reject(new UsageLimitError('limit'));
        return Promise.resolve();
      },
    });
    const request = {
      operation: 'test',
      tier: 'primary' as const,
      system: 's',
      messages: [{ role: 'user' as const, content: 'u' }],
      maxOutputTokens: 10,
      schema: z.object({ ok: z.boolean() }),
    };
    await expect(client.generateObject(request)).resolves.toMatchObject({ data: { ok: true } });
    await expect(client.generateObject(request)).rejects.toBeInstanceOf(UsageLimitError);
    expect(sent).toBe(1);
  });
});
