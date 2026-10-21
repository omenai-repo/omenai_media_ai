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

## ADR-022 — Light-only editorial theme and one plain-language copy layer

- **Status:** Implemented (2026-10-15), reviewed in a browser. Palette and type superseded by ADR-040 (2026-10-20); the light-only decision, the copy layer and the accessibility rules stand.
- **Decision:**
  - One art-directed light theme: paper, bone and ivory grounds, ink text, hairline rules, one terracotta-ochre accent, and muted moss, amber and oxide for status.
  - The `prefers-color-scheme: dark` tokens are removed and `color-scheme: light` is set. Dark mode is post-MVP.
  - Display type is Instrument Serif (headlines only), reading type is Newsreader and interface type is Geist, on a fluid `clamp()` scale.
- **Why:** the product owner wants a premium cultural publication, not a console. One carefully tuned theme beats two half-tuned ones in the time left before Nov 1.
- **Copy:** every editor-facing label for an internal state lives in `apps/web/src/components/editorial/copy.ts`. Outcome sentences come from the pure, tested `reviewReason()` in `@repo/shared`. Raw ids (run keys, gate ids, outcome codes) appear only inside "Technical details" disclosures.
- **Accessibility:**
  - All text pairs pass WCAG AA (computed).
  - Status is never shown by colour alone (icon plus words).
  - Native `<details>` for disclosure.
  - Visible 2px focus ring.
  - `prefers-reduced-motion` respected.

## ADR-023 — Story imagery: linked publisher preview images, rights unverified

- **Status:** Implemented (2026-10-15). Fixture-verified; live Tavily image behaviour unverified.
- **Capture (no model calls):**
  - Tavily extract is called with `includeImages: true`.
  - `pickPreviewImage()` keeps the first candidate that is https, at most 2,048 characters, not svg/gif/ico or a data URL, and free of logo, icon, avatar, tracking, badge, banner or ad patterns.
  - Alt text comes from the extracted markdown when present.
  - Stored on `SourceArticle.image` as `{url, alt, capturedAt, rights: 'unverified'}`. Revisits fill it only when missing.
- **Selection:** `selectRepresentativeImage()` runs at read time, never stored on the story. The order is: has an image → source quality → extracted text → earliest published → URL. It is deterministic and tested.
- **Isolation:** image data is never passed to prompts, gates, scores or ranking. A pipeline test asserts that no prompt contains an image URL and that the shortlist is identical with and without images.
- **Display:**
  - A plain `<img>` with `loading="lazy"`, `decoding="async"` and `referrerPolicy="no-referrer"`. `next/image` would proxy and needs a host allow-list, which suits neither arbitrary publishers nor the "no hosting" rule.
  - A fixed aspect ratio, so the layout doesn't shift.
  - A typographic fallback when there is no image or it fails, including failures before hydration.
  - The credit always says "Image: {publisher}, rights not cleared".
- **Not done (by decision):** downloading, hosting, resizing or processing images, and any assumption of republication rights.

## ADR-024 — Usage costs are estimates from a dated list-price table

- **Status:** Implemented (2026-10-15).
- **Decision:** providers report usage (tokens, credits), not billed amounts. `packages/core/src/ops/pricing.ts` therefore holds list prices with a `verifiedOn` date:
  - Anthropic per million tokens
  - Tavily pay-as-you-go per credit, with the free monthly allowance noted
  - the Gemini development free tier, shown as no charge
- **Presentation:** Operations groups usage into plain categories ("Finding stories", "Assessing stories", and later Research and Content).
  - Every figure is labelled **Estimate**.
  - A group with an unknown price shows "No estimate" rather than a partial total.
  - The page says actual charges appear only in each provider's billing dashboard.
- **Maintenance:** update the table and `verifiedOn` when prices change. The estimate is a planning aid, not accounting.

## ADR-025 — Research briefs and grounded chat

- **Status:** Implemented (2026-10-15). Fixture-verified; no live run yet.
- **Queries without a model call:** research searches come from the story itself (headline, named entities with the place, a background query for in-depth research). This saves a model call per task, and the queries are visible in the brief.
- **Persist first:** every new article is upserted into `sourceArticles` (`origin: research`) before the prompt is built, and the brief records each source's id and content hash. Research sources are **not** added to the story's own `sourceArticleIds`, so discovery's assessment and revisits are unaffected.
- **Citation statuses**, decided only against stored text:
  - `verified`: the quote was found after normalising quotes, dashes, whitespace and case, and it has at least 12 characters.
  - `excerpt_not_located`: shown with a warning.
  - `uncited`: analysis or an open question with no quote.
  - Facts and attributed claims citing nothing, or citing an unknown label, are dropped and kept in `droppedClaims` for the audit trail.
- **One task per story:** research and chat share one lock value on the task record (sparse-unique `activeLock`). A reply is never written against a brief that's still changing, and two editors can't double-spend. Abandoned locks (no progress for 45 minutes) are released on the next request.
- **Chat** has no web access (post-MVP), answers from the latest brief, and invented `[S#]` markers are removed from the text and recorded.
- **Fixture-only conveniences** (scenario seeding, `EMAIL_TRANSPORT=fixture-*`) are refused unless connected to a `*_fixtures` database (`isFixtureDatabase()`).

## ADR-026 — Research as a story-bound conversation

- **Status:** Implemented (2026-10-15). Fixture-verified.
- **Shape:**
  - One full-screen workspace per story (route group `(workspace)`).
  - Every brief and chat message is persisted and shown in time order. A focused follow-up brief is appended, never replacing earlier ones.
  - Briefs carry `requestKind`: `auto` (Omenai, on first open), `manual`, or `lead`.
- **Boundary, enforced on the server:**
  1. A triage-tier scope check (`about_story` / `related_lead` / `unrelated`) runs before each answer. `unrelated` gets a fixed reply written by the server; the answering model and the sources are never used for it.
  2. Follow-up research accepts only `fromMessageId` pointing to an assistant reply on the same story with a suggested focus and in-scope evidence. The focus is read from the database, not taken from the client.
  3. Research queries are built server-side from the story (and that focus). Results must pass `isRelevantToStory`.
- **Relevance check (lexical, no model call):**
  - **Anchors:** named entities from the assessment, multi-word proper-noun phrases from the headline or focus, and city names. A city counts once however many words it has. Countries, regions and common culture words never count on their own.
  - **Rule:** relevant means one anchor phrase, or two distinct anchors.
  - **Limits:** it can miss coverage that spells names differently or names no one, and it can admit coincidental matches. Admitted sources still go through citation checks.
- **Credits:**
  - A failed attempt's stored sources (`foundSourceIds`) are reused by a retry within 24 h for the same story and focus.
  - The automatic briefing is refused once a brief exists, so stale pages don't spend credits.
- **Development:** fixtures databases run tasks in-process with scripted answers after the response (`next/server` `after()`), because real Trigger.dev workers use the real database and services.

## ADR-027 — Concise briefs with evidence on demand

- **Status:** Implemented (2026-10-15). Fixture-verified.
- **Context:** the first briefings read like reports: five headed sections and an uppercase label on every claim. Editors want a colleague's summary first, with the evidence a click away.
- **Decision:**
  - **Named parts:** the brief output is `overview`, `whyItMatters`, `findings`, `toConfirm` and `background`, each an array of claims. The server assigns each stored section a `kind` and a fixed title; the model never writes headings.
  - **Length:** steered by the prompt (about 150–250 words across the first four parts) and by the field descriptions. Array limits stay generous, because output that fails validation costs a whole retry.
  - **Overview:** it is now claims, so it is cited and checked like everything else. The stored `overview` string (used in chat and scope prompts) joins only the claims that were kept.
  - **Presentation:** a pure web helper (`brief-digest.ts`) places claims, moves any misfiled open question into "Still to confirm", and writes the plain-language evidence summary from stored statuses. It never drops a claim or changes a status.
- **Unchanged:** the citation checks, statuses, persistence, the lock, background tasks and the story boundary.
- **Compatibility:** briefs stored before this change have no `kind`. They are placed by title, and their plain `overview` text is shown as before.

## ADR-028 — A guided editorial interface

- **Status:** Implemented (2026-10-15). Fixture-verified in the browser.
- **Context:** screens gave most elements equal weight, and editors had to work out the next step themselves.
- **Decision:**
  - **Three levels on every screen:** primary information, one primary action, and supporting detail on demand.
  - **Tokens:** shape and surfaces come from tokens (`--radius`, `.surface`, `.surface-quiet`, `--hairline-soft`, `--shadow-float`), not per-component values.
  - **Native disclosures:** the accordion stays `<details>`. It's accessible and works with find-in-page, and it animates only where `interpolate-size` is supported.
  - **The story page drives the workflow.** A read-only `getResearchStatus` query (counts and state, no content) chooses the primary action. The review → research → create → refine indicator is a guide, not a gate. A step that doesn't exist yet ("Create content") is labelled, never offered as a control.
  - **Operations answers questions** (did it finish, was it enough, what needs attention, is the next one on track, what are we using). Self-correcting items are listed but not counted as needing attention. Which items are self-correcting is decided on the server (ADR-030).
- **Unchanged:** the API contracts, schemas, authorization checks, citation and scope rules, and research task behaviour.

## ADR-029 — The content studio: append-only draft versions from checked research

- **Status:** Implemented (2026-10-16). Fixture-verified (automated and in the browser). No real model has written a draft yet.
- **Shape:**
  - **Formats:** five, defined once in `@repo/shared/editorial/drafts.ts` with their limits:
    - Weekly Briefing item: about 150–300 words, with a headline
    - editorial article: about 800–1,500 words, with a headline
    - LinkedIn post: up to 3,000 characters
    - Instagram caption: up to 2,200 characters
    - X post: up to 280 characters

    The server and the editor's live counter use the same `measureDraft`.

  - **Storage:** `draftVersions` holds one document per version.
    - `version` is unique per story and format, and `taskId` is sparse-unique, so a retried task never writes twice.
    - Versions are only ever added; nothing updates or deletes one.
    - Saving an edit adds an `edited` version, but only when the text differs from the latest version (line endings and trailing spaces don't count).
    - Restoring an old version saves its text again as the newest version.
    - A version someone else saved meanwhile is never overwritten. Both stay, and the client says so only when the edit began on the then-latest version.
  - **Generation:**
    1. `POST /api/stories/[id]/drafts` records a `generate` task and hands it to the worker.
    2. The task holds a lock per story and format, so different formats can be written at once and research or chat is never blocked.
    3. The `generate-draft` task (3 attempts, model only, no search) writes from the newest three briefs as they stood when the draft was requested. Each claim is tagged with how it was checked, and the editor's note is fenced as data.
    4. A revision includes the version it revises.
    5. The response is plain text plus a list of the statements it made, which are checked against stored source text with the research citation checks (`checkClaims`). The body never carries source labels; any that slip in are stripped.
  - **Channel limits:** over a character limit, the model is asked once to shorten the draft. If it's still over, the shorter answer is saved and flagged in the studio, never cut silently. Word ranges are guidance, not errors.
  - **Prerequisite:** a story needs a research brief before any draft (`NO_BRIEF`, 409).
- **Studio:** `/stories/[id]/studio`, a full-height workspace like research, sharing its header (`WorkspaceHeader`).
  - **Layout:** formats on the left, the editor in the middle, and "Before you use it" (statement checks, what the research still needs confirmed, image rights) plus version history on the right. These sit below the editor on narrower screens.
  - **Unsaved edits:** kept per version in memory. Switching formats or versions never loses typing, and leaving the page with unsaved edits asks first.
  - **Copy:** copies the headline and body. Nothing is published.
- **Story page:** the next action becomes "Create content", then "Continue drafting", once research is ready (read-only `getDraftStatus`).
- **Not decided here:** publishing, scheduling and channel accounts are out of scope. Live model quality (voice, length, how faithfully statements are listed) is unverified until an approved live run.

## ADR-030 — Retries are classified on the server; fixture searches run in-process

- **Status:** Implemented (2026-10-16).
- **Retries:**
  - **One table of limits:** `TASK_MAX_ATTEMPTS` in `tasks/contracts.ts` sets the most attempts per task kind. The worker configures its tasks from it, and Operations reads it, so "attempt 2 of 5" always matches what runs.
  - **`automatic` flag:** every attention item now carries one, set on the server.
    - Work that is retrying is automatic.
    - It stops being automatic when the last attempt fails, when the error can't be fixed by retrying, or when a retry has been quiet for 45 minutes (`RETRY_STALLED_AFTER_MS`, the same window as an abandoned research lock).
    - A lapsed discovery run is automatic only while it has attempts left and lapsed recently.
  - **Not listed twice:** a failure that an editor already superseded (a later request of the same kind for the same story, and for drafts the same format) disappears. An exhausted assessment that its edition already reports isn't listed again.
  - **Interface:** the page lists "Needs attention" and "Retrying on its own" separately.
- **Fixture search:**
  - **Before:** `POST /api/runs` called Trigger.dev even against a fixtures database. A dev worker would then have run real discovery against the real database.
  - **Now:** against a `*_fixtures` database it runs the real pipeline in-process after the response (`runFixtureDiscovery`), with scripted search and answers and simulated usage, like research and chat (ADR-026). It refuses any other database.

## ADR-031 — A guarded fixture path in the worker, to verify the real engine without AI spend

- **Status:** Implemented (2026-10-16). Used once to verify `generate-draft` through Trigger.dev (VERIFICATION.md).
- **Context:** the web app never sends fixture work to Trigger.dev (ADR-026). That keeps fixtures safe, but it also means the real engine (registration, queueing, attempts, retries, idempotency keys) was never exercised for drafts.
- **Decision:**
  - The `generate-draft` task uses the scripted writer from `@repo/core/fixtures` only when both are true:
    - the configured database name ends in `_fixtures`
    - the run's Trigger.dev environment isn't `PRODUCTION` (`ctx.environment.type`)

    Otherwise it uses the configured provider.

  - **Retry hook:** an editor's note containing `[fixture: fail the first attempt]` makes the scripted writer's first attempt fail with a transient outage, so the engine's own retry can be watched. Only the fixture writer reads it.
  - **Verification setup:** the dev worker runs from its own env file with the fixtures database and empty Gemini, Anthropic and Tavily keys, so nothing metered is reachable even by mistake.
- **Also:** malformed task payloads and 4xx application errors (invalid, not found, not allowed) are now permanent failures that abort at once. 409 conflicts stay retryable.
- **Not extended:** research and chat tasks have no worker fixture path yet. They are verified in-process only.

## ADR-032 — Count characters by each channel's rules, never fewer; describe checks exactly

- **Status:** Implemented (2026-10-16).
- **Character counts:**
  - **X:** follows X's published weighting, checked 2026-10-16 against docs.x.com/fundamentals/counting-characters and twitter-text `config/v3.json`.
    - Text is normalised to NFC.
    - U+0000–U+10FF, U+2000–U+200D, U+2010–U+201F and U+2032–U+2037 weigh 1; everything else weighs 2.
    - Every emoji sequence weighs 2, and every link weighs 23.
  - **Links X might not recognise:** where we can't know whether X will treat text as a link (a bare domain, an unusual TLD), the count is a range. A post is only "within the limit" when the top of the range fits; otherwise the studio says to check the count in X. We didn't add the `twitter-text` library: its last release is from 2020, it's large for the browser, and the conservative range covers the cases where it and X could differ.
  - **Instagram and LinkedIn:** they publish no exact rules, so we count UTF-16 units after NFC. That is never fewer than characters, and every emoji counts as at least 2.
- **Evidence wording:** a citation whose quoted passage is found in the stored source is a **source check, not a fact-check**. It shows where a statement came from, not that it is true or that the passage supports it.
  - The studio says so first, labels a match "Quoted passage found in the source. Read it to confirm it supports this" (with a quote icon, not a tick), and states that unlisted statements aren't checked at all.
  - The citation popover (shared with research) reads "Found: … That shows where the point comes from, not that it's correct."
  - Text that promised "only checked facts are stated as fact" now says what Omenai is told to do.

## ADR-033 — An explicit runtime, and live development by default

- **Status:** Implemented (2026-10-16). Verified with a bounded live run (VERIFICATION.md).
- **Context:** local work had switched to mocks implicitly, whenever the database name ended in `_fixtures`. A missing `MONGODB_DB_NAME` silently meant `omenai`. The web app (`omenai_fixtures`) and the worker (`omenai`) were configured with different databases, and nothing compared them.
- **Decision:**
  - **`OMENAI_RUNTIME` is required.** It is `live-dev`, `fixtures`, `production` or `test` (Vitest only). The database name must agree with it (`_dev`, `_fixtures`, or neither), and both are checked whenever the database client is created. `isFixtureRuntime()` is the single gate for every mocked path.
  - **Dispatch is checked on both sides.** The web app sends Trigger.dev only from a key matching its runtime (`tr_dev_` for live development). Task payloads name the database, and the worker aborts, untouched, on a different database or Trigger.dev environment.
  - **Live development uses Gemini only.** Another `LLM_PROVIDER` is refused there.
  - **Hard rolling 24-hour limits** (`AI_DAILY_CALL_LIMIT`, `SEARCH_DAILY_CREDIT_LIMIT`, required in live development) are checked before every real request, from our usage records. A refusal is a permanent `UsageLimitError`, so no retry spends past it.
  - **Fixture accounts** can't be invited outside the fixtures runtime.
  - **`pnpm env:check`** compares both env files without printing secrets, and can also ping the database and read Tavily's usage endpoint.
- **Not changed:** fixtures, scripted providers and every test harness remain. Automated tests run in the `test` runtime against an in-memory database. The production schedule stays production-only.
- **ADR-031 amended:** the worker's scripted draft writer now requires the fixtures runtime, not merely a `_fixtures` name.

## ADR-034 — What the first live run changed

- **Status:** Implemented (2026-10-16). Each item came from the live run; VERIFICATION.md records how each fix was tested.
- **Gemini overload.** `gemini-3.8-flash` answered 503 "high demand" for over 15 minutes.
  - The adapter now retries 429 and 5xx inside a call (4 attempts, about 15 seconds; rejected requests aren't billed), matching the Anthropic adapter's SDK retries.
  - Live development's primary and escalation tiers were moved to `gemini-3.5-flash-lite` by environment override, the product owner's choice.
- **A discovery run waiting for its next attempt reads as retrying, not failed.** Only the last attempt, or a permanent error, fails it. A queued run waiting to retry counts as active, so a second manual run can't double it. Operations shows it as retrying automatically, and as needing attention if it goes quiet.
- **Work stranded by a failed run is adopted.** The next run triages what a failed run extracted and clusters what it triaged into no story. Clustering also skips any article already in a story, so nothing is clustered twice. Live: the third run adopted the 8 articles two failed runs had left. Once a later run completes, a failed run no longer counts as needing attention.
- **Quote matching ignores Markdown formatting.** Stored pages are Markdown, so an exact quote of an italicised title or a link's text was reported as not found. Emphasis, links, images, code marks and escapes are now stripped from both sides before matching; the words still have to match exactly.
- **Silent stops are visible.** Work that stops without recording an error reads as stopped after 45 minutes (the abandoned-lock window), with "Try again", in research, the studio, the story page and Operations.
- **Costs are never assumed free.** Gemini is estimated at paid list prices (checked 2026-10-16), with a note that the free tier charges nothing; the app can't tell which tier a key is on.
- **Wording follows the runtime.** Development pages no longer promise a nightly edition. Failure text names the service (AI or search) and recognises overload and the development usage limit.

## ADR-035 — Chat replies stream from the web app; long work stays on Trigger.dev

- **Status:** Implemented (2026-10-16), approved by the product owner. Verified offline and live (VERIFICATION.md, "Chat latency, scope, streaming and accuracy").
- **Context:** an ordinary question took 53 s, 67 s and 237 s in live development. The records showed where the time went:
  - Trigger.dev queueing and worker start-up took about 5–6.5 s per turn (one 19 s outlier). The trace of the 237 s turn: run created 1.7 s after the task record, attempt started 1.8 s later, first database write about 3 s after that.
  - Two model calls in a row took the rest: a separate scope check (26–219 s for about 40 output tokens; nothing bounded a call) and the answer at medium thinking.
  - Nothing streamed: the page polled every 3 s for a finished, saved reply.
- **Decision:** the chat route answers a question itself and streams the reply.
  - `POST /api/stories/[id]/chat` checks permission, saves the question (the story's lock and task record as before), then returns newline-delimited JSON: `accepted`, `started`, `retrying`, `text` (the visible answer so far), `checking`, then `done` with the saved reply or `failed`.
  - The reply is one call through `LlmClient.streamObject` (ADR-036). Every statement's quote is checked against the stored sources before the reply is saved, exactly as before.
  - **The reply doesn't depend on the connection.** It runs to the end and is saved even if the tab closes or reloads (`after()` keeps the work alive within the route's `maxDuration`). A reload shows "Writing a reply…" and polls until it is saved.
  - **Stop** (`DELETE /api/stories/[id]/chat`) flags the task. The reply ends at once if this server instance runs it, otherwise within about a second (it polls the flag). Nothing of it is saved; the question stays.
  - Research, focused follow-ups, drafts and discovery stay on Trigger.dev: they search, run for minutes and benefit from durable retries.
- **Trade-offs:**
  - The web app now holds the model key (server-only, never `NEXT_PUBLIC_`) and the daily limits, identical to the worker's; `pnpm env:check` compares them by fingerprint. The Tavily key stays out of the web app.
  - Chat has no background retries: one attempt (`TASK_MAX_ATTEMPTS.chat = 1`), one quick retry of a rejected request inside the call, then a visible failure with "Ask again".
  - A reply's lock counts as abandoned after 2 minutes, not 45, because the route is capped at 90 s.
  - On Vercel, finishing after a disconnect relies on `after`/`waitUntil` within `maxDuration`. Verified on `next start`; not yet on a deployment.
  - The `chat-reply` Trigger.dev task was removed.
- **Also:** the worker reuses warm processes between runs (`processKeepAlive`), so research and draft runs don't each pay for a new process and database connection. Measured cost of a fresh process: 2.6–21.9 s of start-up in development (VERIFICATION.md).

## ADR-036 — One call decides scope and answers; focused follow-ups answer the question; bounded calls

- **Status:** Implemented (2026-10-16). Verified with scripted tests and a bounded live evaluation (VERIFICATION.md).
- **Scope inside the answer.** The separate `chat.scope` call (a triage model told only "about the story itself" or "directly connected") refused "Does this story appeal to Omenai's focus on contemporary art?" live, twice.
  - It is gone. The answer's structured output starts with `scope`: about_story, editorial (fit with Omenai's priorities, audience, territory from the playbook taxonomy, angles), related (wider art and culture questions) or unrelated.
  - Only unrelated questions are redirected, with fixed server-written text: when the streamed scope reads `unrelated`, the call is stopped and nothing the model drafted is shown.
  - The prompt says outright that going beyond the exact story is never by itself a reason to refuse.
- **Answers as checked statements.** A reply is a list of statements, each with its own sources and its own word-for-word quote, so every citation sits next to the claim it is offered for (it used to be one quote per source label for the whole reply). Statements are checked with the briefs' `checkClaims`; unsourced facts and unknown labels are dropped and counted.
- **Exact facts.** The chat and focused-research prompts forbid substituting a related fact ("a start date, an earlier role or a general career date does not establish the date of a specific appointment") and require saying plainly when the evidence doesn't settle a question, before giving the closest established fact marked as different.
- **Focused follow-ups answer the question.** A lead used to produce a full brief (overview, significance, background, unrelated open questions) around its answer. It now uses `FOCUSED_RESEARCH_SYSTEM_PROMPT` and a focused schema: the answer (1–4 statements, the direct answer or "not established" first), how fully the sources answer it, at most two open points and two next steps. Stored as sections `answer` and `to_confirm`, with the brief's `evidence`. Lead searches no longer repeat the subject ("Alisa LaGamma When was Alisa LaGamma…").
- **A deterministic safeguard for dates and figures** (`detail_not_in_excerpt`, in every claim check: briefs, drafts, chat). A fact or attributed claim whose found quote lacks a date or figure the claim states is flagged for checking.
  - **It is not a support check.** It can only lower confidence. Passing it upgrades nothing: a quote can contain the right year and still describe something else ("a curator since 1996" is not "appointed Pulitzer Curator in 1996"). Whether a passage supports a claim stays the editor's judgement, with each statement's quote shown beside it.
- **Every model call is bounded** (provider-neutral, enforced by the client, which stops waiting at the deadline even if an SDK is between retries):

  | Work                                   | Per attempt                   | Retries inside the call                | Per call (hard)                                                                            | Outer limits                                      |
  | -------------------------------------- | ----------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------- |
  | Chat reply (streamed)                  | 25 s, capped at the time left | 1, on 429/5xx before any text          | the chat deadline (60 s from the request) less 5 s to save; a repair only with ≥ 10 s left | route 90 s; lock stale after 2 min                |
  | Background (briefs, drafts, discovery) | 180 s (slowest seen: 132 s)   | the adapter's 4 attempts, 2–10 s apart | 240 s                                                                                      | Trigger.dev retries and each task's `maxDuration` |

- **Instrumentation.** Every call records its wall time, time to the first streamed piece, HTTP attempts, the status of each failed attempt and, for a repair round, the schema paths that failed (no content). In-call retries were invisible before (L14).
- **Provider-neutral, ready for routing by task.** Streaming, deadlines, retry policy and attempt records are neutral types that each adapter maps. A provider without streaming still works (the client hands its whole answer over at once). Callers name only an operation, a tier and an effort, so a later router can implement `LlmClient` and send different operations to different providers (for example by measured strength) without touching callers. Nothing in this change integrates OpenAI or Anthropic or moves off Gemini; the Anthropic adapter has no streaming yet.

## ADR-037 — Progress comes from recorded steps; draft text streams through the task record; text is revealed at a steady pace

- **Status:** Implemented (2026-10-17). Verified with tests and fixture browser walks. The live comparison of draft reasoning levels ran on 2026-10-17 (10 calls): medium stays; switching LinkedIn posts to low is offered to the product owner (VERIFICATION.md).
- **Context:**
  - **Chat text arrived in bursts.** The live model sent each whole answer in 1–7 pieces within 0.14–0.58 s, after a 3–9 s wait. Printed on arrival, it read as a jolt.
  - **Progress was partly static and partly wrong.** Research showed a fixed five-step list, in which a step that was skipped appeared done. Chat showed one label; drafts, one sentence from the server. A refresh lost everything but the current step's name.
  - **Drafts showed nothing until saved.** They took 38–51 s in development; the model was 9–18 s of that (VERIFICATION.md).
- **Decision:**
  1. **Every task records its own steps** (`progressRecorder`; step ids in `@repo/shared` progress):
     - **Research:** sources, search, read, write, check.
     - **Drafts:** research, write, statements, shorten, check, save.
     - **Chat:** read, compose, write, check.

     Each step records when it began and counts of what it found (never content). A passing notice covers the current step: `retrying` when the AI service turned a request away and it is being sent again, `repairing` for a correction round. Both come from provider-neutral `LlmClient` callbacks (`onRetry`, `onRepair`).

     Writes never hold the work up. They go in the background and in order, collapse to the latest state while one is in flight, and apply only while the task is running. The final steps are written with the outcome, in `completeTask`'s single update. Each attempt starts afresh.

  2. **The interface shows only recorded steps:** done (with what each found), under way, and still to come.
     - A step the work went past is shown as skipped. A step that happens only sometimes (shortening) is listed only once it happens.
     - Waiting to start, starting, and waiting to try again ("attempt 2 of 3") are told apart.
     - A step that runs unusually long gets an honest note. The thresholds come from development timings, measured against the server's clock.
     - Nothing rotates, and no activity is invented.
     - A reload reads the same record, so it continues rather than starting over.
  3. **Chat** sends one more stream event, `context` (how many briefs and sources were read), and records the same steps on its task. A page opened mid-reply shows where the reply has got to. Its text arrives with the saved reply, because the stream belongs to the page that asked. This replaces the "Writing a reply…" placeholder described in ADR-035.
  4. **Drafts stream into the Studio through the task record.**
     - The worker streams the model call and writes the text so far to `progress.preview`, at most every 0.5 s and without waiting on the write.
     - While a draft runs, the Studio reads a one-query endpoint every second (`GET /api/stories/[id]/drafts/progress`). It shows the text read-only, marked "In progress · not yet checked or saved".
     - The preview is dropped when the task ends, whatever the outcome. Only the validated, checked output is saved as a version.
     - Drafting stays on Trigger.dev, so it keeps durable retries. There is no new service and no browser connection to Trigger.dev.
  5. **Streamed text is revealed at a steady pace in the browser** (`components/progress/reveal.ts`).
     - Text is revealed word by word, at the speed that finishes what has arrived by its deadline: within 1.2 s of arriving, or 0.4 s once the answer is complete. It is never slower than 120 characters a second.
     - A word still arriving is held back until it is whole.
     - The caret is solid while words arrive and blinks slowly while it waits.
     - With reduced motion, text is shown exactly as it arrives and the caret is steady.
- **Alternatives rejected:**
  - **Trigger.dev Realtime streams to the browser.** They need public access tokens and make the browser depend on Trigger.dev. The task record already carries progress, and polling already reads it.
  - **Moving drafts into the web request, like chat.** It would lose durable retries, and a draft can take two calls of up to 240 s each.
  - **Delaying the whole response, or rotating "thinking" messages.** The brief rules both out. Every label is a step the work recorded.
- **Trade-offs:**
  - **The draft preview updates about once a second** (written at most every 0.5 s, read every 1 s). The reveal smooths the steps between updates.
  - **More database writes per task:** one per step and per preview update. All are off the critical path and apply only to running tasks.
  - **After a reload, chat shows the steps but not the text** until the reply is saved.
  - **The "longer than usual" thresholds come from development timings.** Revisit them with production timings.
- **Also:**
  - **The draft task makes fewer round trips.** It reads independent records together, doesn't wait on progress writes, and the worker no longer completes the task a second time. Database work per draft fell from 1,490 ms to 963 ms in development (median of 7 rounds, VERIFICATION.md).
  - **The draft model's reasoning level stays at medium** (`DRAFT_EFFORT`). Measured live: low wrote first words in about 1.2–1.5 s instead of 6–14 s, but its articles were a third to a half the length with fewer statements whose quotes were found. A draft's quotes may now run to 600 characters: two of eight live drafts needed a repair round only because a quote passed 300.

## ADR-038 — Answer from the saved research first; research a genuine gap on its own

- **Status:** Implemented (2026-10-17). Verified with fixture tests, a fixture browser walk and a bounded live check on 2026-10-18 (6 Gemini calls, 3 Tavily credits; VERIFICATION.md). ADR-039 adds deterministic checks of the model's "sufficient".
- **Context:**
  - **Chat already read the story's saved research** (the story, its briefs, sources and recent conversation) in one call. A gap, though, needed the editor to click "Research this lead", and the result arrived as a separate briefing.
  - **Reuse was unreliable.** Only the newest five briefs were read, so the main brief dropped out as follow-ups accumulated. Sources were capped oldest first, so a follow-up's new sources could be cut. Saved points reached the model without how they had been checked, so an unconfirmed point read like a fact.
  - **Research could hide failures.** A usage-limit error during search was swallowed, and a focused follow-up whose searches all failed still answered from the saved sources. Live on 2026-10-17 at 01:22 UTC, a follow-up made no search at all (the daily search limit was reached) and was saved as an "insufficient" answer.
- **Decision:**
  1. **One model call judges the evidence.** The chat answer's structured output starts with `assessment`:
     - `sufficient`: the saved research answers the question (with editorial judgement where asked), or no search could settle it.
     - `needs_research`: in scope, but the research doesn't establish the specific answer, and new sources could. The answer still says what the research establishes and what it doesn't.
     - `out_of_scope`: outside the newsroom's domain. The server's redirect is shown, and the call stops as soon as this value arrives.

     It adds `researchQuestion` and `researchDepth` (focused, or broad only when the editor explicitly asks for a wider look). No separate classification call: the assessment is part of the answer, so it costs no extra latency or tokens beyond a few fields. A separate call was considered and rejected, because it would add a full round trip to every question (3–9 s live) for a judgement the answering call already makes with the same evidence in front of it.

  2. **Rules around the model's decision, never instead of it** (`planFollowUp`, pure, no database call). Research starts only when all of these hold:
     - the assessment is `needs_research`, with a usable research question
     - the evidence wasn't judged sufficient (a contradiction spends nothing)
     - no research on the same question in the last 7 days (strict word overlap, `sameQuestion`)
     - the daily limits leave room for one model call and the follow-up's search credits
     - the story isn't busy

     Otherwise the reply says why, and offers to research by hand where that helps.

  3. **The existing focused research does the work.**
     - After the reply is saved, the chat route records a focused research task keyed by the reply (`research:{depth}:{story}:{reply}`), so a reply can start research at most once.
     - The route sends a `research` line before `done`, and hands the task to Trigger.dev after the stream closes.
     - The page follows the task through its record, as for any research, so a refresh or reconnection resumes it without repeating it.
     - Focused questions use standard depth; broad ones use in-depth (more searches and sources).
     - Trying again after a failure keeps it a follow-up. A second request for the same reply is refused.
  4. **One answer per question.**
     - The follow-up's findings are its brief (`requestKind: followup`, `fromMessageId`: the reply), shown inside that reply as "I checked further": its statements with citations, how fully the new sources answer, what's still to confirm, and how to settle it.
     - No model call rewords them, and they are never shown again as a separate briefing.
     - While it runs, the reply shows "I couldn't confirm that in our saved research, so I'm checking further" and the research's recorded steps.
  5. **Saved research is read reliably** (same queries as before):
     - the latest two full briefs and eight follow-ups (from up to 30 loaded)
     - the sources the briefs' points cite labelled first, newest brief first, so new findings are never crowded out
     - each brief dated, with the question each follow-up asked and how fully its sources answered it
     - each point marked with how it was checked, and its quote passed on only if that quote was found in its source
  6. **Failures stay failures.**
     - A usage limit during search stops the research.
     - A focused follow-up whose every search failed fails (retried by Trigger.dev) instead of answering "not established".
     - Partial search failures are recorded on the brief and shown.
     - A failed model call or database read ends the reply as a failure; research needs a valid answer to start.
- **Trade-offs:**
  - **Word overlap misses paraphrases.** The same-question check is deliberately strict, so a rephrased question can be researched again; the model is also told not to ask twice. Skipping needed research would be worse.
  - **Overhead on the slow path only.** When research is needed, recording the task costs a few database round trips before `done` (the usage check, the lock and the reply's link). The fast path is unchanged.
  - **The Trigger.dev queue sits in front of every follow-up.** It took 20–30 s in local development on 2026-10-17, mostly cold starts; production is unmeasured.
  - **Out of scope:** cross-story search, and any new store or index.

## ADR-039 — Evidence accuracy: statement checks and a check on "sufficient", the same on every surface

- **Status:** Implemented (2026-10-18). Verified with parameterized tests across 12 domains and all four surfaces, mutation tests, a replay over every statement stored in `omenai_live_dev`, and a 2-call live re-check (VERIFICATION.md).
- **Context.** Already in place: one checker for every statement Omenai writes (briefs, focused research, chat, drafts). Labels must name stored sources, quotes must be found word for word in the stored text, and unsourced facts are dropped. ADR-036 added the date-and-figure safeguard; ADR-038 kept failures visible. Missing, found on 2026-10-18:
  - a real passage about something else counted as support;
  - words put in someone's mouth weren't compared with the quote;
  - sources that disagreed went unnoticed;
  - the model's own "sufficient" was trusted even when its checked statements didn't answer the question (live, twice: "When was she appointed…?" judged sufficient on a quote dating when she joined the institution);
  - a gap written as a fact ("the sources don't establish the year") was shown with a quote;
  - streamed text wasn't labelled as unchecked;
  - digits were compared as text, so "2 January" passed against "2025".
- **Decision.** Deterministic checks inside the existing checker, plus one judgement function, applied the same way everywhere. Every check can only lower a statement's status or an answer's evidence; none raises it or adds reassurance.
  1. **Statement checks** (`checkClaim`, `checkClaims`, `flagConflicts`; every surface):
     - **Details in the quote** (`detail_not_in_excerpt`): every number (matched whole), month or weekday name and relative date ("this week") a fact or attributed statement gives must be in its quote, and so must the words an attributed statement puts in quotation marks.
     - **A quote about its statement** (`excerpt_unrelated`): the quote must share at least two of the statement's meaningful words, and a fact's quote that names other people or things, but none of those the statement names, is about them. Generic words ("Museum", "Festival", "National") don't count as names. Attributed statements are exempt from the naming rule, because a speaker's words rarely name the speaker.
     - **Disagreement** (`conflicting`): two statements, each backed by its own found quote, about the same thing (the same kind of event, or neither naming one, and nearly the same words), giving different years, months, days of the month, or figures for the same period. Figures for different years are a series, not a contradiction. Run within each reply, draft and brief section, then across a brief's sections and across a focused answer and its open points.
  2. **A check on "sufficient"** (`judgeEvidence`; chat and focused research). It lowers `sufficient` to `partial` and records why (`evidenceCheck`):
     - `conflicting`: its statements disagree;
     - `no_checked_facts`: for a factual question, nothing it says was checked, or it only says what isn't known;
     - `asked_detail_unchecked`: the question asks when, how many or how much, who or where, and no checked statement gives that kind of detail for the event or subject asked about. Event kinds come from a domain-neutral vocabulary (`eventsNamed`); asides that describe the subject (", the firm behind…") are ignored when reading the question's event.

     In chat, a lowered answer to a factual question becomes `needs_research` and goes through ADR-038's rules, with the editor's question as the research question if the model gave none. Judgement questions (editorial scope) are held only to the first two rules.

  3. **One shared vocabulary** (`research/terms.ts`): stop words, stemming, names, date words, event kinds and the culture words that never identify anything (moved unchanged from the relevance check). No check names a person, institution, story, date or expected answer.
  4. **Prompts.** What the sources don't establish is its own open question, never part of a fact. The substitution examples cover several domains (an announcement is not an opening, a nomination is not a win, an estimate is not a sale price). Saved points whose sources disagree are labelled so for the chat model, and drafts may state neither version of an unsettled detail.
  5. **Presentation.** Each status says what the check found ("Found, but this passage doesn't seem to be about this point"), never that a point is verified. A lowered judgement is followed by its reason ("No quote I found confirms the exact date, figure or name asked about"). Streamed text is labelled "Writing · not yet checked"; the Studio preview already said "not yet checked or saved".
- **No verification model call.** A second call to judge support semantically was considered and not built. It would add a full round trip (3–9 s live) to every chat answer and brief, and spend calls under a 60-a-day limit, for a judgement that is still not guaranteed. On the stored live answers, the deterministic rules lowered both false "sufficient" answers and none of the six correct ones. Revisit it if production data show misses that lexical rules can't catch.
- **Trade-offs and limits.** Lexical and English-centred. The event vocabulary is finite: an event described in other words counts as not answering (research runs, which is the cautious side), and an event word used as the object of another verb ("agreed to return") reads as that event. Names aren't typed, so a place can pass for a person. A fair paraphrase sharing fewer than two words is flagged. The conflict check misses contradictions worded differently and can flag two measures of one subject. Statements the model didn't list aren't checked. Passing every check proves nothing about truth: the quote is shown beside each statement for the editor to judge.

## ADR-040 — Newsroom redesign: white canvas, masthead type, colour only for meaning

- **Status:** Implemented (2026-10-20). Browser-checked at 1440 and 390 px on `omenai_fixtures` (VERIFICATION.md). Source of truth: the approved Claude Design canvas "Omenai Newsroom Redesign" (version 25).
- **Decision.** One design system for every screen, in `apps/web/src/app/globals.css` and the shared primitives, replacing ADR-022's palette and type:
  - **Palette.** A white canvas (`paper`, `ivory`), ink `#0C0C0D`, graphite `#3D3D42`, slate `#66666C` for meta text, one wash (`bone` `#F3F2EE`) for recessed panels and image-free tiles. Token names are kept, so shadcn components and older classes inherit the new values.
  - **One loud colour.** Signal yellow `#FFD233` marks the screen's primary action and the current workflow step, and nothing else. The ochre accent is retired.
  - **Colour only for meaning.** Green for done, amber for a warning, red for a failure, each as coloured text or a dot; a wash only for a real warning or failure. Subjects and media types are named in neutral outline tags, never colour-coded. Work in progress (researching, writing, retrying, running) is ink or grey.
  - **Type.** Narrow, heavy, uppercase Archivo (`.masthead`, width axis at 62%) for "What's new", section labels, the subject index and big figures; Newsreader for headlines and reading text; Geist for the interface. Instrument Serif is gone.
  - **Shape.** Pill controls (44 px on coarse pointers), 14–20 px cards, a 2 px ink focus ring with a white offset, which stays visible on black and over images.
- **Screens.** Newsroom: "What's new" on the canvas above a full-width lead image (or, with no usable image, a black cover drawn with the subject's motif), then a subject index, a list of every story, and the rest of the edition in varied shapes. Story Review: a black scorecard, an "On this page" rail, numbered parts and a sticky Next step panel. Research: a collapsible Sources & checks sidebar beside the conversation (a sheet on phones). Studio: a format rail, a white writing sheet with a neutral check chip, history and checks beside it. Operations: an at-a-glance strip and one Background work panel. Team: the invite form beside the people and invitations.
- **New read-only data (approved).** The lead story's research and draft state on the edition page, from the existing `getResearchStatus` and `getDraftStatus`. `getOperationsOverview` gains `running`: queued or running tasks with no failed attempt, not stopped by an editor and active within their kind's stale window (`staleAfterMs`), at most 20, with only the steps they recorded (ADR-037). No schema, index, route or business-logic change.
- **Honesty rules kept in the visuals.** "Checked when written" becomes "Sources checked when written" (filled dot) against "Text not checked" (empty dot), so an edited draft never reads as checked. An image that fails to load is never named in a credit ("The source's image couldn't be loaded"). Owner pages still answer editors with the same 404, now styled.
- **Trade-offs.** No Story Review previous/next links (needs data the page doesn't load; declined). No "saved by" on edition cards (the card DTO holds only the editorial state). The citation chip keeps its popover rather than driving the sidebar's evidence card. Studio on phones keeps its disclosures rather than the mock-up's bottom toolbar. Operations has no search, filters or "finished" group (no data for finished work; filters would be a new feature).
- **Corrections after review (2026-10-20).**
  - **Newsroom:** "What's New" is the page's name for every edition; the selected edition is shown only in a labelled "Select edition" control (day and time; "started by hand" instead of the old "Extra edition" naming).
  - **No counts in the masthead or hero:** no "We reviewed…" line, and the lead's status is in words.
  - **Notices:** one line each, with "Why fewer stories?" on request.
  - **Order:** lead, More from this edition, subject index and the list at a glance, then Also reviewed last.
  - **Layout from data:** sections come from a pure plan of the edition's data (`edition-plan.ts`), never from which edition it is.
  - **Studio:** a white canvas and a wider editor.
  - **Research:** a white sidebar.
  - **Tags:** short tags that never wrap.
  - **Footer:** compact on every page. The large signature was removed from the Newsroom too, at the product owner's request.
  - **Secondary stories:** the canvas drew a full edition (one wide band, three columns, ranked rows) but no rule for fewer stories. With three stories, the third became a column alone in its row, and its 4:5 frame stretched to the page's width: 1520×1900 px at 1920. With five or more, a column that wrapped at 640–1180 px did the same.
    - **Bands:** a row of columns is now used only when three stories fill it. Otherwise stories two to four are wide bands that alternate the image's side (left, right, left).
    - **Columns:** they never wrap. Below 1024 px they become numbered rows with a small image.
    - **Image frames:** every frame has a set size whatever the source's proportions: a band's image area, a column's 4:5 or 3:2 frame, a row's thumbnail. Images are cropped to fill. The exception is a tall image that would lose more than about 40% of its height: it is shown whole on a mat. Wide and panoramic images are always cropped. Image records carry no size or focal point, so crops are centred.

## ADR-041 — Discovery gates rest on checked evidence; primary sources are judged on their merits

- **Status:** Implemented (2026-10-20). Fixtures and deterministic tests only: cross-domain gate tables, key-claim checks, pipeline cases and 13 mutation checks (VERIFICATION.md). Live model behaviour is unverified and needs a separately approved check.
- **Context.** A read-only audit against the playbook (PROGRESS.md, "Playbook discrepancies") confirmed that discovery's qualitative gates were lexical or left to the model:
  - **Editorial test.** It passed any answer of 80 or more characters and 12 words (§2).
  - **Exceptions.** One passed on 60 characters alone (§5).
  - **Angle.** An empty angle could qualify (§8: the 65–79 band needs "a plausible angle").
  - **Source quality.** The model rated it for every source, and the rating was never read (§8, §10).
  - **Triage signals.** Triage's exclusion signals never reached the evaluator.
  - **Critical issues.** The prompt narrowed §5's "key claims cannot be verified" to "a central claim contradicted or resting on rumour".
- **Decision.** No new model call. The evaluation already returns everything the checks need; each check can only lower an outcome.
  1. **Key claims.** The evaluation lists up to four claims the recommendation depends on, each with source labels and a word-for-word quote.
     - Core checks them with the shared statement checks (`checkClaim`, `flagConflicts` from `research/citations.ts`, ADR-039), against the exact excerpts the evaluator was shown.
     - They are stored on the story with discovery's own wording: `no_defect_found`, `quote_not_found`, `detail_not_in_quote`, `quote_unrelated`, `conflicting`, `unknown_source`. The word "verified" is never used.
  2. **Gates** (`@repo/shared` `applyGates`, pure):

     | Gate             | Outcome when it fails                                                                            |
     | ---------------- | ------------------------------------------------------------------------------------------------ |
     | `sources`        | **Hold** when no source is rated primary, reputable or specialist. A missing rating is unknown.  |
     | `evidence`       | **Hold** when there is no key claim, a claim didn't pass, or a claim rests only on weak sources. |
     | `editorial_test` | **Reject** when the answer names no existing key claim; the length floors stay.                  |
     | `exclusion:*`    | Stands unless the exception is at least 60 characters **and** rests on a claim that passed.      |
     | `card_complete`  | **Reject** when there's no angle or why-it-matters.                                              |
     | `signal:*`       | **Hold** for each triage signal the evaluator neither confirmed nor dismissed.                   |

  3. **Primary sources** (`single_origin`).
     - An originator is authoritative for its own facts, so a single primary source is not weak in itself.
     - A source is _independent_ when it is rated reputable or specialist and its host (from our records) differs from every primary source's host.
     - With no independent source, the story is held when:
       - the evaluator judges it only the originator's announcement (`pressRelease.leadOnly`). The recommended action becomes "research", as in §5: "a press release can be a lead";
       - or why it matters rests only on `attributed` claims, which include an originator describing itself as a "landmark" or "first".
  4. **Prompts.** The evaluation prompt asks for key claims with exact quotes, `supportedBy` for the editorial test and for exceptions, confirmation or dismissal of each triage signal, and the lead-only judgement. It separates a key claim the sources don't support (an accuracy issue: hold) from a detail still to confirm (routine).
  5. **Older evaluations.** A late evaluation stored without the `evidence` gate is assessed again, never ranked under the old rules.
- **What it does not establish.**
  - A passing check means only that no known defect was found by lexical checks. It never shows that a claim is true or that its quote supports it.
  - Source ratings are the model's assessment, not verification: they can hold a story, never vouch for it.
  - Gate reasons, stored statuses and editor copy say so.
- **Trade-offs.**
  - Fewer stories will qualify, especially when the model's quotes don't match word for word. The playbook accepts a smaller edition.
  - Evaluation output grows: `maxOutputTokens` rose from 3,500 to 4,500. The Gemini schema stays within budget: 2 new enum values, and the triage-signal id is a validated string.
  - The confidence cap for single-origin stories was proposed and not adopted (awaiting the product owner).
  - A semantic support check would need a model call, and was not built (as in ADR-039).

## ADR-042 — Fair, bounded intake at every cap; weighted tier rotation; a search budget checked before the first search

- **Status:** Implemented (2026-10-20). Fixture and pure tests, including a multi-run integrity test and 14 mutation checks (VERIFICATION.md). No live search was made.
- **Context.** The audit confirmed the following, each pinned by Stage 0 tests:
  - **Extraction:** overflow was marked `skipped` and never read.
  - **Clustering:** overflow in a completed run was never clustered.
  - **Caps:** filled by comparing Tavily scores across queries. A score is relevance to one query, so the comparison is meaningless.
  - **Evaluation order:** most-covered stories first. Wide English coverage is not importance (§3), and it starves single-source, under-covered stories.
  - **Failures:** a failed assessment was never retried.
  - **Rotation:** 3 queries a day searched Tier 1 only, and 5 never reached Tiers 3–5.
- **Decision.**
  1. **Caps unchanged, fairer choice.** `maxExtract`, `clusterMaxItems` and `maxEvaluations` still bound each run, so search credits and model calls don't change. `fairOrder` (`discovery/intake.ts`) fills each cap: oldest batch first (FIFO, so nothing is overtaken indefinitely), then one item per originating query in turn, each query in its own score order. Article counts are not used.
  2. **A backlog, never a drop.**
     - Over-cap articles stay `pending` (extraction) or unplaced (clustering), and later runs take them first.
     - Anything that ages past `freshnessDays` is marked expired and counted: `expiredBeforeExtract`, `expiredBeforeCluster` and `expiredBeforeEvaluation` in the funnel, and an `expired_unprocessed` shortfall reason.
     - Triage takes every article read but not triaged, so a failed run's work is still adopted.
     - Articles record `searchQuery`, `searchTier`, `seenQueries` and `intakeRunKey`. Status changes are conditional, so a resumed run can't process an article twice.
  3. **One retry for a failed assessment.** `evaluation.failedRuns` counts failed runs, once per run however often a failure is reported. The first failure is retried in the next run; a second is final.
  4. **Audit trail.** Each run stores the thresholds, caps and models it used, once, at its start (§10).
  5. **Weighted rotation** (`selectQueries`).
     - **The cycle.** A fixed 10-slot tier cycle from the 40/30/10/10/10 shares by smooth weighted round-robin: 1,2,3,1,2,4,1,5,2,1.
     - **Daily selection.** Day _d_ takes slots _d·count_ onward. Each tier's turn takes the next query in a pool ordered to move through the pillars.
     - **Properties, each tested:**
       - Every tier gets exactly its share over any 10 days, for any count.
       - At 3 a day, no tier waits more than 4 days.
       - At 10 a day, each day is 4/3/1/1/1.
       - The same date, count and registry always give the same queries, across calls and restarts.
     - **Limits.** Rotation spreads searches; it doesn't guarantee discovery and never affects ranking: tier is still only the last tiebreak, and there's no quota on recommendations.
  6. **Registry.**
     - The 37 active queries are tagged with a pillar.
     - 18 proposed additions (`DRAFT_DISCOVERY_QUERIES`) would give every tier all six pillars. They are **not searched** until the product owner approves the wording.
  7. **Search budget.**
     - **Rates.** Tavily's published rates, checked 2026-10-20: 1 credit per basic search; 1 per 5 successful basic extracts, with failures free.
     - **Worst case per run** (`worstCaseRunCredits`): all queries, plus a full extract, plus revisits. At the code defaults that is 24 credits, which exceeds the live-dev limit of 20 a day on its own. Live-dev is at most 6.
     - **`pnpm env:check`.** It prints the worst case, and warns when it plus a research reserve of 5 exceeds `SEARCH_DAILY_CREDIT_LIMIT`.
     - **Before the first search.** A run checks its worst case against what's left, and refuses cleanly, having spent nothing, if it can't fit.
     - Live-dev query counts were **not** raised: rotation gives tier coverage over days instead.
- **Trade-offs.**
  - **FIFO.** Oldest-first can make a strong new story wait a run when the backlog is full. The backlog is limited by the freshness window, and every expiry is counted.
  - **Older records.** Articles stored before this change have no query or tier, so they fall into a shared "unknown" lane. Old `skipped` articles stay skipped.
  - **The research reserve** is a planning figure, not a limit.
