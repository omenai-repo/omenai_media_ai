# Architecture Decisions

Each entry: **context → decision → alternatives → consequences**, with a status:

- **Confirmed**: agreed with the product owner, or verified against current documentation and the implementation.
- **Provisional**: a sensible default chosen by the engineer, open to revision.
- **To verify**: depends on behaviour that hasn't been checked yet.

Newest entries are appended at the bottom. Don't rewrite history; supersede an entry with a new one that references it.

---

## ADR-001 — Build on the existing scaffold

- **Status:** Confirmed (2026-10-14)
- **Context:** The repo already had a clean pnpm 12 + Turborepo 2.11 workspace: Next.js 16.4 (`apps/web`), `@repo/shared` (Zod schemas compiled with `tsc`), `@repo/config` (TS presets and ESLint configs), Vitest, and Prettier.
- **Decision:** Keep all tooling and conventions. Add `@repo/core` and `apps/worker`. Don't re-scaffold.
- **Consequences:** New packages copy `packages/shared` (compile to `dist`, standard script names). Route handlers stay thin, and logic lives in libraries, as the existing `/api/health` route does.

## ADR-002 — Three code packages: `shared`, `core`, `worker`

- **Status:** Provisional
- **Context:** The brief suggested `packages/core` and `packages/db`.
- **Decision:**
  - `@repo/shared` (existing) holds browser-safe code: taxonomy, Zod contracts, scoring, gates, Chicago-time logic.
  - `@repo/core` holds Node-only code: Mongo connection and models, services, AI/search/email clients, prompts.
  - `apps/worker` holds the Trigger.dev tasks.

  The DB layer lives in `core/src/db/`.

- **Alternatives:** A separate `@repo/db` package. Rejected because nothing would use the DB without the services that sit on top of it.
- **Consequences:** The UI can import the taxonomy and scoring code directly without pulling Node dependencies into the browser bundle.

## ADR-003 — Daily trigger: a single Trigger.dev schedule in `America/Chicago`

- **Status:** Confirmed by the product owner (2026-10-14). Precision depends on the Trigger.dev plan (see below).
- **Context:** Discovery must start at 00:00 America/Chicago and handle DST. Documentation checked on 2026-10-14:
  - Vercel Hobby cron precision is ±59 min and Hobby is for non-commercial use only; Pro is minute-precise.
  - Trigger.dev declarative schedules accept an IANA `timezone` and "automatically work with daylight saving time".
  - The Trigger.dev **free plan enforces a minimum 60-minute window**, so runs land at a stable time within 00:00–01:00. Paid plans run at the exact cron time by default.
- **Decision:** `schedules.task({ cron: { pattern: '0 0 * * *', timezone: 'America/Chicago', environments: ['PRODUCTION'] } })`. Vercel Cron isn't used. The run key comes from `payload.timestamp` (the scheduled time), converted to a Chicago date.
- **Alternatives:** Two Vercel crons (05:00 and 06:00 UTC) with a Chicago-hour guard route. Rejected: more moving parts, a public trigger endpoint, and two systems that both have to be up.
- **Consequences:** Exact midnight needs Trigger.dev Hobby or higher. On the free plan the run starts at a fixed time in the midnight hour. US DST transitions happen at 02:00 local, so local midnight occurs exactly once every day. Owners can also start runs manually through an authenticated route.

## ADR-004 — AI model routing: Haiku triage, Sonnet primary, bounded Opus escalation

> **Revised by ADR-016 (2026-10-15):** routing is now by tier behind a provider-agnostic interface. These Claude models are the production mapping; Gemini is used in development.

- **Status:** Confirmed by the product owner (initial strategy, to be evaluated on real stories)
- **Decision:** Models are configured per role through `AI_MODEL_TRIAGE`, `AI_MODEL_PRIMARY` and `AI_MODEL_ESCALATION`.
  - Haiku 5.5: per-article triage and change classification.
  - Sonnet 5.5: clustering, gates and scoring, research, chat, generation.
  - Opus 5.5: borderline scores (within ±4 of 65 or 80), model-flagged source conflicts or ethics/rights ambiguity, and editor-requested in-depth research.

  Opus is capped per run, and research escalates at most once per task.

- **Consequences:** Deterministic gates and the code-computed total always override model output. Raw usage is stored per call so the strategy can be judged on real costs.

## ADR-005 — Authentication: Better Auth, Google only, invitation-gated

> **Superseded in part by ADR-017 (2026-10-15):** Google OAuth was dropped in favour of email + password. Better Auth, the invite-only model, roles, DB-backed sessions and the enforcement helpers remain.

- **Status:** Confirmed by the product owner. API verified against the installed `better-auth@1.7.7` source on 2026-10-14; the Google callback leg itself is still unverified (needs real OAuth credentials).
- **Context:** The Auth.js site now states "Auth.js is now part of Better Auth"; next-auth v5 is still installed from the `@beta` tag.
- **Decision:** Better Auth with `@better-auth/mongo-adapter`, the Google social provider, `user.additionalFields` (`role`, `status`, with `input: false`) and `databaseHooks` that enforce invitations. Every protected route handler and page checks the DB session and role with `requireUser()` / `requireOwner()`. `proxy.ts` only redirects optimistically.
- **Consequences:** Better Auth owns the `user`, `session`, `account` and `verification` collections, and our app reads users from `user`. Sessions live in the DB, so deactivating a user can revoke their sessions immediately.
- **Verified behaviour (Phase 1, from the installed source and tests):**
  - Google's `email_verified` maps to `user.emailVerified`.
  - OAuth user creation (`internalAdapter.createOAuthUser`) runs in a transaction.
  - `databaseHooks.user.create.before` receives the endpoint context, which exposes `getCookie()`.
  - `after` hooks are queued until the transaction commits.
  - A hook-thrown `APIError` with `body.code` makes the OAuth callback redirect to `onAPIError.errorURL?error=<code>`.
- **Security boundary in force: token-bound and email-bound.**
  1. The invitation page sets an httpOnly, `SameSite=Lax`, 15-minute cookie scoped to `/api/auth` and carrying the raw token.
  2. The user-creation hook requires a Google-verified email, then one atomic conditional update claims the invitation. The update matches the token hash, the normalized email, `expiresAt > now`, and either `status: pending` or a stale `claimed` (older than 10 minutes).
  3. The `after` hook marks the invitation `accepted`.

  The stale-claim rule lets an invitee retry if account creation fails after the claim. It never lets a second account use the invitation, because the unique email index rejects a second user.

  The login page shows fixed copy for known error codes and never renders the URL's `error_description`.

## ADR-006 — MongoDB through Mongoose, sharing one MongoClient with Better Auth

- **Status:** Confirmed. Verified on 2026-10-14: `mongoose@9.11.2` pins `mongodb ~7.7` and `@better-auth/mongo-adapter@1.7.7` accepts `^6 || ^7`; exactly one `mongodb@7.7.0` is installed.
- **Decision:** Mongoose models live in `@repo/core`. One native `MongoClient` is shared: Mongoose uses it through `mongoose.createConnection().setClient(client)` (documented API) and Better Auth through `mongodbAdapter(client.db(), { client })`. The client is cached on `globalThis` for dev hot-reload and serverless reuse.
- **Consequences:** One connection pool per process. That matters on Atlas M0 connection limits.
- **Implementation notes:**
  - Mongoose's `setClient()` requires an already-connected client, so `getConnection()` is async: it connects once, then calls `setClient(client).useDb(dbName)`. Better Auth gets the same client synchronously, because the driver connects lazily.
  - Driver 7 has no `dbName` client option, so the database name comes from `MONGODB_DB_NAME` (default `omenai`) and is passed explicitly to both, never inferred from the URI.

## ADR-007 — UI: shadcn/ui, themed with Omenai's editorial design

- **Status:** Confirmed (shadcn was approved by the product owner)
- **Decision:** shadcn/ui components on Radix primitives (accessible), copied into `apps/web/src/components/ui` and restyled: warm paper and ink palette, hairline rules, an ochre accent, Newsreader serif for headlines, Geist for UI. Icons come from `lucide-react`.
- **Consequences:** We own the component code, so the look can be distinctive without depending on a heavy library.

## ADR-008 — Background work in Trigger.dev, status in MongoDB, UI polls

- **Status:** Provisional
- **Decision:** Route handlers validate, authorize, persist a task document, and trigger a Trigger.dev task. Workers write status and progress to our `tasks` collection. The UI polls `GET /api/tasks/[id]`. We don't build a real-time channel.
- **Consequences:** Closing or refreshing the browser has no effect on running work. Our DB is the single source of truth, so the UI never depends on Trigger.dev's API being reachable from the browser.

## ADR-009 — Idempotency: deterministic keys and unique indexes

- **Status:** Provisional
- **Decision:**
  - Runs use a unique `runKey`.
  - Tasks use a unique `key`.
  - Each brief and draft version is unique per `taskId`.
  - Concurrent research or chat on the same story is blocked by a sparse-unique `activeLock`.
  - Trigger.dev `idempotencyKey` deduplicates triggers.
  - Workers use upserts keyed by these ids, so a retried task can't duplicate side effects.
- **Consequences:** Retries (up to 5, with exponential backoff) are safe. Permanent errors abort without retrying.

## ADR-010 — Citations are validated against persisted sources

- **Status:** Confirmed (requested by the product owner)
- **Decision:** Every source shown to a research model is first persisted in `sourceArticles`. Briefs refer to sources by label (`S1..Sn`), and the labels map to DB ids.
  - A claim citing an unknown label is dropped and counted.
  - The claim's evidence excerpt must be found in that source's stored text to be marked `verified`; otherwise it's marked `excerpt_not_located`.
  - URLs, publishers and dates always come from the DB, never from model text.
- **Consequences:** An editor revisiting a brief sees exactly which evidence supported each claim, even if the live web page has changed since.

## ADR-011 — Shortlist quality is fixed; shortfalls are explained, not filled

- **Status:** Confirmed (requested by the product owner)
- **Decision:** The 65 threshold and the gates are fixed inputs to ranking. Every candidate gets exactly one recorded outcome. When fewer than 5 qualify, the run stores `shortfallReasons` derived from its funnel, and the operations dashboard shows them.
- **Consequences:** Some days will have short lists. That is intended behaviour.

## ADR-012 — Bounded revisits of previously seen sources

- **Status:** Confirmed (requested by the product owner)
- **Decision:** Known URLs are re-checked only when they're tied to recent relevant stories or reappear in search, at most once every 48 h and at most 10 per run. Unchanged content (by normalized hash) costs no AI call. Changed content is classified by Haiku as `cosmetic`, `updated_reporting` or `new_development`.
- **Consequences:** The system can tell updated reporting apart from genuinely new developments without repeatedly processing unchanged articles.

## ADR-013 — We own the indexes on Better Auth's collections

- **Status:** Confirmed (found by a failing test, 2026-10-14)
- **Context:** The Mongo adapter only creates indexes declared in Better Auth's table `indexes`. By default none are declared, so `email: unique` was **not** enforced by the database.
- **Decision:** `ensureIndexes()` (also run as `pnpm db:indexes`) creates the following, with `omenai_`-prefixed names:
  - `user.email` (unique)
  - `session.token` (unique) and `session.userId`
  - `account.(providerId, accountId)` (unique) and `account.userId`
  - `verification.identifier`
- **Consequences:** Run `pnpm db:indexes` on every deploy. A test asserts that the unique email index exists.

## ADR-014 — Nothing touches secrets or the database at build time

- **Status:** Confirmed
- **Decision:**
  - The Better Auth instance is created lazily (`getAuth()`), and the auth route resolves it per request.
  - Server components read request data (`headers()`, `params`, `searchParams`) before calling auth or DB code, so `cacheComponents` prerendering stops before reaching them.
- **Consequences:** `next build` succeeds without production secrets. A missing variable surfaces at request time as a `ConfigError` (route handlers return a 503 with code `NOT_CONFIGURED`).

## ADR-015 — Build-script approvals

- **Status:** Provisional
- **Decision:** In `pnpm-workspace.yaml` `allowBuilds`, `mongodb-memory-server` is denied (mongod is downloaded lazily by a Vitest `globalSetup`). `@depot/cli` (a trigger.dev CLI dependency for remote deploy builds) is denied too.
- **Consequences:** Revisit `@depot/cli` when first running `trigger deploy` (Phase 6).

## ADR-016 — Provider-agnostic LLM layer: Gemini in development, Anthropic in production

- **Status:** Confirmed by the product owner (2026-10-15)
- **Context:** Development uses Google Gemini (free API tier). Production must run on Anthropic Claude. Switching must not touch business logic.
- **Decision:**
  - `packages/core/src/llm/` exposes one interface, `LlmClient`, with `generateObject` (a Zod schema in, a validated object out) and `generateText`. Every pipeline stage (triage, evaluation, research, chat, generation) uses only this.
  - Two adapters, `providers/gemini.ts` (`@google/genai`) and `providers/anthropic.ts` (`@anthropic-ai/sdk`), each own their request formatting, schema dialect, effort/thinking mapping, stop reasons, token usage and error mapping. They normalise everything to `ProviderResponse` and `LlmError { kind, retryable }`.
  - The active provider comes from `LLM_PROVIDER` (`gemini` | `anthropic`) with `GEMINI_API_KEY` / `ANTHROPIC_API_KEY`. Model IDs are per tier, with defaults only in `llm/config.ts` and overrides via `<PROVIDER>_MODEL_<TIER>`.
- **Capability differences handled in adapters** (verified against SDK types and docs on 2026-10-15):
  - **Structured-output schema dialects differ.**
    - Gemini `responseJsonSchema` supports min/max and minItems/maxItems, but not `minLength`, `maxLength`, `pattern` or `const`.
    - Claude structured outputs reject numeric and length constraints and array bounds, and require `additionalProperties: false` on every object.

    Each adapter rewrites the neutral JSON Schema (from `z.toJSONSchema`) into its dialect and moves dropped constraints into field descriptions. The shared client **always re-validates with the full Zod schema** and runs at most **one** repair round.

  - **Gemini schema budget (found live, 2026-10-15).** The 9.6k-character evaluation schema (130 enum values, 8 numeric ranges, 11 array bounds) was rejected with a bare `400 INVALID_ARGUMENT`; the smaller triage and cluster schemas passed. Community reports point to a constrained-decoding state budget (about 120 enum values; bounds add states). The Gemini adapter therefore:
    - moves numeric bounds and array sizes into descriptions
    - describes, rather than enforces, enums with more than 20 values (e.g. the 55 subcategories)

    The shared client still validates the full Zod contract and repairs once. A test keeps the evaluation schema within this budget.

  - **Gemini counts reasoning tokens against `maxOutputTokens`.** The adapter adds headroom per effort level. The live test used 533 reasoning tokens for a 129-token answer.
  - **Effort.** Claude uses `output_config.effort`; Gemini uses `thinkingConfig.thinkingLevel`.
  - **Refusals.** Claude Sonnet and Opus calls opt into server-side refusal fallback (`fallbacks: 'default'`, beta `server-side-fallback-2026-07-01`). Haiku has none. Gemini safety finishes map to `safety_blocked`.
  - **Prompt caching.** The Claude system prompt carries `cache_control`. Gemini has no equivalent in this adapter yet.
  - **Errors.** 429 maps to `rate_limited`, and 5xx/529/network to `unavailable`; both are retryable by Trigger.dev. Auth errors, invalid requests, refusals, safety blocks, truncation and invalid output are permanent.
- **Free-tier constraints observed:**
  - Pro-class Gemini models (`gemini-4-argon`, `gemini-3.1-pro-preview`) return 429 on this key, so the dev escalation tier is `gemini-3.8-flash` with high thinking.
  - The free tier occasionally returns 503 under load.
  - Per the Gemini API terms, unpaid-quota content is used to improve Google products and may be read by human reviewers, so don't send confidential material in dev.
- **Verification:**
  - Contract tests for both adapters run against intercepted HTTP through the real SDKs.
  - A provider-switch test runs the same business function under both providers.
  - An isolation test fails if any non-adapter file imports a provider SDK.
  - A live test (`LLM_LIVE_TESTS=1`) passed against Gemini.
  - **Before production:** set `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`, run the live test and the full regression suite, and confirm the isolation test still passes.
- **Consequences:** Usage is recorded per call in `aiUsage` (provider, model, tier, operation, tokens, outcome), with no hard-coded prices.

## ADR-017 — Authentication: invite-only email + password

- **Status:** Confirmed by the product owner (2026-10-15). Supersedes the Google OAuth parts of ADR-005.
- **Decision:**
  - Better Auth `emailAndPassword` (12–128 characters, scrypt hashing, auto sign-in after setting the password, sessions revoked on password reset).
  - Owners invite by email with a role. The invitee sets name and password at `/invite/[token]`. `POST /api/invitations/accept` performs the sign-up server-side, with the email from the invitation and the token passed as the `omenai_invite` cookie header.
  - **Two gates inside Better Auth**, so the public endpoints are safe even when called directly:
    1. `hooks.before` on `/sign-up/email` rejects requests without a claimable token for that email with a uniform 403. Without this gate, Better Auth would answer 422 "user exists" for registered emails, which reveals which emails have accounts.
    2. `databaseHooks.user.create.before` atomically claims the invitation and sets the role and `emailVerified: true` (the link proved inbox control).
  - The session-create hook reads the user through Better Auth's transaction-aware adapter, because sign-up creates the user and its first session in one transaction. Mongoose couldn't see the uncommitted user, which a test caught.
  - The rate limiter uses database storage, so it works across serverless instances.
- **Verified:** core e2e tests through Better Auth's HTTP handler, and an HTTP smoke test on the running app (invite → password → session → sign-out → sign-in, plus reuse, public sign-up and wrong-password cases).
- **Open:** password reset and invitation emails need Resend (Phase 3). Until then, invitation links are shown to the owner to copy, and reset is unavailable.

## ADR-018 — MongoDB Atlas configuration and network access

- **Status:** Confirmed (verified 2026-10-15)
- **Findings:**
  - The cluster is a replica set (`atlas-1wcikv-shard-0`, MongoDB 8.0.34), so the transactions Better Auth needs work.
  - Read, write, index, delete and transaction operations all succeed in database `omenai`.
  - `pnpm db:indexes` was applied.
  - The Trigger.dev dev worker reached Atlas (the `ops-database-ping` run).
- **Security findings to fix before production:**
  1. The provided DB user has `atlasAdmin`. Create an app-only user with `readWrite` on `omenai` and use that in all environments.
  2. The password is weak and has been shared in chat. Rotate it.
- **Network access:**
  - Vercel functions and Trigger.dev (non-paid plans) use dynamic egress IPs. Either allow `0.0.0.0/0` together with the least-privilege user and a strong password, or move to Trigger.dev's paid static IPs (and Vercel Secure Compute, Enterprise) and allowlist those.
  - Local development needs the developer's IP, or the open rule.
- **Consequences:** `MONGODB_URI` lives only in gitignored env files and in deployment secrets (Vercel and Trigger.dev environment variables).

## ADR-019 — Tavily via its SDK; agent tooling not installed

- **Status:** Confirmed (2026-10-15)
- **Context:** Tavily's agent-setup `SKILL.md` covers two different things:
  - integrating Tavily into an application (Path B: `@tavily/core` plus `TAVILY_API_KEY`)
  - installing a global CLI (`curl … | bash`), global Claude Code skills, an MCP server, browser OAuth, and scanning local folders for repositories
- **Decision:** Only Path B. `@tavily/core` is installed in `@repo/core`. The machine-wide tooling wasn't installed: it changes the developer's global environment, pipes a remote script into a shell, and the deployed worker can't use a CLI OAuth credential anyway. It can be installed later on explicit request.
- **Verified (2026-10-15):** a live search and extract with the provided key (see VERIFICATION.md).
- **Implications for Phase 2:**
  - Request `includeUsage` so `aiUsage` records credits per call (search with basic depth costs 1 credit).
  - Batch extracts in multiples of 5 URLs, since extract is billed per 5 successful URLs.
  - Parse RFC 1123 `publishedDate` strings during normalisation.
  - Expect raw results to include listicles, brand promotions and sales listings; the editorial gates must filter them, and real examples are kept as test fixtures.
- **Note:** the key is a development key (`tvly-dev-…`). Check in the Tavily dashboard whether production should use a separate key with higher limits.

## ADR-020 — Trigger.dev project wiring

- **Status:** Confirmed (2026-10-15)
- **Decision:**
  - `apps/worker/trigger.config.ts` uses project `proj_ydafdiqitotsvbyazmaw` (not a secret), `dirs: ['./src/trigger']`, `runtime: 'node-24'`, `maxDuration: 3600`, and default retries of 5 with exponential backoff.
  - `@trigger.dev/sdk`, `trigger.dev` and `@trigger.dev/build` are pinned at 4.7.4. `.trigger/` is gitignored.
  - The web app triggers tasks with `TRIGGER_SECRET_KEY`. The CLI authenticates with `trigger login`. Worker env vars come from `apps/worker/.env` locally and from the Trigger.dev dashboard when deployed.
- **Notes:**
  - The CLI's `tsconfck` declares a TypeScript ^5 peer while the repo uses 6.0.3. `trigger dev` built and ran fine.
  - pnpm reports "agent skills awaiting approval" for `@trigger.dev/sdk` and `trigger.dev`. They were left unapproved.

## ADR-021 — Discovery pipeline design and cost controls

- **Status:** Implemented (2026-10-15). Verified with fixtures only; no live run yet.
- **Shape:**
  - `prepareRun` runs discover → revisit → extract → triage → cluster.
  - `evaluateStory` runs once per candidate, in parallel Trigger.dev child tasks.
  - `finalizeRun` ranks and accounts for every candidate.
  - All of it lives in `packages/core/src/discovery/pipeline/`, so tests and `runDiscoveryInline` use exactly the code the worker runs.
- **Resumption:** each stage persists its own results and records itself in `completedStages` with its stats. A resumed run skips completed stages, so it doesn't search, extract or triage (and pay) twice. Clustering skips articles already placed in a story created by the same run. Evaluation is idempotent per run. Finalize records each recommendation once per run.
- **Cost controls (all deterministic, before any model call):**
  - **URLs:** canonicalisation (https, no `www`, no tracking parameters, sorted query, no trailing slash) dedupes articles.
  - **Syndicated copies:** titles with ≥ 0.75 token similarity are always grouped, whatever the model returns.
  - **Revisits:** an unchanged content hash, or text ≥ 0.97 similar (word 5-shingle Jaccard), costs no model call.
  - **Suppression:** repeats and skipped developments identified at clustering are never evaluated.
  - **Batching and caps:** triage is batched (8 articles per call on the triage tier). Extraction, triage excerpts, clustering items, evaluations (25) and escalations (4 per run, atomic) are all capped.
  - **Schedule:** the daily schedule only exists in Trigger.dev **production**, so development never spends on a timer.
- **Model output safety:**
  - Articles are labelled `A1…`, stories `S1…`; models never output URLs.
  - Cluster output is normalised into a valid partition: each article exactly once, unknown story labels degrade to "new". If clustering fails permanently, each article becomes its own "new" story.
  - Triage failures send articles forward rather than dropping them. Transient model errors propagate, so the task retries.
- **Deadlines:** start + 2 h (soft), + 3 h (extension, used only if fewer than 3 candidates were evaluated), + 4 h (hard). They are relative to the run's first start, so there's no wall-clock DST arithmetic. Evaluations that finish after the set closes are recorded as `deferred_late`. Unevaluated candidates stay pending and carry over to the next run while fresh.
- **Retries:**
  - Each evaluation task retries up to 5 times (5 s to 120 s, exponential, randomised) and aborts immediately on permanent errors (configuration, auth, invalid request, refusal, invalid output).
  - The orchestrator retries up to 3 times, and the run lease (30 min, renewed while polling) prevents duplicate execution.
- **Known limitation:** `@tavily/core` 0.7 drops HTTP status codes, so search errors are classified from the message text (`classifyTavilyError`). Unknown errors are treated as transient.
