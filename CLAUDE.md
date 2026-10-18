# Omenai AI Newsroom — Project Instructions

Read `AGENTS.md` (Turborepo guidance) too. **When resuming work, first read `docs/PROGRESS.md` (state and exact next action) and `docs/VERIFICATION.md`, then inspect the actual code. Don't trust documentation alone.**

## Product in one paragraph

An internal editorial tool for Omenai ("Stories Shaping Culture"), a global contemporary-culture media company. A daily background run discovers candidate stories, applies the CEO playbook's gates and weighted scoring, and produces a 0–8 item ranked shortlist. Invited editors review stories, save or skip them, request source-linked research briefs, chat about a story, and generate individual publication drafts with version history. Nothing is ever published automatically.

## Authoritative editorial source

`docs/Omenai_Global_Culture_Taxonomy_AI_Newsroom_Playbook.pdf` (v1.0, Oct 2026) is the authority for taxonomy, geography tiers, exclusions, scoring weights, thresholds, voice and the recommendation card. It's encoded in `packages/shared/src/taxonomy.ts` and the prompts in `packages/core/src/prompts/`. Don't invent categories or replace its rules with generic news logic. If code and playbook disagree, the playbook wins; record the discrepancy in `docs/PROGRESS.md`.

## Architecture

```
apps/web       Next.js 16 App Router: UI + Route Handlers + Better Auth (/api/auth/[...all]),
               and the streamed chat reply (one bounded model call, ADR-035)
apps/worker    Trigger.dev v4 tasks: daily-discovery (scheduled 00:00 America/Chicago), pipeline stages,
               research-story, generate-draft
packages/core  Node-only: Mongo (one MongoClient shared by Mongoose + Better Auth), models, services,
               LLM layer (llm/: LlmClient + Gemini/Anthropic adapters), Tavily / Resend clients,
               prompts, discovery pipeline, config
packages/shared Browser-safe: taxonomy, Zod contracts, scoring, gates, schedule/run-key logic
packages/config TS presets + ESLint configs
```

- Route handlers authenticate, authorize, validate, persist and enqueue. They never run long AI or search work inline. The one exception is the chat route, which streams a single bounded model call with no search (ADR-035). When that call judges that the saved research doesn't establish the answer, the route records focused research and enqueues it like any research (ADR-038). Research, drafts and discovery stay in the worker.
- Workers call `@repo/core` services directly, with no dependency on the web API.
- Task status and progress live in MongoDB (`tasks`, `workflowRuns`). The UI polls them; a chat reply also streams its text to the page that asked, and a draft's text in progress is read from its task record (ADR-037).
- Decisions and their rationale: `docs/ARCHITECTURE_DECISIONS.md`. Phases, defaults and the post-MVP list: `docs/IMPLEMENTATION_PLAN.md`.

## Non-negotiable rules

- **Server-side authorization on every protected operation.** Use `requireUser()` or `requireOwner()`. Hiding UI controls isn't security.
- **Roles:** `owner` (everything, including users and invitations and manual runs) and `editor` (stories, research, drafts). No other roles.
- **Auth is invite-only email + password.** User creation happens only through Better Auth's hooks with a valid invitation token. Never add a public sign-up path or bypass `claimInvitation`.
- **Every model call is bounded:** a per-attempt timeout and a hard per-call deadline, retries included (ADR-036). Keep the model layer provider-neutral: callers name an operation, tier and effort, never a provider.
- **LLM calls go through `LlmClient` only.** Never import `@google/genai` or `@anthropic-ai/sdk` outside `packages/core/src/llm/providers/` (a test enforces this). Use tiers (`triage` / `primary` / `escalation`), not model IDs. Gemini is for dev; switch to Anthropic, and run the live and regression tests, before any production deploy.
- **Scores:** the model returns per-dimension 0–5 scores with rationales. The **weighted total is always computed in code** (`@repo/shared` scoring). Gates override scores. The 65 threshold is never relaxed to fill the shortlist.
- **No fabrication.** URLs, publishers and dates shown to users come from DB records, never from model text. Citations are validated against persisted `sourceArticles`. Never present unlocated evidence as verified. The evidence checks (ADR-039) are deterministic and only lower confidence: never present a passed check as proof of support, and never let a check raise the model's judgement.
- **Progress is never invented.** What editors see while work runs comes only from steps the work recorded (`progressRecorder`, ADR-037).
  - Don't show a stage that didn't happen.
  - Don't call a quote check a fact-check.
  - Never add a model call or a delay to fill a wait.
- **Idempotency:** every worker side effect is keyed (runKey, task key, taskId) and backed by a unique index.
- **Missing credentials** raise a clear `ConfigError` naming the variable. Never silently mock a production integration. Fixtures are for tests only and are labelled as such.
- **Runtime is explicit** (ADR-033). `OMENAI_RUNTIME` is `live-dev`, `fixtures`, `production` or `test` (Vitest only), and `MONGODB_DB_NAME` must agree with it (`_dev` / `_fixtures` / neither). Neither is ever assumed. Mocked paths run only via `isFixtureRuntime()`. Local development is live by default, against real Gemini, Tavily, Atlas `omenai_live_dev` and the Trigger.dev dev worker, within hard daily limits (`AI_DAILY_CALL_LIMIT`, `SEARCH_DAILY_CREDIT_LIMIT`). The web env needs the same model key, models and limits as the worker for chat; it never holds the search key. See `docs/LIVE_DEVELOPMENT.md`; run `pnpm env:check` before live work.
- **Secrets** are server-only. Never use a `NEXT_PUBLIC_` variable for a secret.
- **Verify third-party APIs** (Better Auth, Trigger.dev v4, Tavily, Anthropic SDK, shadcn) against current docs or the installed package before relying on them.

## Conventions

- TypeScript strict everywhere. Zod validates external input: HTTP bodies, env, LLM structured output, third-party responses.
- Package conventions: see the README section "Adding a workspace package". Versions shared across packages go in the `catalog` in `pnpm-workspace.yaml`.
- Keep route handlers thin; put logic in `@repo/core` services so tests can call it directly.
- Tests: Vitest. Pure logic goes in `@repo/shared`. DB-backed tests use `mongodb-memory-server` (replica set).
- Comments explain non-obvious constraints, not what the code does.
- Run `pnpm check` (format, lint, typecheck, test, build) before calling a phase done, and record results in `docs/VERIFICATION.md`.
- Don't commit unless the product owner asks.
- Update `docs/PROGRESS.md` and `docs/VERIFICATION.md` after each meaningful unit of work and before ending a session.
