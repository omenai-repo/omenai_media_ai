/**
 * Targeted recovery of one discovery run's assessments (ADR-046), against the production
 * database through the production client factory. Modes:
 *
 *   preview  Read-only. Every candidate's state, what recovery would do and its request estimate.
 *   probe    One assessment request per assessing tier with a tiny answer budget: proves the
 *            response schema compiles (a refused schema fails before any answer is written).
 *   apply    The recovery itself, refused unless the plan still has --expect-eligible stories.
 *   reconcile  Read-only reconciliation against the stored records; recomputes only the run's
 *            recovery totals. No model requests.
 *
 *   node dist/cli/recover-run.js --mode preview --run <runKey> --id <recovery id> \
 *     --env-file <file> --out <report.json> [--db omenai] [--ceiling 100] [--expect-eligible N]
 *
 * Only MONGODB_URI and ANTHROPIC_API_KEY are read from the env file, in-process and never
 * printed. The runtime is production and the provider Anthropic; Gemini and Tavily keys are
 * removed from the environment, and every HTTP request goes through a guard that refuses any host
 * but api.anthropic.com and any request past the ceiling, so neither can be reached. Usage is
 * recorded as for any production call; the report also keeps each request the guard saw.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import mongoose from 'mongoose';

import { closeDb } from '../db/client.js';
import { getModels } from '../db/models.js';
import { readDiscoveryConfig, type DiscoveryConfig } from '../discovery/config.js';
import type { DiscoveryDeps } from '../discovery/pipeline/context.js';
import {
  applyRecovery,
  planRecovery,
  reconcileRecovery,
  type RecoveryPlan,
  type RecoveryTarget,
} from '../discovery/recovery.js';
import { evaluationOutputSchema } from '../discovery/schemas.js';
import { getLlmClient } from '../llm/client.js';
import { LlmError, MODEL_TIERS } from '../llm/types.js';
import { usageInWindow } from '../ops/budget.js';
import { estimateRowCost } from '../ops/pricing.js';
import { SearchError, type SearchClient } from '../search/types.js';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i]!.replace(/^--/, ''), process.argv[i + 1] ?? '');
}
const arg = (name: string, fallback?: string): string => {
  const value = args.get(name) ?? fallback;
  if (value === undefined || value === '') throw new Error(`Missing --${name}`);
  return value;
};

const mode = arg('mode');
const runKey = arg('run');
const ceiling = Number(arg('ceiling', '100'));
const out = arg('out');
if (!['preview', 'probe', 'apply', 'reconcile'].includes(mode))
  throw new Error('--mode is preview, probe, apply or reconcile');
if (!Number.isInteger(ceiling) || ceiling < 1) throw new Error('--ceiling must be a whole number');

/** Only these two values are taken from the file; nothing else in it is loaded. */
function readSecrets(file: string): { uri: string; key: string } {
  const lines = readFileSync(file, 'utf8').split('\n');
  const value = (name: string) => {
    const line = lines.find((l) => l.startsWith(`${name}=`));
    const v = line
      ?.slice(name.length + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (!v) throw new Error(`No ${name} in the env file.`);
    return v;
  };
  return { uri: value('MONGODB_URI'), key: value('ANTHROPIC_API_KEY') };
}

// Production's indexes and collections exist already; this process never creates or changes
// them, so a preview reads and nothing else.
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);

const secrets = readSecrets(arg('env-file'));
for (const name of ['GEMINI_API_KEY', 'TAVILY_API_KEY', 'LLM_PROVIDER']) delete process.env[name];
Object.assign(process.env, {
  OMENAI_RUNTIME: 'production',
  MONGODB_URI: secrets.uri,
  MONGODB_DB_NAME: arg('db', 'omenai'),
  LLM_PROVIDER: 'anthropic',
  ANTHROPIC_API_KEY: secrets.key,
});

/** Every HTTP request, as the guard saw it (no headers, no bodies beyond the model name). */
const requests: Array<{
  at: string;
  host: string;
  model: unknown;
  status: number | null;
  ms: number;
  refused?: string;
}> = [];
/** Requests that left this process for Anthropic, failed in transit included (they may have arrived). */
const sent = () =>
  requests.filter(
    (r) => r.host === 'api.anthropic.com' && (!r.refused || r.refused.startsWith('network')),
  ).length;
const realFetch = globalThis.fetch;
// Installed before any client exists, so the SDK takes it as its fetch.
globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  const host = new URL(url).host;
  let model: unknown = null;
  try {
    model =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as { model?: unknown }).model : null;
  } catch {
    model = null;
  }
  const entry: (typeof requests)[number] = {
    at: new Date().toISOString(),
    host,
    model,
    status: null,
    ms: 0,
  };
  requests.push(entry);
  if (host !== 'api.anthropic.com') {
    entry.refused = 'host';
    throw new Error(`Refused: a request to ${host}. Recovery talks to Anthropic only.`);
  }
  if (mode === 'preview' || mode === 'reconcile') {
    entry.refused = 'preview';
    throw new Error('Refused: preview sends no model requests.');
  }
  if (sent() > ceiling) {
    entry.refused = 'ceiling';
    throw new Error(`Refused: the ceiling of ${ceiling} Anthropic requests was reached.`);
  }
  const started = Date.now();
  let response: Response;
  try {
    response = await realFetch(input, init);
  } catch (error) {
    // The low-level cause only (a code and message), to tell a network failure apart.
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    entry.refused = `network: ${cause?.code ?? ''} ${cause?.message ?? String(error)}`.slice(
      0,
      200,
    );
    entry.ms = Date.now() - started;
    throw error;
  }
  entry.status = response.status;
  entry.ms = Date.now() - started;
  return response;
};

/** Recovery never searches: assessment works from the stored sources. */
const noSearch: SearchClient = {
  search: () => Promise.reject(new SearchError('invalid_request', 'Recovery never searches.')),
  extract: () => Promise.reject(new SearchError('invalid_request', 'Recovery never extracts.')),
};

const target: RecoveryTarget = {
  runKey,
  id: arg('id'),
  reason:
    'Assessments refused by Anthropic (compiled grammar too large) and triage batches that fell back, 2026-10-22.',
  failure: /compiled grammar is too large|too complex for compilation/i,
};

/** The run's own recorded thresholds, caps and models: recovery assesses by the run's rules. */
async function runConfig(): Promise<DiscoveryConfig> {
  const { WorkflowRun } = await getModels();
  const run = await WorkflowRun.findOne({ runKey }, { config: 1 }).lean();
  const recorded = (run?.config ?? null) as
    (Partial<DiscoveryConfig> & { models?: Record<string, string> }) | null;
  if (!recorded) throw new Error(`Run ${runKey} has no recorded configuration.`);
  const { models, ...limits } = recorded;
  const llm = getLlmClient();
  for (const tier of MODEL_TIERS)
    if (models?.[tier] !== llm.modelFor(tier))
      throw new Error(
        `The ${tier} model differs from the run's (${models?.[tier]} vs ${llm.modelFor(tier)}).`,
      );
  return { ...readDiscoveryConfig({}), ...limits };
}

function summary(plan: RecoveryPlan) {
  return {
    runStatus: plan.runStatus,
    recoveryStatus: plan.recoveryStatus,
    stories: plan.stories.length,
    groups: plan.counts,
    eligible: plan.eligible.length,
    retriage: plan.retriage.length,
    articles: plan.articles,
    estimate: plan.estimate,
  };
}

async function usageSince(since: Date) {
  const { AiUsage } = await getModels();
  const rows = await AiUsage.find({ createdAt: { $gte: since }, kind: 'llm' }).lean();
  const byModel: Record<
    string,
    {
      requests: number;
      input: number;
      cacheRead: number;
      cacheWrite: number;
      output: number;
      cost: number;
    }
  > = {};
  for (const row of rows) {
    const m = (byModel[`${row.provider}/${row.model}`] ??= {
      requests: 0,
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      cost: 0,
    });
    m.requests += 1;
    m.input += row.inputTokens ?? 0;
    m.cacheRead += row.cachedInputTokens ?? 0;
    m.cacheWrite += row.cacheWriteTokens ?? 0;
    m.output += row.outputTokens ?? 0;
    const estimate = estimateRowCost({
      provider: row.provider,
      operation: row.operation,
      model: row.model ?? null,
      calls: 1,
      errors: row.outcome === 'error' ? 1 : 0,
      inputTokens: row.inputTokens ?? 0,
      outputTokens: row.outputTokens ?? 0,
      cachedInputTokens: row.cachedInputTokens ?? 0,
      cacheWriteTokens: row.cacheWriteTokens ?? 0,
      reasoningTokens: row.reasoningTokens ?? 0,
      units: 0,
      unreportedCalls: 0,
      simulated: false,
    });
    m.cost += estimate.usd ?? 0;
  }
  const operations: Record<string, number> = {};
  for (const row of rows) {
    const label = `${row.operation} ${row.outcome}${row.errorKind ? `:${row.errorKind}` : ''}`;
    operations[label] = (operations[label] ?? 0) + 1;
  }
  return { rows: rows.length, byModel, operations };
}

async function main() {
  const startedAt = new Date();
  const report: Record<string, unknown> = { mode, runKey, id: target.id, ceiling, startedAt };
  const before = await planRecovery(target);
  report.before = summary(before);
  report.manifest = before.stories;
  console.log(JSON.stringify({ before: report.before }, null, 1));

  if (mode === 'probe' || mode === 'apply') {
    // The existing daily limit stays on, set above today's use plus this ceiling.
    const used = await usageInWindow();
    process.env.AI_DAILY_CALL_LIMIT = String(used.aiCalls + ceiling + 1);
  }

  if (mode === 'probe') {
    const llm = getLlmClient();
    const probes: Record<string, string> = {};
    for (const tier of ['primary', 'escalation'] as const) {
      try {
        await llm.generateObject({
          operation: 'recovery.schema_probe',
          tier,
          effort: 'low',
          system: 'Schema compilation check. Answer with the JSON object.',
          messages: [{ role: 'user', content: 'Begin the JSON object.' }],
          maxOutputTokens: 1,
          schema: evaluationOutputSchema,
          repair: false,
          retry: { attempts: 1, initialDelayMs: 0, maxDelayMs: 0 },
          context: { runKey },
        });
        probes[tier] = 'compiled (complete answer)';
      } catch (error) {
        probes[tier] =
          error instanceof LlmError && error.kind === 'truncated'
            ? 'compiled (stopped at its tiny budget, as intended)'
            : `FAILED ${error instanceof LlmError ? error.kind : ''}: ${String(error).slice(0, 300)}`;
      }
    }
    report.probes = probes;
    console.log(JSON.stringify({ probes }, null, 1));
  }

  if (mode === 'apply') {
    const expected = Number(arg('expect-eligible'));
    if (before.eligible.length !== expected)
      throw new Error(
        `Refused: the plan has ${before.eligible.length} eligible stories, not the ${expected} previewed.`,
      );
    // What this invocation attempts: every triage batch left, and the stories it may assess.
    const stories = args.has('max-stories') ? Number(arg('max-stories')) : before.eligible.length;
    const expectedHere =
      before.estimate.expected - before.eligible.length + Math.min(stories, before.eligible.length);
    if (expectedHere > ceiling)
      throw new Error(
        `Refused: the expected ${expectedHere} requests exceed the ceiling of ${ceiling}.`,
      );
    const deps: DiscoveryDeps = {
      llm: getLlmClient(),
      search: noSearch,
      config: await runConfig(),
      now: () => new Date(),
    };
    const result = await applyRecovery({
      target,
      deps,
      budget: { ceiling, used: sent },
      triageCeiling: 14,
      ...(args.has('max-stories') ? { maxStories: Number(arg('max-stories')) } : {}),
      onEvent: (message) => console.log(`[recovery] ${message}`),
    });
    report.result = result;
    const after = await planRecovery(target);
    report.after = summary(after);
    report.manifestAfter = after.stories;
  }

  if (mode === 'reconcile') {
    report.reconciliation = await reconcileRecovery(target);
    console.log(JSON.stringify({ reconciliation: report.reconciliation }, null, 1));
  }

  report.requests = requests;
  report.hosts = [...new Set(requests.map((r) => r.host))];
  report.anthropicRequestsSent = sent();
  report.refused = requests.filter((r) => r.refused).length;
  report.usage = await usageSince(startedAt);
  report.finishedAt = new Date();
  writeFileSync(out, JSON.stringify(report, null, 1));
  console.log(
    JSON.stringify(
      {
        anthropicRequestsSent: report.anthropicRequestsSent,
        hosts: report.hosts,
        refused: report.refused,
        usage: report.usage,
        after: report.after ?? null,
        status: (report.result as { status?: string } | undefined)?.status ?? null,
      },
      null,
      1,
    ),
  );
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
