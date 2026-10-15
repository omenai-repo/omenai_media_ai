# Progress

_Last updated: 2026-10-15_

## Status by phase

| Phase                      | Status                                                                     |
| -------------------------- | -------------------------------------------------------------------------- |
| 0 — Audit, plan, records   | ✅ Done                                                                    |
| 1 — Foundation             | ✅ Done (revised 2026-10-15: email + password auth, LLM layer, Atlas live) |
| 2 — Data model & discovery | ✅ Implemented and fixture-verified; a live run awaits approval            |
| 3 — Dashboard              | ⏳ Next                                                                    |
| 4 — Research assistant     | ⏳ Not started                                                             |
| 5 — Content studio         | ⏳ Not started                                                             |
| 6 — Hardening & handover   | ⏳ Not started                                                             |

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

## In progress

- Nothing mid-edit. `pnpm check` passes (16/16).

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

- Password reset is wired in Better Auth but has no email transport until Resend is configured. Owners can re-invite in the meantime.
- Gemini free tier: occasional 503s under load (retried by tasks), no Pro-class quota, and prompts may be human-reviewed. Don't send confidential material in dev.
- Atlas connection setup from this machine took about 16 s once (DNS/TLS). The worker ping was 148 ms once connected.
- The Trigger.dev CLI's `tsconfck` has a TypeScript ^5 peer warning (we use 6.0.3); no observed effect.
- pnpm lists "agent skills awaiting approval" from the Trigger.dev packages; left unapproved.
- Some extracted pages are mostly site navigation (e.g. a school's marketing page). The model rejects them correctly, but a cheap deterministic "low-quality extraction" check could skip the evaluation call (post-MVP candidate).
- `gemini-3.8-flash` returns 503 ("high demand") fairly often on the free tier. Trigger.dev retries absorb this in production runs.

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

## Next action

Phase 3: the dashboard. Design system first (shadcn themed), then:

- newsroom (latest run's shortlist plus shortfall notice), story detail (card, score breakdown, gates, sources, decisions)
- save/skip routes, a saved view
- operations (runs, funnel, shortfall reasons, per-candidate outcomes, failed tasks, usage, owner-only "Run discovery now")
- team (invitations and users)

A dev-only fixture seed can populate the UI without API spend.
