/**
 * Checks that the web app (apps/web/.env.local) and the worker (apps/worker/.env) are configured
 * for the same, unambiguous environment, and prints what each will use. Never prints a secret:
 * only names, whether each is set, and the Trigger.dev key's environment (from its prefix).
 *
 *   pnpm env:check              # configuration only, no network
 *   pnpm env:check --connect    # also pings the database and reports usage in the last 24 hours
 *   pnpm env:check --tavily     # also reads Tavily's usage endpoint (plan and credits this cycle)
 *
 * Exits non-zero if anything is missing, contradictory or unsafe, so it can gate a live run.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ConfigError } from '../config/env.js';
import { assertDatabaseForRuntime, RUNTIMES, type Runtime } from '../config/runtime.js';
import { readDiscoveryConfig } from '../discovery/config.js';
import { DEFAULT_MODELS } from '../llm/config.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const FILES = { web: 'apps/web/.env.local', worker: 'apps/worker/.env' } as const;

function parse(file: string): Record<string, string> {
  const path = `${root}${file}`;
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
      .map((line) => {
        const at = line.indexOf('=');
        return [
          line.slice(0, at),
          line
            .slice(at + 1)
            .trim()
            .replace(/^"|"$/g, ''),
        ];
      }),
  );
}

const problems: string[] = [];
const notes: string[] = [];
const fail = (message: string) => problems.push(message);
const set = (env: Record<string, string>, name: string) => (env[name] ? 'set' : 'not set');
const fingerprint = (value: string | undefined) =>
  value ? createHash('sha256').update(value).digest('hex').slice(0, 8) : null;

const web = parse(FILES.web);
const worker = parse(FILES.worker);

function runtimeOf(side: string, env: Record<string, string>): Runtime | null {
  const value = env.OMENAI_RUNTIME;
  if (!value) {
    fail(`${side}: OMENAI_RUNTIME is not set (no runtime is assumed).`);
    return null;
  }
  if (!(RUNTIMES as readonly string[]).includes(value) || value === 'test') {
    fail(`${side}: OMENAI_RUNTIME="${value}" isn't a runtime an app can run in.`);
    return null;
  }
  return value as Runtime;
}

function checkDatabase(side: string, env: Record<string, string>, runtime: Runtime | null) {
  if (!env.MONGODB_URI) fail(`${side}: MONGODB_URI is not set.`);
  if (!env.MONGODB_DB_NAME) {
    fail(`${side}: MONGODB_DB_NAME is not set (never assumed).`);
    return;
  }
  if (!runtime) return;
  try {
    assertDatabaseForRuntime(runtime, env.MONGODB_DB_NAME);
  } catch (error) {
    fail(`${side}: ${(error as Error).message}`);
  }
}

const webRuntime = runtimeOf('web', web);
const workerRuntime = runtimeOf('worker', worker);
checkDatabase('web', web, webRuntime);
checkDatabase('worker', worker, workerRuntime);

if (webRuntime && workerRuntime && webRuntime !== workerRuntime)
  fail(`web runs as ${webRuntime} but the worker as ${workerRuntime}.`);
if (web.MONGODB_DB_NAME !== worker.MONGODB_DB_NAME)
  fail(
    `web uses database "${web.MONGODB_DB_NAME ?? '(none)'}" but the worker "${worker.MONGODB_DB_NAME ?? '(none)'}".`,
  );
if (fingerprint(web.MONGODB_URI) !== fingerprint(worker.MONGODB_URI))
  fail('web and worker MONGODB_URI differ (different clusters or users).');

const runtime = webRuntime ?? workerRuntime;
const triggerKey = web.TRIGGER_SECRET_KEY ?? '';
const triggerEnv = triggerKey.startsWith('tr_dev_')
  ? 'development'
  : triggerKey.startsWith('tr_prod_')
    ? 'production'
    : triggerKey
      ? 'unrecognised'
      : 'not set';

if (runtime === 'live-dev') {
  if (triggerEnv !== 'development')
    fail(`web: TRIGGER_SECRET_KEY must be a development key (tr_dev_…); it is ${triggerEnv}.`);
  if ((worker.LLM_PROVIDER ?? '') !== 'gemini')
    fail(
      `worker: LLM_PROVIDER must be gemini in live development (is "${worker.LLM_PROVIDER ?? ''}").`,
    );
  for (const name of ['GEMINI_API_KEY', 'TAVILY_API_KEY'])
    if (!worker[name]) fail(`worker: ${name} is not set.`);
  for (const name of ['AI_DAILY_CALL_LIMIT', 'SEARCH_DAILY_CREDIT_LIMIT'])
    if (!/^[1-9]\d*$/.test(worker[name] ?? ''))
      fail(`worker: ${name} must be set to a whole number in live development.`);
  if (worker.EMAIL_TRANSPORT || web.EMAIL_TRANSPORT)
    fail('EMAIL_TRANSPORT simulates email and is only for fixtures.');
}

/**
 * The web app streams chat replies itself (ADR-035), so it needs the model configuration too,
 * identical to the worker's: same provider, same key (compared by fingerprint), same models and
 * the same daily limits, which both apps count against the same usage records. Search stays in
 * the worker, so the Tavily key must never be in the web env.
 */
const CHAT_MODEL_VARIABLES = [
  'LLM_PROVIDER',
  'GEMINI_MODEL_TRIAGE',
  'GEMINI_MODEL_PRIMARY',
  'GEMINI_MODEL_ESCALATION',
  'AI_DAILY_CALL_LIMIT',
  'SEARCH_DAILY_CREDIT_LIMIT',
] as const;
if (runtime === 'live-dev' || runtime === 'production') {
  const keyName =
    (web.LLM_PROVIDER ?? worker.LLM_PROVIDER) === 'anthropic'
      ? 'ANTHROPIC_API_KEY'
      : 'GEMINI_API_KEY';
  if (!web.LLM_PROVIDER) fail('web: LLM_PROVIDER is not set (the chat route calls the model).');
  if (!web[keyName]) fail(`web: ${keyName} is not set (the chat route calls the model).`);
  else if (fingerprint(web[keyName]) !== fingerprint(worker[keyName]))
    fail(`web and worker ${keyName} differ: use the same key in both.`);
  for (const name of CHAT_MODEL_VARIABLES)
    if ((web[name] ?? '') !== (worker[name] ?? ''))
      fail(`web and worker ${name} differ ("${web[name] ?? ''}" vs "${worker[name] ?? ''}").`);
  if (runtime === 'live-dev' && web.LLM_PROVIDER && web.LLM_PROVIDER !== 'gemini')
    fail(`web: LLM_PROVIDER must be gemini in live development (is "${web.LLM_PROVIDER}").`);
}
if (runtime === 'fixtures') notes.push('Fixtures: work runs in-process with scripted answers.');
if (runtime === 'production')
  notes.push('Production configuration: this check doesn’t deploy or call anything.');

let discovery: ReturnType<typeof readDiscoveryConfig> | null = null;
try {
  discovery = readDiscoveryConfig(worker);
} catch (error) {
  fail(`worker: ${(error as ConfigError).message}`);
}

const provider = worker.LLM_PROVIDER === 'anthropic' ? 'anthropic' : 'gemini';
const models = Object.fromEntries(
  (['triage', 'primary', 'escalation'] as const).map((tier) => [
    tier,
    worker[`${provider.toUpperCase()}_MODEL_${tier.toUpperCase()}`] ??
      DEFAULT_MODELS[provider][tier],
  ]),
);

console.log(`Runtime            web ${webRuntime ?? '?'} · worker ${workerRuntime ?? '?'}`);
console.log(
  `Database           web "${web.MONGODB_DB_NAME ?? ''}" · worker "${worker.MONGODB_DB_NAME ?? ''}" · same cluster and user: ${fingerprint(web.MONGODB_URI) === fingerprint(worker.MONGODB_URI) ? 'yes' : 'no'}`,
);
console.log(`Trigger.dev        web key: ${triggerEnv}`);
console.log(`Model provider     ${worker.LLM_PROVIDER ?? '(not set)'} · ${JSON.stringify(models)}`);
console.log(
  `Keys (worker)      Gemini ${set(worker, 'GEMINI_API_KEY')} · Tavily ${set(worker, 'TAVILY_API_KEY')} · Anthropic ${set(worker, 'ANTHROPIC_API_KEY')}`,
);
console.log(
  `Keys (web)         auth secret ${set(web, 'BETTER_AUTH_SECRET')} · Resend ${set(web, 'RESEND_API_KEY')} · Gemini (chat) ${set(web, 'GEMINI_API_KEY')}, same as worker: ${web.GEMINI_API_KEY ? (fingerprint(web.GEMINI_API_KEY) === fingerprint(worker.GEMINI_API_KEY) ? 'yes' : 'NO') : '-'} · Tavily ${web.TAVILY_API_KEY ? 'PRESENT (should not be)' : 'none (correct)'}`,
);
console.log(
  `Daily limits       AI calls ${worker.AI_DAILY_CALL_LIMIT ?? '(none)'} · search credits ${worker.SEARCH_DAILY_CREDIT_LIMIT ?? '(none)'} · web the same: ${CHAT_MODEL_VARIABLES.every((name) => (web[name] ?? '') === (worker[name] ?? '')) ? 'yes' : 'NO'}`,
);
if (discovery)
  console.log(
    `Discovery limits   queries ${discovery.maxQueries} × ${discovery.resultsPerQuery} results · extract ≤${discovery.maxExtract} · revisits ≤${discovery.maxRevisits} · assessments ≤${discovery.maxEvaluations} · escalations ≤${discovery.maxEscalations} · triage batch ${discovery.triageBatchSize} · threshold ${discovery.shortlistThreshold}`,
  );
if (web.TAVILY_API_KEY) fail('web: TAVILY_API_KEY is set; searching happens in the worker only.');
if (runtime === 'live-dev' && web.ANTHROPIC_API_KEY)
  fail('web: ANTHROPIC_API_KEY is set; live development uses Gemini only.');

async function connectCheck() {
  process.env.OMENAI_RUNTIME = worker.OMENAI_RUNTIME;
  process.env.MONGODB_URI = worker.MONGODB_URI;
  process.env.MONGODB_DB_NAME = worker.MONGODB_DB_NAME;
  process.env.AI_DAILY_CALL_LIMIT = worker.AI_DAILY_CALL_LIMIT ?? '';
  process.env.SEARCH_DAILY_CREDIT_LIMIT = worker.SEARCH_DAILY_CREDIT_LIMIT ?? '';
  const { getConnection, closeDb } = await import('../db/client.js');
  const { usageInWindow } = await import('../ops/budget.js');
  const started = Date.now();
  const connection = await getConnection();
  await connection.db!.admin().ping();
  const collections = (await connection.db!.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name)
    .sort();
  const usage = await usageInWindow();
  const users = await connection.db!.collection('user').countDocuments();
  console.log(
    `Database check     "${connection.name}" reachable in ${Date.now() - started} ms · ${collections.length} collections · ${users} accounts`,
  );
  console.log(
    `Usage, last 24 h   ${usage.aiCalls} AI calls · ${usage.searchCredits} search credits (real usage only)`,
  );
  await closeDb();
}

async function tavilyCheck() {
  if (!worker.TAVILY_API_KEY) {
    fail('worker: TAVILY_API_KEY is not set.');
    return;
  }
  const response = await fetch('https://api.tavily.com/usage', {
    headers: { Authorization: `Bearer ${worker.TAVILY_API_KEY}` },
  });
  if (!response.ok) {
    fail(`Tavily usage endpoint answered ${response.status}.`);
    return;
  }
  const body = (await response.json()) as {
    key?: { usage?: number; limit?: number | null };
    account?: {
      current_plan?: string;
      plan_usage?: number;
      plan_limit?: number;
      paygo_usage?: number;
      paygo_limit?: number;
    };
  };
  console.log(
    `Tavily             plan ${body.account?.current_plan ?? '?'} · plan credits ${body.account?.plan_usage ?? '?'} of ${body.account?.plan_limit ?? '?'} this cycle · pay-as-you-go ${body.account?.paygo_usage ?? '?'} of ${body.account?.paygo_limit ?? '?'} · key limit ${body.key?.limit ?? 'none'}`,
  );
}

try {
  if (process.argv.includes('--connect') && !problems.length) await connectCheck();
  if (process.argv.includes('--tavily')) await tavilyCheck();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

for (const note of notes) console.log(`Note: ${note}`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exitCode = 1;
} else {
  console.log('\nConfiguration is consistent.');
}
