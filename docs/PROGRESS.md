# Progress

_Last updated: 2026-10-15_

## Status by phase

| Phase                      | Status                                                                     |
| -------------------------- | -------------------------------------------------------------------------- |
| 0 — Audit, plan, records   | ✅ Done                                                                    |
| 1 — Foundation             | ✅ Done (revised 2026-10-15: email + password auth, LLM layer, Atlas live) |
| 2 — Data model & discovery | ⏳ Next                                                                    |
| 3 — Dashboard              | ⏳ Not started                                                             |
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

## Next action

Phase 2, step 1: encode the playbook taxonomy in `packages/shared/src/editorial/`:

- pillars, subcategories, cross-cutting tags, geography tiers
- exclusions, scoring dimensions and weights, thresholds

Then the pure scoring and gates functions, with tests.
