# Provider switch and deployment runbook

_Prepared 2026-10-16. Nothing in this runbook has been run against production yet. Local live development (Gemini, Tavily, the Trigger.dev dev worker) is separate: see LIVE_DEVELOPMENT.md._

This runbook moves the newsroom from development (Gemini, local Trigger.dev, the Atlas dev database) to production (Anthropic, Vercel, deployed Trigger.dev). Each step marked **Approval** spends money or changes something live, and waits for the product owner's explicit go-ahead with confirmed credentials and budget. Results go into `docs/VERIFICATION.md`.

## 1. Gates

Production deploy is blocked until all of these are true:

1. The provider switch is done and its live checks pass (section 3).
2. The security checks in section 6 are complete.
3. The owner-side setup in section 2 is done.

## 2. Owner-side setup (credentials and accounts)

| Item                                                                     | Needed for                                          | Where it goes                                                                    | Status                                                                                      |
| ------------------------------------------------------------------------ | --------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` with a spend limit set in the Anthropic console      | Production model                                    | Trigger.dev **production** env vars (and `apps/worker/.env` for the live checks) | ⏳ Not provided                                                                             |
| App-only Atlas user (`readWrite` on `omenai` only) with a fresh password | Production database                                 | `MONGODB_URI` in Vercel and Trigger.dev production                               | ⏳ The current user is `atlasAdmin`; replace it                                             |
| Atlas Network Access                                                     | Vercel and Trigger.dev reaching Atlas               | Atlas → Network Access                                                           | ⏳ See ADR-018: `0.0.0.0/0` with the least-privilege user, or Trigger.dev static IPs (paid) |
| Vercel Pro project                                                       | Hosting the web app                                 | —                                                                                | ⏳                                                                                          |
| Paid Trigger.dev plan                                                    | The exact-midnight schedule, and static IPs if used | —                                                                                | ⏳                                                                                          |
| Production `BETTER_AUTH_SECRET` (`openssl rand -base64 32`)              | Sessions                                            | Vercel env vars                                                                  | ⏳ Never reuse the development secret                                                       |
| `RESEND_API_KEY` and a verified sending domain for `EMAIL_FROM`          | Invitation and password-reset email                 | Vercel env vars                                                                  | ⏳ Optional, but without it password reset is unavailable                                   |
| Rotate the Gemini key that was shared in chat                            | Hygiene                                             | Google AI Studio                                                                 | ⏳                                                                                          |

## 3. Switching the provider to Anthropic

The LLM layer is provider-agnostic (ADR-016). Business code calls `LlmClient` with tiers, never model IDs, and nothing Gemini-specific sits outside `packages/core/src/llm/providers/`. The only other mentions are the default model table, the provider factory, the list of provider names, and the free-tier cost estimate. Default Anthropic models: triage `claude-haiku-5-5`, primary `claude-sonnet-5-5`, escalation `claude-opus-5-5`. Each can be overridden with `ANTHROPIC_MODEL_<TIER>`.

The Anthropic adapter sends `beta.messages.create` with `output_config` (an `effort` level and a `json_schema` format) and, for some models, the `server-side-fallback-2026-07-01` beta. These request shapes are covered only by contract tests against intercepted HTTP (`llm/providers/providers.contract.test.ts`), never by a live call. **Before step 3**, check them against the current Anthropic API reference, along with model availability for the three IDs.

Steps:

1. **Offline:** `pnpm check` passes. This includes the provider contract tests and the provider-switch test, which runs the same business call through both adapters.
2. **Local configuration:** add `ANTHROPIC_API_KEY` to `apps/worker/.env`, and to `apps/web/.env.local` only when chat is switched too (the web app calls the model for chat replies only, ADR-035). Leave `LLM_PROVIDER=gemini` for now.
   - **Before switching chat:** the Anthropic adapter has no `stream()` yet. Chat still works without it, but the reply arrives whole instead of streaming. Add and contract-test streaming for the Anthropic adapter first (the neutral `ProviderStream` type, ADR-036), verified against the current SDK.
3. **Approval:** one live structured-output call (about 1 Sonnet call, cents at most):
   ```
   cd packages/core
   LLM_PROVIDER=anthropic LLM_LIVE_TESTS=1 node --env-file=../../apps/worker/.env node_modules/vitest/vitest.mjs run src/llm/live.test.ts
   ```
4. **Approval:** the bounded draft check on Anthropic. It makes 2 calls expected and refuses a seventh, with the SDK's own retries turned off:
   ```
   LLM_PROVIDER=anthropic DRAFT_LIVE_PROVIDER=anthropic DRAFT_LIVE_TESTS=1 node --env-file=../../apps/worker/.env node_modules/vitest/vitest.mjs run src/drafts/drafts.live.test.ts
   ```
5. **Approval:** one small discovery run in the dev environment on Anthropic, with tight limits (for example `DISCOVERY_MAX_QUERIES=2 DISCOVERY_MAX_EVALUATIONS=3`): a few Tavily credits and a handful of Haiku and Sonnet calls. Check the gates, scores and shortlist in Operations, and compare the token usage with the Gemini smoke run (PROGRESS.md, "Live smoke run findings").
6. **Production configuration:** set `LLM_PROVIDER=anthropic` in Trigger.dev **production** env vars, and in Vercel's when chat moves too (the same value in both, with the provider's key).
7. **Rollback:** don't fall back to the Gemini free tier in production; its prompts may be reviewed by people (IMPLEMENTATION_PLAN.md, Risks). Pause the schedule in the Trigger.dev dashboard, or promote the previous worker version (`npx trigger.dev promote <version>`), then investigate.

**Rough running cost on Anthropic** (an estimate, not a quote). It is extrapolated from the Gemini smoke run's token volumes: about 140k input and 55k output tokens per daily run, which Claude's tokenizer will change. Assuming triage on Haiku and evaluation on Sonnet, that is under about $1 per run, plus at most four Opus escalations, plus about 22 Tavily credits per run. Research and drafts add per-use cost. The Operations page shows estimates from the price table (`ops/pricing.ts`, prices verified 2026-10-15); the provider dashboards are the source of truth.

## 4. Deploying

### Database (Atlas)

1. Create the app-only user and update Network Access (section 2).
2. Create indexes with the production connection: `OMENAI_RUNTIME=production MONGODB_URI=… MONGODB_DB_NAME=omenai pnpm db:indexes`. Idempotent.
3. Never run `pnpm db:seed-fixtures` against production. It refuses any database whose name doesn't end in `_fixtures`.

### Worker (Trigger.dev)

1. **Production env vars** in the dashboard (Project → Environment variables → Production):
   - `OMENAI_RUNTIME=production`
   - `MONGODB_URI`
   - `MONGODB_DB_NAME=omenai`
   - `LLM_PROVIDER=anthropic`
   - `ANTHROPIC_API_KEY`
   - `TAVILY_API_KEY`
   - optionally the discovery limits (every variable and default is in `packages/core/src/discovery/config.ts`)
2. **Approval:** deploy with `pnpm --filter @repo/worker deploy` (`trigger deploy`).
3. **Check registration:** the dashboard lists these tasks:
   - `daily-discovery`, a schedule at 00:00 America/Chicago, production only
   - `discovery-run` and `discovery-evaluate`
   - `research-story`, `chat-reply` and `generate-draft`
   - `ops-database-ping`
4. Trigger `ops-database-ping` from the dashboard. It reports the database name and latency, and makes no AI calls.

The worker's development-fixtures path is used only when the database name ends in `_fixtures` **and** the run isn't in the production environment (ADR-031), so production always uses the configured provider.

### Web app (Vercel)

1. Create the project with root directory `apps/web` (pnpm workspace, Turborepo). Confirm the build command and output detection in the Vercel dashboard at setup.
2. **Production env vars:**
   - `OMENAI_RUNTIME=production`
   - `MONGODB_URI`
   - `MONGODB_DB_NAME=omenai`
   - `BETTER_AUTH_SECRET`
   - `BETTER_AUTH_URL` (the production URL, no trailing slash)
   - `TRIGGER_SECRET_KEY` (the **production** key, `tr_prod_…`)
   - for chat (ADR-035): `LLM_PROVIDER` and that provider's key, the same as the worker's, plus any `<PROVIDER>_MODEL_<TIER>` overrides and, if set on the worker, the same `AI_DAILY_CALL_LIMIT` and `SEARCH_DAILY_CREDIT_LIMIT`
   - optionally `RESEND_API_KEY` and `EMAIL_FROM`

   Never set `EMAIL_TRANSPORT` in production; it's refused outside fixtures databases anyway. The search key (`TAVILY_API_KEY`) never belongs here, and nothing secret uses a `NEXT_PUBLIC_` prefix.

   The chat route sets `maxDuration = 90` and keeps a reply alive after a disconnect with `after()` (Vercel's `waitUntil`). Confirm on the first deployment that a reply still saves when the tab closes mid-answer; it is verified on `next start` only.

3. **Approval:** deploy.
4. **First owner:** `OMENAI_RUNTIME=production MONGODB_URI=… MONGODB_DB_NAME=omenai BETTER_AUTH_URL=… pnpm owner:invite you@omenai…`. It refuses if an active owner exists.

### Smoke checks after deploy (no AI spend)

1. `GET /api/health` returns OK.
2. Signed out, `/` redirects to `/login`, and `GET /api/stories/<id>/drafts` returns 401.
3. Accept the owner invitation, sign in, and invite an editor. The editor sees no Team link or Find button; `POST /api/runs` returns 403 for them.
4. The Newsroom shows its empty state, and Operations reads "No edition yet".
5. **Approval:** one manual "Find today's stories" (one night's worth of search credits and AI usage), or wait for midnight Chicago time.

## 5. Variable reference

| Variable                                                                                | Web | Worker   | Secret | Notes                                                                    |
| --------------------------------------------------------------------------------------- | --- | -------- | ------ | ------------------------------------------------------------------------ |
| `OMENAI_RUNTIME`                                                                        | ✓   | ✓        |        | `production` here; `live-dev` / `fixtures` locally (LIVE_DEVELOPMENT.md) |
| `MONGODB_URI`                                                                           | ✓   | ✓        | ✓      | App-only user                                                            |
| `MONGODB_DB_NAME`                                                                       | ✓   | ✓        |        | `omenai` in production; `*_fixtures` only for development fixtures       |
| `BETTER_AUTH_SECRET`                                                                    | ✓   |          | ✓      | Unique per environment                                                   |
| `BETTER_AUTH_URL`                                                                       | ✓   |          |        | Public base URL                                                          |
| `TRIGGER_SECRET_KEY`                                                                    | ✓   |          | ✓      | Per environment (`tr_dev_` / `tr_prod_`)                                 |
| `RESEND_API_KEY`, `EMAIL_FROM`                                                          | ✓   |          | ✓ /    | Optional                                                                 |
| `LLM_PROVIDER`                                                                          | ✓   | ✓        |        | Same in both; the web app uses it for chat only                          |
| `ANTHROPIC_API_KEY`                                                                     | ✓   | ✓        | ✓      | In the web app only once chat moves to Anthropic                         |
| `GEMINI_API_KEY`                                                                        | dev | dev only | ✓      | Not set in production; same key in both locally (`pnpm env:check`)       |
| `<PROVIDER>_MODEL_<TIER>`                                                               | opt | optional |        | Overrides `llm/config.ts`; same in both                                  |
| `AI_DAILY_CALL_LIMIT`, `SEARCH_DAILY_CREDIT_LIMIT`                                      | ✓   | ✓        |        | Required in live development; same in both                               |
| `TAVILY_API_KEY`                                                                        |     | ✓        | ✓      |                                                                          |
| `DISCOVERY_*`, `AI_MAX_ESCALATIONS_PER_RUN`, `SHORTLIST_*`, `SCORE_SHORTLIST_THRESHOLD` |     | optional |        | Defaults in `discovery/config.ts`                                        |

A missing required variable fails with a `ConfigError` naming it.

## 6. Security checks before go-live

- [x] Every protected route re-checks the session and role on the server (`requireUser` / `requireOwner`). Route tests cover runs, team, invitations and drafts (401/403).
- [x] Invite-only sign-up: no public sign-up path (auth end-to-end tests).
- [x] The search key lives in the worker only. The model key is in the web app as well, for chat replies, server-only (ADR-035); `pnpm env:check` confirms it matches the worker's and that no search key is there.
- [x] Fixture paths are refused outside `*_fixtures` databases, and outside non-production Trigger.dev environments.
- [ ] Replace the `atlasAdmin` database user with an app-only user.
- [ ] Production `BETTER_AUTH_SECRET`, and confirm the session cookie is `Secure` on the production domain.
- [ ] Rotate the Gemini key shared in chat.
- [ ] Rate limiting on in production (Better Auth database limiter, ADR-017): confirm with a few wrong passwords against the deployed site.
- [ ] Review Atlas Network Access after the first deploy.
