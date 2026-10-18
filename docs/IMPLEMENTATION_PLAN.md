# Omenai AI Newsroom MVP — Implementation Plan

> Approved 2026-10-14. Decision rationale lives in `ARCHITECTURE_DECISIONS.md`; status in `PROGRESS.md`; evidence in `VERIFICATION.md`.

## Revisions

- **2026-10-15 — LLM provider.** A provider-agnostic LLM layer. Gemini is used for development and testing; Anthropic Claude is the production target and is switched on before deploy (ADR-016). Pipeline text below refers to model _tiers_ (triage / primary / escalation), not vendor models.
- **2026-10-15 — Authentication.** Google OAuth is dropped. Owner-invited **email + password** accounts replace it; the invite-only model and the Owner/Editor roles are unchanged (ADR-017, supersedes the Google parts of ADR-005).
- **2026-10-15 — Infrastructure.** MongoDB Atlas is connected and verified (ADR-018). The Trigger.dev project is `proj_ydafdiqitotsvbyazmaw`. Tavily is integrated through its SDK (ADR-019).

## Context

Omenai needs an AI-assisted editorial newsroom by **2026-11-01** (18 days from 2026-10-14). The product runs daily discovery of global contemporary-culture stories, evaluates them against the CEO playbook, produces a 5–8 item ranked shortlist, and gives editors a research assistant and an on-demand content studio. The playbook (`docs/Omenai_Global_Culture_Taxonomy_AI_Newsroom_Playbook.pdf`) is the authority on editorial rules.

## Repository assessment (Phase 0 findings)

- **This is a clean scaffold, not an empty repo.** It contains: a pnpm 12.11.2 workspace with Turborepo 2.11.7 on Node 24; `apps/web` running Next.js 16.4 (App Router, React 19.3, Tailwind v4, `cacheComponents`, Vitest 5); `@repo/shared` (Zod 4 schemas compiled to `dist`, deliberately free of Node and browser globals); and `@repo/config` (TypeScript presets and ESLint flat configs). Only `/api/health` and a status homepage exist. Nothing has been committed yet.
- **Keep:** all tooling (turbo tasks, the catalog, ESLint/Prettier, the tsconfig presets), the `@repo/shared` pattern, the `/api/health` route and its test pattern (`lib/` holds the logic and the route stays thin), and the README conventions.
- **Fix:** `apps/web/.env.local` contains a stale `API_URL=…:4000` that points at a separate backend that doesn't exist. Remove it, since we will not add an Express API. `README.md` also says the app needs no env vars, which will no longer be true.
- **Playbook read in full (15 pages).** Beyond the brief, it adds:
  - the mandatory editorial test: _"This matters to Omenai's audience because…"_
  - full subcategory lists for the six pillars
  - 11 cross-cutting tags
  - five geographic tiers with example hubs
  - a 12-element recommendation card
  - data-model fields: `source_quality`, `novelty_status`, `verification_status`, `recommended_action`, `editor_decision/reason`, `duplicate_cluster_id`, `format_potential`, `timeliness`
  - voice "avoid" rules, the exception policy, and non-negotiable controls such as an audit trail and "AI summary ≠ verified source"
- **AGENTS.md** is managed by turbo. `CLAUDE.md` will reference it rather than duplicate it.

## Confirmed decisions (by the product owner)

1. **Scheduling. Re-evaluated on request; chosen: a single Trigger.dev schedule.** Only one mechanism is implemented. Vercel Cron is not used.

   |                         | Trigger.dev declarative schedule                                                                                                                                         | Two Vercel crons + Chicago-hour guard                               |
   | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
   | DST                     | Native: `timezone: 'America/Chicago'`; docs: "automatically work with daylight saving time"                                                                              | Hand-written guard logic in our route                               |
   | Systems that must be up | Trigger.dev only                                                                                                                                                         | Vercel cron, our route, Trigger.dev API, then Trigger.dev execution |
   | Public attack surface   | None                                                                                                                                                                     | A `CRON_SECRET`-protected HTTP endpoint                             |
   | Precision               | Exact on **paid** Trigger.dev (Hobby $10/mo+). **Free plan enforces a minimum 60-minute window**, so the run would fire at a stable time between 00:00 and 01:00 Chicago | Minute-precise on Vercel Pro                                        |
   | Moving parts            | 1 task definition                                                                                                                                                        | 2 cron entries, 1 route, guard, secret                              |

   **Why:** fewer failure points, no public trigger endpoint, and DST handled by the platform. It does require the **Trigger.dev Hobby plan or higher**, which we likely need anyway for compute credit and log retention. The schedule is `schedules.task({ id: 'daily-discovery', cron: { pattern: '0 0 * * *', timezone: 'America/Chicago', environments: ['PRODUCTION'] } })`.
   - The run key comes from `payload.timestamp` (the _scheduled_ time) converted to a Chicago date. A delayed or retried firing still maps to the same `daily-discovery:YYYY-MM-DD`.
   - US DST transitions happen at 02:00 local, so local midnight always occurs exactly once a day. Tests still cover 2026-11-01 (DST end) and 2027-03-14 (DST start).
   - Duplicate-trigger tests cover a schedule firing plus a manual run plus a retry against the same date key.
   - Before go-live, the `upcoming` dates in the Trigger.dev dashboard are checked across Nov 1 and recorded in VERIFICATION.md.
   - Owners can still start a run manually (an authenticated, owner-only route).

2. **Model routing by tier, behind a provider-agnostic interface** (ADR-004, ADR-016).

   | Tier       | Development (`LLM_PROVIDER=gemini`) | Production target (`LLM_PROVIDER=anthropic`) | Used for                                                  |
   | ---------- | ----------------------------------- | -------------------------------------------- | --------------------------------------------------------- |
   | triage     | `gemini-3.5-flash-lite`             | `claude-haiku-5-5`                           | Per-article scope, metadata, change classification        |
   | primary    | `gemini-3.8-flash`                  | `claude-sonnet-5-5`                          | Clustering, gates and scoring, research, chat, generation |
   | escalation | `gemini-3.8-flash` (high thinking)¹ | `claude-opus-5-5`                            | Bounded escalation only                                   |

   ¹ Pro-class Gemini models return 429 (no quota) on the free tier.

   Escalation happens in three cases, with a per-run cap (default 4) and at most one escalation per research task:
   - a borderline score (within ±4 of 65 or 80)
   - the model flags conflicting sources or ethics/rights ambiguity
   - the editor explicitly requests "in-depth research"

   Every model ID can be overridden with `<PROVIDER>_MODEL_<TIER>`. All pipeline stages call `LlmClient` (`generateObject` / `generateText`); only `packages/core/src/llm/providers/*` may import a provider SDK, and a test enforces this.

3. **Auth.** Better Auth with **email + password**, invite-only (ADR-017). Owners invite by email and assign a role. The invitee opens the link and sets a password, and is then signed in. There is no public sign-up and no OAuth.

## Provisional assumptions (recorded in ARCHITECTURE_DECISIONS.md)

- **Packages.** Three packages, no more:
  - `@repo/shared`: browser-safe code (taxonomy, Zod contracts, scoring, gates, Chicago-time logic) that the UI can import.
  - `@repo/core`: Node-only code (Mongo connection, data access, services, LLM layer with Gemini and Anthropic adapters, Tavily and Resend clients, prompts).
  - `apps/worker`: Trigger.dev tasks.

  This deviates slightly from the suggested `core` + `db` split: the DB layer lives in `core/src/db/` because a separate package has no consumer that would need DB without services.

- **Database.** Mongoose models live in `@repo/core/src/db/models/*`, with schema-level indexes and `syncIndexes()` in the bootstrap. There is **one shared native `MongoClient`**: Mongoose uses it via `mongoose.createConnection().setClient(client)` (documented API), and Better Auth's `mongodbAdapter(client.db(), { client })` uses the same client. This avoids two connection pools on Atlas M0. The client is cached on `globalThis` for Next.js dev reloads and serverless reuse, with a small `maxPoolSize`. **To verify at install:** the `mongodb` driver versions required by Mongoose and `@better-auth/mongo-adapter` must resolve to one compatible version. If they can't, fall back to two clients and document the extra pool. LLM structured outputs are still validated with Zod (the API contract) before they're written through Mongoose.
- **Concurrency guard.** Per-run "leases" (`leaseExpiresAt`) let a crashed run be detected and resumed.
- **UI library: shadcn/ui.** shadcn uses Radix primitives, so accessibility comes built in. Its components are copied into `apps/web/src/components/ui` and restyled so they don't look like stock shadcn:
  - an editorial palette (warm paper, ink, hairline rules, an ochre accent)
  - a Newsreader serif for headlines and Geist for the UI
  - restrained radii and subtle motion

  The components used are button, badge, card, tabs, dialog, sheet (mobile nav), dropdown-menu, tooltip, input, textarea, select, skeleton, separator, table and sonner (toasts). Icons come from `lucide-react`. Setup will follow the current shadcn CLI docs for Tailwind v4 / React 19.

- **Fonts.** Newsreader (editorial serif) for display and Geist for UI, via `next/font`.
- **Content and sources.**
  - Saved/skipped state is workspace-wide, not per user (small team).
  - Source registry and discovery queries are code-defined, marked for editorial review, and domains are checked for reachability before shipping.
  - **English-only is a configurable limitation** (`DISCOVERY_LANGUAGES=en`). It is documented in README and IMPLEMENTATION_PLAN as a known limitation and shown on the operations page. Prompts tell the models that missing English-language coverage is **not** evidence that a development doesn't exist or is insignificant. Thin English coverage must not lower significance scores; it may raise the originality/under-covered score when there is evidence.
- **Channel constraints.**

  | Format                                  | Limit                                       |
  | --------------------------------------- | ------------------------------------------- |
  | X post                                  | ≤ 280 chars (validated; one repair attempt) |
  | Instagram caption                       | ≤ 2,200 chars                               |
  | LinkedIn post                           | ≤ 3,000 chars                               |
  | Newsletter item (Weekly Briefing style) | ~150–300 words                              |
  | Editorial article                       | ~800–1,500 words                            |

- **Generation prerequisite.** Generation requires a completed research brief, because evidence is the factual foundation.

## Credentials and external setup

| Item                                    | Status (2026-10-15)                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `MONGODB_URI` (Atlas)                   | ✅ Configured locally and verified (ADR-018). Still needed in Vercel and Trigger.dev environment variables.                                |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | ✅ Generated locally. Production needs its own secret.                                                                                     |
| `LLM_PROVIDER=gemini`, `GEMINI_API_KEY` | ✅ Configured for development (worker only) and live-verified.                                                                             |
| `ANTHROPIC_API_KEY`                     | ⏳ Needed before production (provider switch).                                                                                             |
| `TAVILY_API_KEY`                        | ⏳ Needed for discovery and research.                                                                                                      |
| `TRIGGER_SECRET_KEY` (dev)              | ✅ Set in `apps/web/.env.local`.                                                                                                           |
| Trigger.dev CLI login                   | ⏳ The owner runs `npx trigger.dev@latest login`. A paid plan is needed for an exact-midnight schedule and static IPs.                     |
| `RESEND_API_KEY`, `EMAIL_FROM`          | ⏳ Optional. Needed to email invitations and password resets; without them, invitation links are copied manually and reset is unavailable. |

**Risks:**

- Atlas Network Access must admit Trigger.dev and Vercel. Both use dynamic egress IPs on non-paid/non-enterprise plans, so either use `0.0.0.0/0` with a strong, least-privilege database user, or (paid Trigger.dev) its static IPs (ADR-018).
- The provided Atlas user has `atlasAdmin`. Replace it with an app-only `readWrite@omenai` user before production.
- Gemini free tier: limited quota and occasional 503s under load. Per the Gemini API terms, unpaid-quota prompts and responses are used to improve Google products and **may be read by human reviewers**, so don't send confidential, unpublished or personal material while on the free tier (use a paid Gemini key or switch to Anthropic for such work).
- Trigger.dev Free gives $5 compute and 1-day log retention; Hobby ($10) is probably needed.
- `mongodb-memory-server` downloads a mongod binary on first test run.

## Architecture overview

```
Vercel (apps/web, Next 16)                 Trigger.dev (apps/worker)
 ├ UI (server components → @repo/core reads)   ├ daily-discovery (orchestrator)
 ├ Route Handlers (auth, validate, enqueue) ──▶ │   ↑ schedules.task 00:00 America/Chicago
 │   (incl. owner-only manual run)              ├ triage-articles / evaluate-cluster (children)
 └ Better Auth (/api/auth/[...all])             ├ research-story, chat-reply, generate-draft
                                                └ all use @repo/core services + DB directly
                     ╲                         ╱
                      MongoDB Atlas (single source of truth for status/progress)
```

The UI polls `GET /api/tasks/[id]`, which reads our own task documents, every 3 s. It never depends on an open request: closing the tab doesn't affect a run.

## Data model (collections)

- **Better Auth:** `user` (+ `role: owner|editor`, `status: active|deactivated`, both `input:false`), `session`, `account`, `verification`.
- **`invitations`**: email (normalized), role, `tokenHash` (**unique**; SHA-256 of a 32-byte random token, raw token never stored), status `pending|accepted|revoked`, expiresAt (7 days), invitedBy, acceptedAt, acceptedUserId.
- **`sourceArticles`**: canonicalUrl (**unique**), url, publisher, originalHeadline, author, publishedAt, retrievedAt, `origin: discovery|research`, extracted text (capped) and `contentHash`, `lastCheckedAt`, `revisions[]` ({checkedAt, contentHash, headline, changeKind, changeSummary}), sourceQuality, triage output, `storyIds[]`, first runKey. **Every source a research brief uses is persisted here**, with URL, publisher, retrieval metadata and the evidence text available at the time. This is the editor's audit trail.
- **`stories`**: the editorial development. It holds all recommendation-card fields:
  - working headline, summary, whatHappened, whyItMatters, the editorial-test sentence, angle, whyNow
  - pillar, subcategories, crossCuttingTags, geography[] (with tier and confidence), culturalConnections, entities
  - noveltyStatus, formatPotential, verificationNeeds, peopleToApproach, visualOpportunities (rights unconfirmed)
  - `gates`, `score` (per-dimension score and rationale, computed total, confidence, band), recommendedAction
  - `developmentSignature`, relatedStoryIds
  - editorialState `none|saved|skipped`, a `decisions[]` audit log (who, what, reason, when), and recommendation history
- **`workflowRuns`**: runKey (**unique**, `daily-discovery:YYYY-MM-DD` or `manual:<iso>`), trigger source, status, stage progress, deadlines (soft/extension/hard), `candidateSetClosedAt`, shortlist [{storyId, rank, score, isUpdate}], a **`funnel`** (per-stage counts: discovered, new, revisited, changed, extraction failures, triage in-scope, clusters, evaluated, evaluation failures, gate holds/rejects by reason, suppressed repeats, below threshold, qualified, shortlisted), **`shortfallReasons[]`**, errors, lease.
- **`tasks`** (StageTask): key (**unique**), kind, runKey/storyId, status `queued|running|succeeded|failed|skipped`, attempts, lastError, progress {step, message, pct}, timestamps, Trigger.dev run id, `activeLock` (**sparse unique**; prevents concurrent research/chat per story).
- **`researchBriefs`**: storyId, taskId (**unique**), model(s) used, `sources[]` = {sourceArticleId, label `S1..Sn`, contentHash snapshot}, sections with claims typed `fact|attributed|analysis|open_question`. Each claim has `sourceArticleIds`, an evidence excerpt and `citationStatus: verified|excerpt_not_located`. Also: people to approach, verification checklist, and `droppedClaims` count with reasons.
- **`chatMessages`**: storyId, role, content, cited sourceIds, taskId (**sparse unique**).
- **`draftVersions`**: storyId, format, version (**unique** on storyId + format + version), body, origin `generated|edited`, instructions, createdBy, sourceIds, briefId, taskId (sparse unique), so retries never duplicate a version.
- **`aiUsage`**: provider, model, operation, input/output/cache tokens, Tavily credits or request counts where exposed, runKey/taskId/storyId. Raw usage only; no hard-coded prices.

## Discovery pipeline (Phase 2 core)

1. **Start the run.** The scheduled task derives `daily-discovery:<Chicago date of payload.timestamp>`. An owner's manual `POST /api/runs` triggers the same task with `manual:<iso>`, using `idempotencyKey: runKey`. Both paths call `startRun(runKey)`, an atomic upsert on the unique runKey.
2. **Claim the run.** The orchestrator claims it atomically (queued, failed or lease-expired → running). If the run is already completed, it exits. If another live lease holds it, it exits.
3. **Discover.** Run 8–12 date-rotated Tavily queries (topic `news`, recent time range, language from `DISCOVERY_LANGUAGES`) from the source registry, weighted by tier but not quota-based. Upsert articles by canonical URL (normalized: strips tracking params, lowercases host, removes trailing slash).
4. **Revisit (bounded).** Previously seen URLs are not reprocessed by default. A URL becomes **revisit-eligible** only if all of the following hold:
   - it is linked to a story recommended, saved, or scored ≥ 65 in the last 14 days, or it reappears in today's search results
   - `lastCheckedAt` is more than 48 h ago
   - it is within the per-run cap (default 10)

   Eligible URLs are re-extracted and compared on normalized `contentHash` and headline.
   - **Unchanged:** only `lastCheckedAt` is updated. No AI call.
   - **Changed:** one triage-tier call classifies the change:
     - `cosmetic` (record the revision only)
     - `updated_reporting` (same development, new material information; the story is re-evaluated, marked _Updated_, and can return to the shortlist only when the new information is evidenced)
     - `new_development` (goes to clustering as a new candidate linked to the original story)

   Every check is stored in `revisions[]`.

5. **Extract.** Tavily `extract` for new articles, in batches of ≤ 20, with text capped at about 12k chars.
6. **Triage (triage tier).** Triage is batched to keep cost low. It produces: in-scope, exclusion signals, entities, places, event date, and a one-line event description. Basic date and source validation is deterministic. Out-of-scope articles are kept but marked.
7. **Cluster (primary tier).** Deterministic pre-grouping first (canonical URL, title similarity plus entity/date overlap). Then one bounded AI call groups the remaining articles. The call also sees about 21 days of recent stories (including skipped ones) and labels each group `new` / `same-development-as:<id>` / `new-development-of:<id>`.
   - Same development, no new info → no new recommendation. A previously skipped story stays suppressed.
   - New development → new Story linked via `relatedStoryIds`. Skipping an auction announcement doesn't block the result.
8. **Evaluate (primary tier, bounded escalation).** One child task per cluster (cap ~25), with retries. It returns structured JSON validated by Zod: gate findings, dimension scores 0–5 with rationales, and card fields. **The total is computed in code**, never taken from the model. `applyGates()` in `@repo/shared` returns pass/hold/reject:
   - Deterministic gates: source exists, freshness, duplicate/suppressed, editorial-test sentence is specific.
   - AI-flagged gates: playbook exclusions, each requiring an evidence-based exception explanation to pass.
   - A critical source/accuracy/rights/ethics failure means hold or reject regardless of score.
   - **Every candidate gets exactly one recorded outcome**, stored on its story and counted in the run `funnel`. The outcomes are: `qualified`, `below_threshold` (with score), `gate_hold`/`gate_reject` (with the gate ids and evidence), `suppressed_repeat`, `evaluation_failed` (with error and attempts, after retries are exhausted), `source_failed` (search or extract failure upstream) and `deferred_late`. Nothing silently disappears, so the operations dashboard can explain every gap.
   - **Shortfall visibility.** When qualified stories < `SHORTLIST_TARGET_MIN` (default 5), step 11 turns these counts into explicit reasons: insufficient candidates, failed sources, evaluation failures, editorial gates (broken down by exclusion type), below threshold, suppressed repeats. The operations dashboard shows them for that run, with a drill-down list of the affected candidates and their individual reasons. **The 65 threshold and the gates are fixed inputs to ranking; no code path relaxes them based on how many stories qualified.** A test asserts this: a fixture day with 2 qualifiers yields a 2-item shortlist plus reasons.
9. **Deadlines.** Defaults are soft 02:00, extension to 03:00 if fewer than 3 candidates are evaluated, and hard 04:00 Chicago time. The orchestrator polls with `wait.for`. At close it sets `candidateSetClosedAt`. Late children mark their candidate `deferred` for the next run.
10. **Rank.** Only `pass` stories with score ≥ 65 qualify, sorted by score (ties → confidence, then tier as a soft tiebreak only). At most 8, possibly zero. **The threshold is never lowered to fill the list.**
11. **Explain shortfalls.** When fewer than 5 stories qualify, `deriveShortfallReasons(funnel)` (a pure, tested function) records the dominant causes with counts:

- `insufficient_candidates`
- `source_failures` (search or extract errors)
- `evaluation_failures`
- `editorial_gates` (by exclusion type)
- `below_threshold`
- `suppressed_repeats`

The operations page shows the funnel and these reasons. The newsroom shows a short note, e.g. "3 stories met the bar today", with a link to why.

All limits come from `readDiscoveryConfig()` (`packages/core/src/discovery/config.ts`, the source of truth for every variable and default), with env overrides. The main ones are in the table below.

**Retries.** Trigger.dev `retry: {maxAttempts: 5, factor: 2, minTimeoutInMs: 2000, maxTimeoutInMs: 60000, randomize: true}`. Permanent errors (validation, config, 4xx) abort without retry. The exact v4 API (`AbortTaskRunError`, `schemaTask`, `wait.for`, `batch.trigger`) will be verified against docs at install. Every side effect is an upsert keyed by a deterministic id.

## Research, chat, generation

- **Research.** `POST /api/stories/[id]/research` → `requireUser` → create a task with `activeLock` (a 409 if one is already active) → trigger `research-story`. The worker:
  - loads the story's persisted sources
  - optionally runs ≤ 3 Tavily searches + extract; **every supplementary source is upserted into `sourceArticles` (`origin: research`) before the model sees it**
  - numbers the persisted sources `[S1..Sn]`
  - calls the primary tier (escalation tier if escalated) with structured output
  - **validates citations against the persisted records, not the model response.** Each cited label must map to a `sourceArticles` document in this brief's source set; unknown labels mean the claim is dropped, counted and logged. The claim's evidence excerpt is searched for, after whitespace and quote normalization, in that record's stored text: found → `verified`; not found → `excerpt_not_located`, shown to the editor with a warning and never silently presented as verified.
  - takes URLs, publishers and dates only from DB records, never from model text

  It records each step it actually takes, with counts of what it found, on the task document, and the workspace shows those steps (ADR-037). The chat input is disabled while research or a chat reply is active.

- **Chat** (revised 2026-10-16, ADR-035/036; 2026-10-17, ADR-038). Each question is saved, then the reply streams from the web app as one bounded model call. That call reads the story's saved research and judges what it means for the question (`sufficient`, `needs_research` or `out_of_scope`), then answers in checked statements with the same validation.
  - When the saved research doesn't establish the answer, the reply starts focused research on its own, at most once per reply and within the daily limits.
  - Its findings appear inside that reply, and later questions reuse them.
  - Chat itself never searches the web.
- **Generation** (implemented 2026-10-16, ADR-029).
  1. `POST /api/stories/[id]/drafts {format, instructions?, fromVersion?}` creates a `generate-draft` task. It runs on the primary tier with format-specific rules, the voice "avoid" list and the brief evidence, with each claim tagged by how it was checked.
  2. The result is a new `draftVersion`, idempotent on taskId. The draft's listed statements are checked against stored source text. While the task runs, its text streams into the studio as a preview marked "not yet checked or saved", which is dropped when the task ends (ADR-037).
  3. Over a character limit, the model gets one shortening request; if the draft is still over, it is flagged, never cut.
  4. `PUT {format, baseVersion, title?, body}` creates a new `edited` version only if the content changed. Nothing is overwritten.
  5. Copy goes to the clipboard. No publishing.

## Auth and permissions

Better Auth 1.7 with email + password (ADR-017). Configuration lives in `packages/core/src/auth/better-auth.ts`.

- **Invite-only registration.**
  1. An owner creates an invitation (email + role) from the Team page. The very first owner uses the `pnpm owner:invite` CLI instead. Only a SHA-256 hash of the 32-byte token is stored, and the invitation expires in 7 days.
  2. The invitee opens `/invite/[token]`. The page shows invalid, expired, revoked or used states, or a form with the fixed email, a name and a password.
  3. `POST /api/invitations/accept` re-checks the token and calls Better Auth's sign-up server-side, with the email taken **from the invitation** and the token passed as the invite cookie.
  4. Better Auth's `hooks.before` gate on `/sign-up/email` rejects any request without a claimable token for that email (403, uniform, so it never reveals which emails have accounts). The user-creation hook then **atomically claims** the invitation (token hash + email + unexpired + pending), sets the role, and marks the email verified (the link proved inbox control). The `after` hook marks it accepted.
  5. The new user is signed in (httpOnly session cookie).
- **Passwords.** 12–128 characters, hashed with scrypt by Better Auth. A failed password check never consumes the invitation.
- **Sign-in.** `/login`, email + password. Wrong passwords and unknown accounts get the same generic error.
- **Rate limiting.** Better Auth's limiter with **database storage**, so limits hold across serverless instances. Sign-in is limited to 5/min per client, sign-up to 5/5 min, and password reset to 3/5 min. It is on in production.
- **Sessions.** Stored in the DB. Deactivating a user deletes their sessions, and a session-create hook refuses deactivated users. Password reset revokes all sessions.
- **Password reset.** Better Auth's reset flow (1-hour tokens), delivered by email via Resend (Phase 3). Until Resend is configured, reset requests fail with a clear configuration error and an owner can issue a fresh invitation instead.
- **Enforcement.** `requireUser()` and `requireOwner()` re-read role and status from the DB on every protected request. `proxy.ts` only does an optimistic redirect.
- **First owner.** `pnpm owner:invite you@domain.com` refuses if an active owner exists. There is no HTTP owner-registration route.
- **Tests** (Better Auth's real HTTP handler, in-memory replica set): invited sign-up; public sign-up without a token (403); a valid token with the wrong email; a weak password not consuming the invitation; reuse; a race producing exactly 1 user; no account enumeration through sign-up or sign-in; deactivated sign-in refused; 429 under the rate limiter; DB-level unique email; owner-only checks in route helpers.

## UI (Phase 3–5)

Routes:

- `/login`, `/invite/[token]`
- `/` (newsroom: today's ranked shortlist, run status, date switcher)
- `/stories/[id]` (card, score breakdown, gates, sources, decision log, and the next-step panel)
- `/stories/[id]/research` (full-screen research workspace: briefs and chat; ADR-026)
- `/stories/[id]/studio` (full-screen content studio: format picker, instructions, editor, statement checks, version history, copy; ADR-029)
- `/saved`
- `/operations` (runs with funnel and shortfall reasons, failed tasks, token usage, the English-only limitation notice; owner-only "Run discovery now")
- `/settings/team` (owner-only users and invitations)

**Design system first:** the shadcn base themed with Omenai tokens (paper/bone/ivory grounds, ink text, hairline rules, ochre accent; **light only**, see ADR-022) and an editorial type scale. Editorial components live in `apps/web/src/components/editorial/` (redesign, 2026-10-15). On top of it go domain components: StoryCard, ScoreBreakdown, GateList, SourceList, CitationChip, StatusPill, EmptyState, ErrorState, VersionTimeline. Every data screen has loading, empty, error and success states.

## Phases and acceptance criteria

| Phase                        | Deliverables                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Accept when                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0 Docs** (day 1)           | `CLAUDE.md`, `docs/IMPLEMENTATION_PLAN.md` (+ post-MVP list), `ARCHITECTURE_DECISIONS.md`, `PROGRESS.md`, `VERIFICATION.md`; fix `.env.example` and README                                                                                                                                                                                                                                                                                                                                                                                                         | Docs reflect this plan; stale `API_URL` removed                                                                                                                                                                                                                                                                                                                                                                       |
| **1 Foundation** (days 1–3)  | `@repo/core` (env validation with clear `ConfigError`, a shared MongoClient for Mongoose and Better Auth, Mongoose models and `syncIndexes`), `apps/worker` Trigger.dev skeleton, Better Auth (email + password, invite-only) with hooks, requireUser/requireOwner, owner CLI, provider-agnostic LLM layer (Gemini + Anthropic adapters), test harness (Vitest + `MongoMemoryReplSet`)                                                                                                                                                                             | `pnpm check` passes; every auth security test listed under Auth passes; provider-switch tests pass; Atlas connectivity verified                                                                                                                                                                                                                                                                                       |
| **2 Discovery** (days 3–8)   | Taxonomy, gates, scoring, Chicago run-key resolver, run and task state machine, Tavily client with usage logging, pipeline stages on `LlmClient` (Gemini in dev), pipeline stages including bounded revisits, shortfall reasons, the Trigger.dev schedule, the manual-run route, the source registry                                                                                                                                                                                                                                                               | Unit tests pass for: scoring, gates, run keys across the DST cases (2026-11-01, 2027-03-14), duplicate triggers (schedule + manual + retry), dedupe, change classification (unchanged → no AI call), shortfall reasons, leases. A fixture-driven pipeline test produces a shortlist, plus a fixture case with fewer than 5 qualifiers that shows reasons and no threshold change. One real run when credentials exist |
| **3 Dashboard** (days 8–12)  | shadcn-based design system, newsroom, story detail, saved, save/skip, team and invitations, operations (run funnel, shortfall reasons, per-candidate outcome drill-down, failed tasks)                                                                                                                                                                                                                                                                                                                                                                             | All screens use real data with every state; a run with fewer than 5 qualifiers shows its reasons on the operations page and a short-list notice on the newsroom; route-handler auth tests (an editor gets a 403 on owner APIs; unauthenticated requests get a 401)                                                                                                                                                    |
| **4 Research** (days 12–14)  | Research and chat tasks, persistence of supplementary sources, polling UI, citation rendering with verified/unlocated states                                                                                                                                                                                                                                                                                                                                                                                                                                       | Citation tests against persisted records (unknown label dropped; excerpt located vs not); research survives a tab close (manual check); chat lock enforced                                                                                                                                                                                                                                                            |
| **5 Studio** (days 14–16)    | Five formats, instructions, editor, versions, copy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Version-preservation and channel-limit tests                                                                                                                                                                                                                                                                                                                                                                          |
| **6 Hardening** (days 16–18) | Service-level E2E smoke (fixtures: discover → shortlist → research → draft), failure/idempotency review, security review, **provider switch to Anthropic** (configure the key, run the live and regression suites, confirm no Gemini-specific logic outside adapters), security review, deployment docs (Vercel Pro, Trigger.dev deploy and paid-plan schedule check, Atlas network access and least-privilege user; prepared in `docs/DEPLOYMENT.md`, 2026-10-16), handover. **No production deploy until the provider switch and security checks are complete.** | All 15 MVP criteria walked through, with verified and unverified items in VERIFICATION.md                                                                                                                                                                                                                                                                                                                             |

## Verification approach

- Run `pnpm check` (format, lint, typecheck, test, build) at each phase.
- Pure logic tests in `@repo/shared`. Service and integration tests in `@repo/core` against an in-memory replica set. Route-handler tests with a mocked session. A fixture-driven E2E pipeline test, with fixtures clearly labelled as such.
- Real-integration checks (Atlas, Gemini, Tavily, Trigger.dev dev run, Resend, and Anthropic before production) only when credentials are supplied. Until then they are marked **unverified** in VERIFICATION.md, never reported as passing.
- Browser check of the UI with the dev server.
- Live LLM check: `LLM_LIVE_TESTS=1` runs `packages/core/src/llm/live.test.ts` against the configured provider.
- Commits are made only when the product owner asks.

## Critical files (new unless noted)

- `CLAUDE.md`, and `docs/*.md` (4 records)
- `packages/shared/src/{taxonomy,scoring,gates,schedule,schemas/*}.ts` (the package exists; extend it)
- `packages/core/src/{env,db/client.ts,db/models/*,services/*,ai/*,search/*,email/*,prompts/*,discovery/*}.ts`, plus `src/cli/owner-invite.ts`
- `apps/worker/{trigger.config.ts,src/trigger/*.ts}` (including the `daily-discovery` schedule)
- `apps/web/src/lib/{auth,session}.ts`, `src/proxy.ts`, `src/app/api/**/route.ts`, `src/app/(app)/**`, `src/components/ui/*` (shadcn), `components.json`
- Modify: `apps/web/package.json`, `.env.example`, `README.md`, `pnpm-workspace.yaml` (catalog entries and `allowBuilds` if needed)

## Configuration defaults (initial, to be tuned after observing real runs)

All of these live in `packages/core/src/config.ts` and can be overridden by environment variables. Change them deliberately and record why in `PROGRESS.md`.

| Setting                                             | Env var                                                            | Default                                       | Why this value                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------- | -------------------------------------------------------------------------------- |
| Discovery queries per run                           | `DISCOVERY_MAX_QUERIES`                                            | 10                                            | ~10 Tavily searches/day keeps search spend tiny while spanning tiers and pillars |
| Results per query                                   | `DISCOVERY_RESULTS_PER_QUERY`                                      | 8                                             | ≤ 80 raw URLs/day before dedupe                                                  |
| Max new articles extracted                          | `DISCOVERY_MAX_EXTRACT`                                            | 60                                            | Bounds Tavily extract credits and triage tokens                                  |
| Revisit cap per run                                 | `DISCOVERY_MAX_REVISITS`                                           | 10                                            | Bounded re-checks of known sources                                               |
| Revisit min interval                                | `DISCOVERY_REVISIT_INTERVAL_HOURS`                                 | 48                                            | Avoids re-reading unchanged articles                                             |
| Clusters evaluated per run                          | `DISCOVERY_MAX_EVALUATIONS`                                        | 25                                            | Bounds the expensive primary-tier calls                                          |
| Escalations per run                                 | `AI_MAX_ESCALATIONS_PER_RUN`                                       | 4                                             | Keeps escalation exceptional                                                     |
| Freshness window                                    | `DISCOVERY_FRESHNESS_DAYS`                                         | 14                                            | Older items need an explicit evergreen rationale                                 |
| Shortlist max                                       | `SHORTLIST_MAX`                                                    | 8                                             | Playbook: 5–8/day                                                                |
| Shortlist target min (for shortfall reporting only) | `SHORTLIST_TARGET_MIN`                                             | 5                                             | Never used to relax the threshold                                                |
| Qualification threshold                             | `SCORE_SHORTLIST_THRESHOLD`                                        | 65                                            | Playbook                                                                         |
| Priority threshold                                  | `SCORE_PRIORITY_THRESHOLD`                                         | 80                                            | Playbook                                                                         |
| Soft / extension / hard deadline (Chicago)          | `RUN_SOFT_DEADLINE`, `RUN_EXTENSION_DEADLINE`, `RUN_HARD_DEADLINE` | 02:00 / 03:00 / 04:00                         | Generous: real runs should finish in minutes                                     |
| Minimum evaluated before extension                  | `RUN_MIN_CANDIDATES`                                               | 3                                             | Triggers the bounded extension                                                   |
| Discovery languages                                 | `DISCOVERY_LANGUAGES`                                              | `en`                                          | **Known MVP limitation** — see below                                             |
| Run lease                                           | `RUN_LEASE_MINUTES`                                                | 30                                            | Covers the longest stage between heartbeats                                      |
| Task retry attempts                                 | (code)                                                             | 5                                             | Brief: max five attempts for retryable failures                                  |
| LLM provider                                        | `LLM_PROVIDER`                                                     | `gemini` (dev); `anthropic` before production | ADR-016                                                                          |
| Models per tier                                     | `GEMINI_MODEL_{TRIAGE,PRIMARY,ESCALATION}`, `ANTHROPIC_MODEL_{…}`  | See decision 2                                | Defaults live only in `packages/core/src/llm/config.ts`                          |

### Known limitation: English-language discovery

The MVP discovers stories only through English-language sources. This is a deliberate cost and scope limit, not an editorial position. The playbook warns that "English-language visibility is not a proxy for cultural importance". The models are told that missing English coverage is not evidence that a development doesn't exist or doesn't matter. Adding more languages is on the post-MVP list.

## Post-MVP list (valuable, deliberately deferred)

- Multilingual discovery (French, Portuguese, Arabic, Swahili, etc.) and region-specific source registries.
- Searching inside the chat call itself. Since 2026-10-17, a gap the saved research can't fill starts focused research on its own (ADR-038). The chat call stays grounded in the stored research.
- Research across stories (a question answered from another story's research). Deliberately out of scope for ADR-038.
- Weekly 8–12 item editorial review view and rapid-response alerts (playbook §7).
- Editor decision analytics, source-quality scoring, and 30/90-day geographic and pillar balance reports (playbook §13).
- Calibration tooling: editor-labelled examples (excellent / acceptable / rejected) fed back into prompts.
- Cost dashboard with provider pricing (MVP stores raw usage only).
- Channel assignment and publication workflow, and performance feedback ingestion.
- Story merge/split tools for editors.
- Browser end-to-end tests (Playwright) with a test-only auth strategy.
- Batch API for triage, to halve the cost of non-urgent AI work.
- A deterministic low-quality-extraction check (navigation-only pages) to skip evaluation calls.
- A calibration set of editor-labelled real stories for the gates and scoring (the critical-issue threshold in particular).
- **Multiple images per story** (deferred 2026-10-17; scope note in PROGRESS.md).
  - **Today:**
    - Each source keeps one preview image: the first usable link Tavily returns for the page (https, a photo format, no logos or tracking images), with its alt text, capture time and rights recorded as unverified.
    - Each story shows one representative image, chosen deterministically.
    - Nothing is downloaded or hosted; every image is a link to the publisher's copy.
    - The page's other image links are discarded at extraction.
  - **Needed later:**
    - keep the filtered candidate list from extraction (the first step, and small)
    - per-image metadata (dimensions, credit, rights status)
    - an editor's selection workflow and a gallery view
    - a rights check before any image is used
    - possibly storage or a proxy for publishers that block hotlinking
