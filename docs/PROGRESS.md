# Progress

_Last updated: 2026-10-20_

## Status by phase

| Phase                      | Status                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------- |
| 0 — Audit, plan, records   | ✅ Done                                                                                |
| 1 — Foundation             | ✅ Done (revised 2026-10-15: email + password auth, LLM layer, Atlas live)             |
| 2 — Data model & discovery | ✅ Implemented and fixture-verified; a live run awaits approval                        |
| 3 — Dashboard              | ✅ Done; full newsroom redesign (ADR-040) browser-checked at 1440 and 390 (2026-10-20) |
| 4 — Research assistant     | ✅ Implemented and fixture-verified (2026-10-15); live run awaits approval             |
| 5 — Content studio         | ✅ Implemented and fixture-verified (2026-10-16); a live draft awaits approval         |
| 6 — Hardening & handover   | 🚧 In progress: offline work done (2026-10-16); live checks and deploy await approval  |

## Completed

- **Phase 0 (2026-10-14).** Audit, playbook, documentation checks, approved plan, project records.
- **Phase 1 (2026-10-14).** Core package, invitations, roles, owner CLI, web auth shell, shadcn design tokens, worker skeleton.
- **Phase 1 revisions (2026-10-15).** These follow the product owner's updates:
  - **Auth: Google OAuth → invite-only email + password** (ADR-017).
    - Better Auth `emailAndPassword` (12–128 characters, scrypt).
    - A sign-up gate that prevents account enumeration, plus the atomic invitation claim in the user-creation hook.
    - A transaction-aware session hook.
    - A database-backed rate limiter.
    - The `/login` form and the invitation password form.
    - `POST /api/invitations/accept`, which signs up server-side with the email taken from the invitation.
  - **Provider-agnostic LLM layer** (ADR-016) in `packages/core/src/llm/`:
    - `LlmClient` (`generateObject` / `generateText`)
    - Gemini and Anthropic adapters, each with its own schema dialect, effort mapping, stop reasons, usage and error mapping
    - one bounded repair round
    - usage recorded in the `aiUsage` collection
    - env-configured provider and models
  - **MongoDB Atlas.** Configured and verified: connectivity, permissions, transactions, indexes (ADR-018).
  - **Trigger.dev.** Project `proj_ydafdiqitotsvbyazmaw`, SDK/CLI/build 4.7.4, `.trigger/` ignored. `trigger dev` is running locally, and the `ops-database-ping` run completed (ADR-020).
  - **Tavily.** `@tavily/core` installed. The global CLI and agent tooling from Tavily's SKILL.md were deliberately not installed (ADR-019).
  - Plan, ADRs, env examples, README and CLAUDE.md updated.
- **Phase 2 (2026-10-15).** No real AI or Tavily calls were made (budget rule).
  - `@repo/shared/editorial`: the playbook taxonomy as controlled vocabularies, weighted scoring (computed in code), mandatory gates, outcome classification and ranking (never padded), recommended action, shortfall reasons, and Chicago run keys.
  - `@repo/core`:
    - models `SourceArticle`, `Story`, `WorkflowRun` and `Task`
    - URL, date, hash and similarity normalisation
    - run lifecycle (idempotent start, leases, bounded retries, escalation budget, candidate-set close)
    - stage tasks
    - the Tavily search client with credit recording
    - the discovery config and source registry with daily tier-weighted query rotation
    - prompts and output schemas
    - the stages discover, revisit, extract, triage, cluster, evaluate and finalize, plus `runDiscoveryInline`
    - test fixtures: a fake search and a scripted LLM behind the real `LlmClient`
  - `apps/worker`: `daily-discovery` (midnight America/Chicago, production only), `discovery-run` (orchestrator: lease, fan-out, polling with `wait.for`, deadlines) and `discovery-evaluate` (up to 5 attempts, aborting on permanent errors). These tasks build and register with `trigger dev`.
  - `apps/web`: owner-only `POST /api/runs` (manual run, refuses overlap).

- **Phase 3 (2026-10-15).** No AI or Tavily calls.
  - Core newsroom services: newsroom shortlist (latest or chosen run), story detail (full §11 card, score breakdown, gates, sources, related developments, decision log, history), saved stories, run list and detail (funnel, shortfall, every candidate, errors, failed tasks, usage), 7-day usage, and save/skip decisions with an audit trail.
  - Team: `inviteMember` (link always returned, emailed through Resend when configured) and a Resend email module with invitation and password-reset templates.
  - Routes:
    - `POST /api/stories/[id]/decision`
    - `POST /api/team/invitations`
    - `DELETE /api/team/invitations/[id]`
    - `PATCH /api/team/users/[id]`

    All re-check role on the server.

  - UI (shadcn themed to Omenai, without overwriting the custom button):
    - app shell with responsive nav (mobile sheet), skip link and error boundary
    - Newsroom with a run picker and shortfall notice
    - Story detail
    - Saved
    - Operations (owner-only "Run discovery now" with a cost confirmation)
    - Run detail
    - Team (invite with copy link, roles, deactivate/reactivate, revoke)
    - Forgot/reset password pages
    - Loading skeletons, empty states and toasts throughout.
  - The fixture seed (`pnpm db:seed-fixtures`, guarded to `*_fixtures` databases) is seeded in Atlas `omenai_fixtures`. The real smoke data in `omenai` is untouched.

- **Editorial UI redesign and story imagery (2026-10-15).** No AI or Tavily calls.
  - **Look and feel ("atelier edition", light only, ADR-022; palette and type superseded by ADR-040 on 2026-10-20):** paper, bone and ivory grounds, ink text, one terracotta-ochre accent; Instrument Serif headlines, Newsreader reading text, Geist interface text; a fluid canvas up to 1440px with shared gutters.
  - **Plain language:** one copy layer (`components/editorial/copy.ts`). Editors see "stories reviewed", "editorial checks" and "Needs checking first", never candidates, gates or run keys. Every non-recommended story gets one sentence from stored facts (`reviewReason`).
  - **Pages:**
    - Today's edition: a lead feature, a feature or grid for the rest, a small-edition note and "Also reviewed" with reasons.
    - Story dossier: a reading column, a decision panel and sidebar, and "How this story was assessed" behind a disclosure.
    - Reading list: who saved each story and when.
    - Operations: five plain questions, usage with estimates, and edition history.
    - Run detail: a plain summary first, with technical detail in disclosures.
    - Team: a role explainer, next-step invite text, and confirmation dialogs.
    - Sign-in pages restyled.
  - **Story imagery (ADR-023):**
    - Tavily extract now asks for images.
    - A deterministic filter picks one preview image per article and stores it with `rights: 'unverified'`.
    - The story image is chosen at read time by source quality.
    - Images are never sent to the model and never affect scores or ranking (tested).
    - Displayed lazy-loaded with a credit line and a typographic fallback; no downloading or hosting.
  - **Cost estimates (ADR-024):** a dated list-price table; always labelled "Estimate"; the Gemini free tier shows as "Free tier, no charge".
  - **Read-model additions only:**
    - `image` on story cards, details and sources
    - `reviewed[]` and edition counts on the newsroom
    - `reason` on run-detail outcomes
    - `getOperationsOverview()`
    - `saved {by, at}` on reading-list items

    No API contract, auth or business-rule changes.

- **UI refinement and fixture scenarios (2026-10-15).** No AI or Tavily calls.
  - **Scenarios:** `pnpm db:seed-fixtures` seeds `full` (default) or `empty` into a `*_fixtures` database, through the real invitation, pipeline (scripted search and model), decision and task code. The catalogue lives in `packages/core/src/testing/scenarios/`.
    - `full` has six editions, one per state (failed, empty, small, failed sources, full with ranked-out stories, in progress), every image case, related developments, saved and skipped stories, and a team with every invitation state.
    - `empty` is a brand-new newsroom with only the owner.
  - **Simulated usage:** fixture usage is stored with `simulated: true` and shown separately ("Simulated usage (development fixtures)"), never totalled with provider-reported usage. Requests whose credits weren't reported show "Not available yet" instead of $0.
  - **Fixture safeguards:** a banner on every page when connected to a `*_fixtures` database, and seeding refused elsewhere. `EMAIL_TRANSPORT=fixture-sent` or `fixture-failed` simulates the email provider (refused outside fixtures DBs), so the "emailed" and "email failed" invite states can be seen without sending mail.
  - **UI:**
    - a wider canvas (up to 1664px)
    - headlines that step down in size when long
    - portrait images shown whole on a mat
    - credit line "Image via {publisher} · credit and rights not confirmed"
    - empty optional story sections replaced by one "Not covered in this assessment" line
    - notes for an edition in progress, a failed latest search and failed sources
    - "met the standard but stronger stories filled the edition" for ranked-out stories
    - Operations: progress, a plain failure cause with a next step, and retries
    - Team: an empty-team hint, a next step for expired invitations, and inline invite errors
  - **Not done:** research-brief and draft-version fixtures. Those features don't exist yet (Phases 4–5); add them to the scenario catalogue when built.

- **Phase 4: research assistant (2026-10-15).** No AI or Tavily calls.
  - **Data:** `researchBriefs` (one per task, `taskId` unique) and `chatMessages` (assistant replies keyed by `taskId`, sparse unique).
  - **Research** (`packages/core/src/research/`):
    - The search queries come from the story itself, with no model call: up to 2 searches, or 3 for in-depth research.
    - New articles are stored in `sourceArticles` (`origin: research`) **before** the model sees them.
    - Sources are labelled S1…S10 and the brief is written on the primary tier (escalation tier for in-depth: one escalation per task).
    - **Every citation is checked against our stored text:** an unknown label drops the claim, and a quote not found word for word is flagged "couldn't be found". Analysis and open questions may cite nothing.
    - Research sources are not added to the story's own source list, so discovery data stays as it was assessed.
  - **Chat:** answers from the latest brief and its sources only (no web), with the same checks. Unknown `[S#]` markers are removed and recorded.
  - **Concurrency:** one research or chat task per story (`activeLock` on the task record, shared by both kinds). A second request gets a plain 409. A lock with no progress for 45 minutes is treated as abandoned.
  - **Worker:** `research-story` and `chat-reply` tasks (3 attempts, permanent errors abort). The permanent-error check moved into core as `isPermanentError`.
  - **API:**
    - `GET /api/stories/[id]/research` (the polled view)
    - `POST /api/stories/[id]/research` (`{depth}`, 202)
    - `POST /api/stories/[id]/chat` (`{message}`, 202)

    Each re-checks permissions. If the worker can't be reached, the lock is released and a plain 503 is returned.

  - **UI:**
    - a "The story / Research" switch on the story page
    - a research tab with progress steps (polling every 3 s), a brief with claims tagged fact / claim by a source / our analysis / open question
    - source chips that open to the exact quote and say whether we found it
    - a source key (with "Found during research"), the conversation with evidence, and a locked input while anything runs
    - plain failure messages with "Try again", and confirmation before spending credits on a new brief
  - **Fixtures:** the `full` scenario now includes, through the real services:
    - a brief for the Lagos biennale (4 verified, 1 quote not found, 1 claim dropped, 2 sources found during research)
    - a conversation (one verified citation, one invented marker removed)
    - a failed research attempt on the Kinshasa story

- **Research workspace redesign (2026-10-15).** No AI or Tavily calls.
  - **Full screen:** `/stories/[id]/research` is a full-screen chat workspace, in its own route group `(workspace)` with no newsroom navigation. The URL is unchanged. The story page has an "Open the research assistant" button.
  - **Opening it:**
    - With no research yet, Omenai starts the briefing (`auto`, refused once a brief exists) and shows a welcome, then progress.
    - With research running, it reconnects.
    - Otherwise it loads every brief and message in order. The briefing is Omenai's first reply, introduced by a centred system line rather than an editor message.
  - **Conversation:**
    - citation chips open evidence popovers; a sources panel lists everything used
    - the composer is pinned (Enter sends, Shift+Enter adds a line), and an unsent draft is kept per story
    - it follows new messages only when the reader is at the bottom, with a "Jump to latest" button
    - failures get plain words and a retry. No ids, model names or raw errors are shown.
  - **Story boundary (server-side):**
    - A cheap triage-tier scope check runs before every answer. Off-topic questions get a fixed, server-written reply and never reach the answering model.
    - Follow-up research only follows a lead from an approved same-story reply, with the focus read from the database.
    - Search results are checked lexically against the story's names and city (ADR-026) and discarded before anything is read or stored.
  - **Credits:**
    - A retry reuses the sources a failed attempt already found (`foundSourceIds`), with no new searches.
    - Omenai's automatic briefing can't run twice for a story.
  - **Fixtures:**
    - Against a `*_fixtures` database, research and chat run in-process with the scripted assistant (`@repo/core/fixtures`, `runFixtureStoryTask`), never through Trigger.dev, so the whole workspace can be used locally.
    - Seeded conversations:
      - biennale: a briefing, an on-topic answer, the off-topic reply, a lead and a follow-up
      - Casablanca: its own briefing and answer
      - Kinshasa: a failed attempt (retry works)
      - Dakar: research in progress
- **Concise research briefing (2026-10-15).** A targeted refinement. No AI or Tavily calls.
  - **Brief format (ADR-027):**
    - The model now returns named parts made of checkable claims: `overview`, `whyItMatters`, `findings`, `toConfirm` and `background`, plus people and next steps.
    - The prompt aims for about 150–250 words across the first four and asks for natural sentences that carry attribution and uncertainty in the wording.
    - Stored sections get a server-fixed `kind` and title.
    - The overview is now cited and checked like every other claim. The stored `overview` text is built only from claims that passed the checks.
  - **Chat:** answers lead with the direct answer and stay at two to five sentences unless the editor asks for more.
  - **Presentation:**
    - Prose with no claim labels. "Why it matters" is a run-in heading, and "Still to confirm" is a short list.
    - One plain evidence line, then "More detail" (background, people, next steps) and "Sources and evidence" (how each point was checked, plus the sources).
    - Kinds of claim are explained to screen readers and on hover.
    - `brief-digest.ts` decides placement and wording. It never drops a claim or changes its status, and it moves misfiled open questions into "Still to confirm".
  - **Layout:**
    - A 752 px reading column of 18 px serif.
    - The composer matches the column, with a fade above it and the hint inside.
    - The Sources panel shows each source's check results.
  - **Fixed along the way:** a poll in the gap between "result saved" and "lock released" no longer shows a running task beside its own result.
  - **Older briefs:** briefs stored before this change (no `kind`) still render, placed by their title.

- **UX refinement: from dashboard to editorial experience (2026-10-15).** Front end only, plus one read-only query. No AI or Tavily calls.
  - **Design language:**
    - One radius scale (controls about 10px, cards 12px, dialogs about 17px).
    - A soft `.surface` and a recessed `.surface-quiet`, with softer hairlines.
    - Tinted status callouts instead of hard rules.
    - Accordions that open smoothly where the browser can animate them.
    - Roomier buttons with one hierarchy: ink for primary, outline for secondary, quiet text for tertiary.
    - Display-style dialog titles.
  - **Newsroom:**
    - Cards keep only the essentials, with clear actions.
    - A per-pillar line motif replaces the text placeholder for missing images.
    - Small and empty editions get one sentence, with reasons on demand.
  - **Story detail:**
    - The overview comes first, beside a sticky next-step panel with the review → research → create → refine indicator and one research-aware primary action.
    - "Things to check" stays visible.
    - Five groups hold the rest; nothing was removed.
    - The tabs were removed; the indicator links to research.
    - Backed by the new read-only `getResearchStatus` query.
  - **Research:** suggested questions after a fresh briefing, and surfaces on the new tokens.
  - **Operations:**
    - Five plain-language answer cards.
    - An attention list with what to do, where self-correcting items don't count as needing attention.
    - Usage and history behind disclosures.
  - **Team:**
    - The invite card with roles inline.
    - Members and outstanding invitations kept separate, past invitations collapsed.
    - "Invite again" prefills the form.

- **Gap fixes after the UX refinement (2026-10-16).** No AI or Tavily calls.
  - **Find today's stories, made safe to confirm against fixtures.** It used to call Trigger.dev even against a fixtures database. Now a `*_fixtures` database runs the real pipeline in-process with scripted pages (`runFixtureDiscovery`, ADR-030). Confirmed end to end in the browser, along with Skip and Undo.
  - **Reduced motion.**
    - Accordions, dialogs, popovers and sheets now appear instantly.
    - Looping animations run once instead of flickering.
    - Scripted smooth scrolling respects the setting (`lib/motion.ts`).
    - Verified with Chrome's emulation.
  - **Retries.**
    - `TASK_MAX_ATTEMPTS` is the single table of retry limits.
    - The server marks attention items `automatic` while work is still retrying. Operations lists "Retrying on its own" ("Attempt 2 of 5 under way") apart from "Needs attention".
    - Exhausted, permanent or 45-minute-quiet retries move to "Needs attention" with what to do and a link (research, drafts or story). Failures an editor already superseded drop off.
- **Phase 5: content studio (2026-10-16).** No AI or Tavily calls (ADR-029).
  - **Formats** (`@repo/shared` `DRAFT_FORMATS`, `measureDraft`):
    - Weekly Briefing item (150–300 words)
    - editorial article (800–1,500 words)
    - LinkedIn post (3,000 characters)
    - Instagram caption (2,200 characters)
    - X post (280 characters)
  - **Data:**
    - `draftVersions` is append-only, with a unique version per story and format, and `taskId` sparse-unique.
    - Task records gain `format`, `instructions` and `fromVersion`.
    - The story lock helper moved to `tasks/service.ts` (`createLockedTask`), so drafts lock per story and format.
    - Research lookups now ignore draft locks.
  - **Generation** (`drafts/service.ts`, worker task `generate-draft`, model only):
    - A draft is written from the newest three briefs, with each claim tagged by how it was checked; the editor's note is passed as fenced data.
    - The statements the model lists are checked against stored source text with the research checks. The body carries no labels.
    - Over a character limit, it gets one shortening request, then the result is flagged, never cut.
    - Research is required first.
  - **Editing:** a new version only when the text changed. Restore and revise add versions; nothing is overwritten.
  - **API:** `GET`/`POST`/`PUT /api/stories/[id]/drafts`, with server-side permission checks (`drafts:generate`, `drafts:edit`, both roles).
  - **Studio:** `/stories/[id]/studio`.
    - Layout: format list, editor with a live count, "Ask Omenai for another version", "Before you use it" (statement checks, still to confirm, image rights), and version history.
    - Unsaved edits are kept per version, there's a leave-page guard, and Ctrl+S saves.
    - Copy copies the text; nothing is published.
  - **Story page:** "Create content", then "Continue drafting", once research is ready; the workflow steps link to the studio. The research header has "Write a draft".
  - **Fixtures:** `full` now seeds a draft history and a failed draft. Drafts run in-process with a scripted writer (`draft-script.ts`), and the text is marked as invented.

- **Phase 6: hardening, offline part (2026-10-16).** No Gemini, Anthropic or Tavily calls.
  - **`generate-draft` verified on the real Trigger.dev dev engine** against `omenai_fixtures`, with the AI and search keys empty and the scripted writer behind a guard (fixtures database and a non-production environment, ADR-031).
    - Registration, a first-attempt success, an engine retry after a scripted outage, idempotent duplicate triggers, and a replay that wrote nothing new.
    - A mocked-attempt harness for the task definition covers persistence, progress, retries, giving up, permanent errors and version safety.
  - **Failure review:** malformed payloads and 4xx application errors no longer retry (`isPermanentError`). 409 conflicts still do.
  - **X counting:** now follows X's published rules (emoji 2, links 23, weight-2 scripts, NFC). Where a link may or may not be recognised, the count is a range, and a post counts as within the limit only if the top of the range fits. Instagram and LinkedIn are counted conservatively (ADR-032).
  - **Evidence wording:** checks are described as source checks, not fact-checks. The studio says unlisted statements aren't checked, and there are no ticks or "verified" for a quote match.
  - **End-to-end workflow test** on fixtures: discover → shortlist → save → research → ask → draft → edit → revise (`workflow.e2e.test.ts`).
  - **Bounded live draft check prepared** (`drafts/drafts.live.test.ts`): Gemini only unless explicitly approved otherwise, with a budget guard of 6 calls. Its dry mode passes.
  - **Provider switch and deployment runbook:** `docs/DEPLOYMENT.md`.

- **Live development (2026-10-16).** Local development now uses real services (ADR-033, ADR-034, LIVE_DEVELOPMENT.md).
  - **Runtime and safety:**
    - `OMENAI_RUNTIME` is required: `live-dev`, `fixtures`, `production`, or `test` for Vitest.
    - The database name must agree with it. Mocked paths require the fixtures runtime.
    - Trigger.dev keys are checked by environment, and the worker refuses tasks from another database.
    - Live development uses Gemini only, with hard 24-hour limits (60 AI calls, 20 search credits).
    - `pnpm env:check` compares both env files without printing secrets.
  - **Configuration:**
    - Both env files now say `live-dev` and `omenai_live_dev`. Previously the web app used `omenai_fixtures` and the worker `omenai`.
    - Discovery is bounded (3 searches of 5, 12 pages, 5 assessments, 1 escalation, no revisits).
    - Primary and escalation run on `gemini-3.5-flash-lite`, the owner's choice after 3.8 Flash was overloaded.
    - `omenai_live_dev` was created with its indexes.
  - **Bounded live run:** discovery (two runs failed on Gemini 503s; the third completed with 4 real stories), research, one question, a briefing item, an X post and an edit, all through the real routes, browser and Trigger.dev dev worker. Usage: 21 Gemini requests (about $0.10 at paid list prices) and 14 Tavily credits.
  - **Fixed from what the run showed** (VERIFICATION.md, L1–L20):
    - Gemini calls retry themselves on overload.
    - A run waiting to retry reads as retrying and can't be doubled.
    - A failed run's articles are adopted by the next run.
    - Quote matching ignores Markdown.
    - Silent stops become visible.
    - Resolved failures stop counting.
    - Costs are never assumed free.
    - The schedule wording follows the runtime.
  - **Accounts in `omenai_live_dev`:**
    - `live-dev-runner@omenai.invalid`: owner, labelled "Live-dev test runner (automation)". Its password was discarded; deactivate it from Team when you like.
    - An owner invitation for the product owner (expires 2026-10-23); the link was handed over separately.

- **Chat latency, scope, streaming and accuracy (2026-10-16).** ADR-035, ADR-036; evidence and measurements in VERIFICATION.md.
  - **Diagnosed from the records:** chat took 53–237 s. Trigger.dev queueing and start-up took about 5–6.5 s of that. The rest was two model calls in a row with no limit on either: a separate scope check (26–219 s), then the answer at medium thinking. Nothing streamed. That scope check refused the contemporary-art question. The padded appointment-date "answer" was a full brief written for the follow-up lead.
  - **Changed:**
    - Chat streams from the web app as one bounded call, with scope decided inside it; only truly unrelated questions get the server-written redirect.
    - Answers are checked statements, each with its own quote.
    - Prompts forbid substituting a related fact.
    - Focused follow-ups answer their question.
    - A date-and-figure safeguard is added, explicitly not a support check.
    - Every model call has a hard deadline, and records its attempts (L14 fixed).
    - Stop, reload and disconnect behave as designed.
    - The worker reuses warm processes (takes effect after a restart).
  - **Live (approved, 14 Gemini calls, no Tavily):**
    - a baseline that reproduced the refusal
    - 8 of 8 evaluation cases (the appointment question answered honestly, the 1996 career date kept separate)
    - an end-to-end run in the real app: first text 8.2 s; one turn with a 503 retry took 18.2 s
  - **Not met:** first generated text within 2 s. Gemini's time to first chunk alone measured 3.3–8.7 s.
  - **Configuration:** `apps/web/.env.local` gained the chat model settings, copied from the worker's (`pnpm env:check` consistent). The test automation account `live-dev-e2e@omenai.invalid` is deactivated.
- **Progress, steadier streaming, wording and draft speed (2026-10-17).** ADR-037; evidence and measurements in VERIFICATION.md. No Gemini, Anthropic or Tavily calls.
  - **Diagnosed:**
    - **Chat:** after a 3–9 s wait, answers arrived in 1–7 bursts within half a second, and the page printed each burst as it landed.
    - **Progress:** partly fixed text. Research ticked a reading step that hadn't happened, and a refresh lost the steps.
    - **Drafts:** the last two took 38–51 s. 24–29 s of that passed before the task did anything: local DNS and Atlas connection set-up, plus the dev supervisor's fixed 30 s idle limit. Then 4–5 s of database work and 9–18 s of model time at medium thinking.
  - **Changed:**
    - Streamed text is revealed word by word at a steady pace, never more than 1.2 s behind what has arrived. With reduced motion it appears as it arrives.
    - Research, chat and drafts record the steps they actually take, with counts. The interface shows only those (done, under way, skipped, still to come), tells waiting, starting and retrying apart, and says honestly when a step runs long. A reload continues from the record.
    - Drafts stream into the Studio as a preview marked "not yet checked or saved", while the task stays on Trigger.dev.
    - The draft task's database work fell from 1,490 ms to 963 ms (measured).
    - Wording for steps, failures and evidence is plain and consistent.
  - **Measured live afterwards (10 calls):** medium against low thinking for drafts, two samples of each format. Medium stays. Low reached first words in about 1 s instead of 6–14 s, but its articles were a third to a half the length; for LinkedIn posts the two were similar, so switching posts to low is offered to the product owner. A draft quote may now run to 600 characters (two live drafts needed a repair round only because a quote passed 300).
  - **Pending:** a draft through the real worker with the preview, and chat with real model bursts. Not yet approved.
  - **Deferred:** multiple images per story (IMPLEMENTATION_PLAN.md, post-MVP list).
- **Answer from the saved research first; research a genuine gap on its own (2026-10-17 and 18).** ADR-038; evidence in VERIFICATION.md.
  - One chat call judges what the saved research means for the question (`assessment`: sufficient, needs research, out of scope). No separate classification call.
  - Deterministic rules around that judgement (`planFollowUp`): no repeat of research on the same question within 7 days, daily limits, a busy story. When they allow it, the reply records focused research keyed by the reply, and the route hands it to Trigger.dev after the stream. Its findings appear inside the same reply.
  - Saved research is read reliably: the latest full briefs and follow-ups, cited sources first, each point marked with how it was checked, and long sources shown as the passages that bear on the question.
  - Failures stay failures: a usage limit stops research; a follow-up whose every search failed fails.
  - **Measured:** no cost on the fast path (fixtures); about 0.48 s more when research starts. **Live:** 6 Gemini calls and 3 Tavily credits for the follow-up check, and 12 Gemini calls for the chat evaluation re-run and re-checks.
- **Evidence accuracy across domains and surfaces (2026-10-18).** ADR-039; evidence, coverage and limits in VERIFICATION.md.
  - **Statement checks, on every surface** (briefs, focused research, chat, drafts): every date, figure and quoted word in the quote (numbers matched whole); a quote about its statement (`excerpt_unrelated`); sources that disagree (`conflicting`).
  - **A check on "sufficient"** (chat and focused research): lowered, with a recorded reason, when nothing checked answers the date, figure or name asked for, when nothing is checked, or when sources disagree. In chat a lowered factual answer starts research through ADR-038's rules.
  - **One shared vocabulary** (`research/terms.ts`), topic-agnostic. Prompts: a gap is its own open question; substitution examples across domains; drafts state neither version of an unsettled detail. Streamed text is labelled "not yet checked".
  - **Verified:** 94 unit cases across 12 domains and 40 cross-surface cases, each with passing and failing cases; 9 mutation tests all caught; replay over all stored live output (no change to the 56 found statements; both false "sufficient" answers lowered, the 6 correct ones kept); a 2-call live re-check (cases 2 and 5 now behave).
  - **Not guaranteed:** the checks are lexical and only lower confidence; passing them proves nothing about truth.

- **Full newsroom redesign (2026-10-19 and 20).** ADR-040; checks and evidence in VERIFICATION.md. No model, search or production calls; fixtures only.
  - **Design system:** white canvas, ink type, one signal yellow for the primary action and current step, colour only for done, warning and failure; neutral outline tags (no coloured tag backgrounds); Archivo masthead type, Newsreader headlines, Geist interface; pill controls; ink focus ring. The ochre accent and Instrument Serif are gone. Tokens keep their names, so every page inherits them.
  - **Screens:** Newsroom (What's new above a full-width lead, a drawn black cover when there's no usable image, subject index, every story at a glance, varied secondary layouts), Story Review (scorecard, rail, numbered parts, sticky Next step), Research (collapsible Sources & checks sidebar; the conversation widens when it closes), Studio (format rail, writing sheet with a neutral check chip, history and checks), Operations (at-a-glance strip; Needs attention, Retrying on its own, Running now), Team (invite beside people and invitations, full width), the reading list, sign-in and a styled 404.
  - **Data (read-only, approved):** the lead's research and draft state on the edition page; `running` in `getOperationsOverview` (bounded to 20, never failed, retrying, stopped or stale work) with a test.
  - **Behaviour unchanged:** routes, APIs, schemas, scoring, discovery, research, chat streaming, Stop, drafts, versions, checks, permissions. Save and skip on cards became round icon toggles with the same calls and confirmation.
  - **Test fix:** `ops.test.ts` "reports the latest run…" had pinned its newest run to 06:00 UTC on 19 October while the seed's runs take the wall clock; it failed from that moment. The run is now stamped after the seed's.

- **Design consistency corrections (2026-10-20).** Product-owner review of ADR-040. Evidence is in VERIFICATION.md. Fixtures only.
  - **Newsroom:**
    - "What's New" for every edition; it was a date or "Extra edition…" on older ones.
    - A labelled "Select edition" control showing the edition's day and time.
    - No "We reviewed…" line, and no score, draft or source counts in the hero or on cards.
    - Notices are compact.
    - Order: lead, More from this edition, subject index and list, Also reviewed last.
    - Sections come from `planEdition` (0, 1, 2–5 and 6+ stories) and nothing depends on which edition is shown.
  - **Studio:** a white canvas, a wider editor, a 26.5rem panel, and disclosures below 1280px.
  - **Research:** the sidebar is white.
  - **Story Review:** the scorecard is smaller and no longer repeats the suggestion.
  - **Shared:**
    - Short, non-wrapping tags; one-word subject names on phones.
    - A compact footer on every page. The large "Stories shaping culture" signature was removed from the Newsroom at the product owner's request (2026-10-20).
    - A quieter environment strip.
  - **Tests:** 9 new unit tests for the layout plan, the words-only status, the edition wording and the short outcome tags.

- **Studio sidebar (2026-10-20).** The format rail grew from 6.5rem to 16rem (17rem at 1536px and up).
  - **Each format shows:** its full name, length target, versions and latest date, and the check state of the latest text (neutral dots; an edited version never reads as checked). It also shows a draft being written and a request that didn't finish.
  - **Also in the sidebar:**
    - An unsaved-changes legend.
    - A "Working from" block: research briefings, the sources the drafts cite, and the points still to confirm, with a link to the research.
  - **Data:** all from the drafts view the page already loads; no new data.
  - **Layout:** the checks and history panel sits beside the editor from 1400px. Below that it folds into the disclosures under the editor, so the sheet keeps 700px or more.
  - **Fix:** that breakpoint is written in rem (`min-[87.5rem]`). A px value is ordered before Tailwind's rem breakpoints, so `lg:` overrode it.
  - **Tests:** `formatStatus` and `limitText`, 7 tests.

- **Studio scrolling and the edition list (2026-10-20).**
  - **Studio:** from 1024px the page fills the window and each column scrolls on its own: the formats, the draft and the checks panel. Scrolling inside the checks panel never moves the draft or the page (`overscroll-contain`). Phones keep one page that scrolls as a whole.
  - **Edition selector:** the native menu is replaced by a styled Radix select. Each edition shows two short lines: its day (the year only for an edition from another year than the latest), then its stories and when it was ready or started. There's a "Latest" tag, a "By hand" tag, a check on the one showing, and a "Recent editions" heading. An older edition opened from a link is listed under "Earlier".
  - **The control** uses the same words as the list. While the chosen edition loads, it shows a spinner.
  - **Choosing the latest edition** opens `/` rather than `/?run=…`. Only `/` reports a newer edition in preparation, and before this, choosing the latest from the menu hid that notice.
  - **Data and tests:** everything comes from the run summaries the page already loads. `editionChoices` replaces `editionLabel`, with 3 new tests: wording, the year rule, and no invented day or time.

- **Secondary story layout (2026-10-20).** Product-owner report: in a three-story live edition, story 03's image filled the screen and was cut off from its headline.
  - **Cause:** the layout plan put stories three to five in a flex row of columns that grow to fill the row, each image in a fixed 4:5 or 3:2 frame. A column alone in its row took the page's width, and its frame grew with it: 1520×1900 px at 1920 wide. That happened in a three-story edition, and when a column wrapped onto its own line at 640–1180 px wide.
  - **Fix, in the plan (`planEdition`):** columns are used only when three stories fill the row. Otherwise stories two to four are wide bands that alternate the image's side: left, right, left.
  - **Fix, in the components:**
    - The band (`FeatureStory`) gains `side`.
    - The columns row never wraps; below 1024 px it becomes numbered rows with a small image.
    - An image that fails to load in a band now switches to the drawn panel, and the credit says so. Before, the credit could still name the failed image.
    - Bands show "Time-sensitive" as columns do.
  - **Unchanged:** ranking, numbering, actions, data and the crop rules. Image records carry no size or focal point, so crops stay centred.
  - **Tests:** the plan tests cover rank order for every edition from 2 to 9 stories, the alternating sides, and that no column is ever left alone.
  - **Known, not changed:** at 768–1023 px the ranked rows (story 06 on) squeeze the headline into a column of about 170 px. This was the same before the change.

## In progress

- Nothing mid-edit. Lint, typecheck, tests and build pass 16/16 after the secondary story layout fix (2026-10-20). The format check flags only `apps/worker/.mcp.json`, a committed file this work didn't touch (see Next action). Changes are uncommitted, awaiting the product owner's review.

## Blockers / external setup needed

1. ~~`TAVILY_API_KEY`~~: provided 2026-10-15 and verified live (search 1 credit, extract 2/2).
2. **Before production (not blocking development):**
   - `ANTHROPIC_API_KEY`, then `LLM_PROVIDER=anthropic`, the live LLM test and the full regression suite.
   - An app-only Atlas user (`readWrite@omenai`) to replace the `atlasAdmin` user, with a rotated password.
   - Atlas Network Access settled for Vercel and Trigger.dev (ADR-018).
   - A paid Trigger.dev plan for the exact-midnight schedule and static IPs.
   - Production `BETTER_AUTH_SECRET`.
   - Rotate the Gemini key that was shared in chat.
3. **Optional:** `RESEND_API_KEY` and `EMAIL_FROM` for invitation and password-reset emails (Phase 3).

## Known issues

- Password reset works only once Resend is configured. Until then the forgot-password page says so, and there is no owner-side reset (re-inviting an existing email is refused). Resend is recommended before go-live.
- With streamed pages, `notFound()` (an unknown story; an editor opening Team) renders the 404 view with HTTP 200 because the status is already sent. Verified that nothing leaks; the APIs return proper 403/404. The view is now styled (ADR-040), but the browser tab still shows the page's static title (for example "Team"), as before.
- Gemini free tier: occasional 503s under load (retried by tasks), no Pro-class quota, and prompts may be human-reviewed. Don't send confidential material in dev.
- Atlas connection setup from this machine took about 16 s once (DNS/TLS). The worker ping was 148 ms once connected.
- The Trigger.dev CLI's `tsconfck` has a TypeScript ^5 peer warning (we use 6.0.3); no observed effect.
- pnpm lists "agent skills awaiting approval" from the Trigger.dev packages; left unapproved.
- Some extracted pages are mostly site navigation (e.g. a school's marketing page). The model rejects them correctly, but a cheap deterministic "low-quality extraction" check could skip the evaluation call (post-MVP candidate).
- `gemini-3.8-flash` returns 503 ("high demand") fairly often on the free tier. Trigger.dev retries absorb this in production runs.
- Story images are hotlinked from publishers. Some sites block hotlinking or are slow; the card then shows the typographic fallback. Rights are never cleared by the newsroom: the credit says so, and nothing is republished.
- Fixture images come from picsum.photos (fixture seed only), so local UI work needs network access to show them.
- In the `full` scenario, the retrying assessment shows as "Retrying automatically" for 45 minutes after seeding, then as "stopped retrying", because nothing is actually retrying it in fixtures. Both states are real behaviour; reseed to see the first again.
- The `full` scenario keeps today's edition "in progress" with a 30-day lease, so "Find today's stories" is refused in that scenario (a run is active). Reseed with `empty` to try a manual start.

## Live smoke run findings (2026-10-15)

- **Worked on the real APIs:** Tavily search and extract, Gemini triage, clustering and (after the fix) evaluation.
- **Fixed:**
  - Gemini rejected the large evaluation schema (adapter schema budget, ADR-016).
  - Over-cap candidates were described as "late" (wording).
  - Late evaluations were never carried over (now reclassified in the next run without a model call).
  - The model treated routine rights checks and our own excerpt truncation as critical issues (prompt calibration plus a truncation marker).
- **Observed cost per run at default limits** (an estimate extrapolated from real token counts):
  - Gemini: about 140k input, 55k output and 20k reasoning tokens per run (25 evaluations, about 8 triage batches, 1 clustering call).
  - Tavily: about 22 credits per run, roughly 660 per month.
  - Evaluation latency: 17–70 s per story on `gemini-3.8-flash`.
- **Data:** the smoke stories (10, including 3 evaluated) and their runs are in the Atlas dev database. They are useful real data for Phase 3.

## Not yet verified (needs approval: it spends API budget)

- **The live effect of the critical-issue calibration.** 1–3 evaluations would show it.
- **A full-size run through the Trigger.dev orchestrator** (fan-out, polling, deadlines).
- **The production schedule firing at midnight Chicago.** Needs a production deploy.
- **Tavily `includeImages` in a real extract:** whether real pages return usable preview images first, and whether it changes credit use. Proposed check: one extract of at most 5 URLs (at most 1 credit), only with approval. It could also be observed in the next approved live run.

## Not yet verified for Phase 4 (needs approval: it spends API budget)

- **A real research task end to end:** `trigger dev` running, Gemini writing a brief from real sources, and about 2–3 Tavily credits. It would show whether the model follows the citation rules (exact quotes, labels only) and how many quotes we can locate.
- That the research and chat tasks run on the Trigger.dev engine. They registered with the dev environment on 2026-10-16 (worker 20261016.1), but only `generate-draft` has been run there.
- That research survives closing the tab. This is true by design (background task, polled page) but not yet checked by hand.
- Whether a real model keeps to the concise format: the 150–250 word target, natural wording instead of labels, and short chat answers. Scripted answers show only that the format renders and keeps its caveats.

## Not yet verified for Phase 5 and 6 (needs approval: it spends API budget or touches production)

- ~~**A real model writing drafts.**~~ Done in live development (2026-10-16) and measured at two reasoning levels (2026-10-17). The original prepared check, kept for reference: one Weekly Briefing item and one X post on Gemini.
  - **Calls:** 2 expected, at most 6 (each draft may need one repair round, and the X post one shortening request and its repair). A guard refuses a seventh.
  - **Tokens:** about 2,300–2,600 input per call (prompts of about 8,850 characters), plus output and thinking tokens.
  - **Cost:** nothing on the free tier.
  - **Content:** invented fixture text only; nothing goes to Tavily or Atlas.
- **The Anthropic switch:** needs `ANTHROPIC_API_KEY`, a budget and approval (DEPLOYMENT.md, section 3).
- **Production deploy:** needs the owner-side setup and approval (DEPLOYMENT.md).

## Next action

1. **Review the redesign** (ADR-040) in the browser, against the approved canvas. Known gaps, by decision or for want of data: no Story Review previous/next, no "saved by" on edition cards, no Operations search or filters, the citation popover doesn't drive the sidebar's evidence card, and Studio on phones keeps disclosures instead of a bottom toolbar.
2. **Product owner decisions:**
   - Switch LinkedIn drafts to low reasoning? (Samples and timings in VERIFICATION.md.)
   - Approve, or not, the end-to-end checks (at most 3 calls): one LinkedIn draft through the real Trigger.dev worker, watched in the Studio preview, and one chat question with the real model's bursts. This reactivates the labelled automation editor and adds one draft version to `omenai_live_dev`.
   - Further live evaluation of the evidence checks on other stories (the approved chat-evaluation budget is used up). Proposed: the eight chat cases on two more stories in other domains, at most 24 Gemini calls, no Tavily.
3. **Still pending from 2026-10-16:**
   - Decide on `apps/worker/.mcp.json`: run Prettier on it, or add it to `.prettierignore`.
   - The editorial review of the live shortlist (L18).
4. **Running processes:** a `next dev` on port 3000 was already running during this work and was left alone. Start `trigger dev` before live work (LIVE_DEVELOPMENT.md).

## Schedule (target Nov 1)

| Phase                  | Target |
| ---------------------- | ------ |
| 4 Research             | Oct 22 |
| 5 Studio               | Oct 24 |
| 6 Hardening and deploy | Oct 28 |

**External setup is needed from the product owner by about Oct 26:** Vercel Pro, a paid Trigger.dev plan, `ANTHROPIC_API_KEY` (provider switch), an app-only Atlas user with a rotated password, and Resend (`RESEND_API_KEY`, `EMAIL_FROM`). Without Resend, a user who forgets their password can't reset it, and re-inviting an existing email is refused.
