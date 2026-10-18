# Live development

_Set up 2026-10-16. ADR-033 records the design and ADR-034 the fixes found by the first live run._

Local development now runs against real services by default:

- MongoDB Atlas, in a dedicated development database: `omenai_live_dev`
- Gemini for every model call
- Tavily for discovery and research
- the Trigger.dev **development** worker for background work

Automated tests still use an in-memory database with scripted answers and a fake search. The fixtures runtime is still there for UI work without spend.

## The runtime is stated, never guessed

Every process states its runtime with `OMENAI_RUNTIME`. If it's missing or contradicts the database, the process stops with a `ConfigError` naming the variable. A missing `MONGODB_DB_NAME` is never assumed to mean any database.

| `OMENAI_RUNTIME` | Database name must                        | Models and search                                               | Background work                                         |
| ---------------- | ----------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------- |
| `live-dev`       | end in `_dev` (`omenai_live_dev`)         | real Gemini (no other provider) and Tavily, within daily limits | Trigger.dev **development** environment (`tr_dev_` key) |
| `fixtures`       | end in `_fixtures`                        | scripted; nothing leaves the machine                            | in-process in the web app; never Trigger.dev            |
| `production`     | not end in `_dev`, `_fixtures` or `_test` | configured provider                                             | Trigger.dev **production** (`tr_prod_` key)             |
| `test`           | anything (in-memory)                      | mocked in each test                                             | none; accepted only under Vitest                        |

These checks enforce it:

- **Mocked paths need the fixtures runtime.** Every mocked path (scripted model, fake search, in-process execution, simulated email) requires `OMENAI_RUNTIME=fixtures` _and_ a `*_fixtures` database. In any other runtime the code takes the real path, and a contradictory setting is an error, not a fallback.
- **The worker checks every task.** Each task the web app sends names its database, and the worker aborts, before touching anything, if its own database or Trigger.dev environment doesn't match.
- **Fixture accounts stay in fixtures.** `@fixtures.example` accounts can't be invited outside the fixtures runtime, and `pnpm db:seed-fixtures` refuses to run anywhere else.
- **No unattended runs.** The nightly discovery schedule exists only in the production environment, so development never searches on its own. Operations and the Newsroom say so.

## Running it

1. Check the configuration. This prints no secrets, only names, whether each key is set, and the Trigger.dev key's environment.
   ```bash
   pnpm env:check                                              # both env files agree, no network
   pnpm --filter @repo/core env:check -- --connect --tavily    # + database ping, 24 h usage, Tavily plan
   ```
2. If the database is new, create its indexes. This only touches `omenai_live_dev`.
   ```bash
   pnpm db:indexes
   ```
3. Start the background worker in its own terminal. It reads `apps/worker/.env`. Restart it after changing `trigger.config.ts`: settings such as `processKeepAlive` are read only at start.
   ```bash
   pnpm --filter @repo/worker dev:trigger
   ```
4. Start the web app. It reads `apps/web/.env.local`, which also needs the chat settings: `LLM_PROVIDER`, `GEMINI_API_KEY`, the Gemini model overrides and both daily limits, identical to the worker's (chat replies stream from the web app, ADR-035). `pnpm env:check` compares them. The Tavily key never goes in the web env.
   ```bash
   pnpm dev
   ```
5. Sign in. The first owner in `omenai_live_dev` is the automation account used for the live test (`live-dev-runner@omenai.invalid`, labelled "Live-dev test runner"). Your own owner invitation is described in PROGRESS.md; open it and choose a password. Deactivate the runner account from Team whenever you like.

The header shows **"Live development (omenai_live_dev)"** on every page.

### Why background work can take 20–30 s to start here

Measured on 2026-10-17 for research and drafts on this machine. None of it is the model, and none of it is Trigger.dev's queue: runs were picked up within 0.05–0.8 s.

| Stage                                              | Measured                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| The web app hands the task to Trigger.dev          | 5.8–6.4 s. A new process making one Trigger.dev API call took 6.0 s; a second new process took 0.9 s.        |
| The run starts a process and first reaches MongoDB | 18–23.5 s. A cold Atlas connection took 17.1 s once and 1.5 s when warm, plus about 2 s for the first query. |
| Database work inside the task                      | About 1 s per draft since 2026-10-17. It was 1.5 s, and 4–5 s on a slow day.                                 |

The cold lookups are local DNS and connection set-up. When they stall, they stall for about 5 s at a time.

The dev worker reuses a warm process (`processKeepAlive`), but Trigger.dev 4.7.4's development supervisor ends an idle one after a fixed 30 s. So work started more than 30 s after the previous run always starts cold. That limit is built into the CLI (`TaskRunProcessPool.IDLE_TIMEOUT_MS`) and isn't configurable.

The progress display says plainly when work is still waiting to start. Production start-up hasn't been measured; it needs a deployment.

## Daily limits (hard caps)

They're set in `apps/worker/.env` and, for chat, identically in `apps/web/.env.local`; both are required in live development. Each is checked before **every** real request, counting the last 24 hours of real usage from our own records (simulated usage never counts), so the web app and the worker share the same budget. A request that would go over is refused with a clear message and not retried. Concurrent work can overshoot by at most the number of calls in flight (assessments run three at a time).

| Variable                                                   | Live-dev value          | Meaning                                                         |
| ---------------------------------------------------------- | ----------------------- | --------------------------------------------------------------- |
| `AI_DAILY_CALL_LIMIT`                                      | 60                      | Model requests (successful or not) in 24 hours                  |
| `SEARCH_DAILY_CREDIT_LIMIT`                                | 20                      | Tavily credits in 24 hours: 1 per search, 1 per 5 pages read    |
| `DISCOVERY_MAX_QUERIES` / `DISCOVERY_RESULTS_PER_QUERY`    | 3 / 5                   | Searches per discovery run                                      |
| `DISCOVERY_MAX_EXTRACT`                                    | 12                      | Pages read per run (at most 3 credits)                          |
| `DISCOVERY_MAX_REVISITS`                                   | 0                       | No re-reading of earlier articles                               |
| `DISCOVERY_MAX_EVALUATIONS` / `AI_MAX_ESCALATIONS_PER_RUN` | 5 / 1                   | Assessments per run (the rest carry over)                       |
| `GEMINI_MODEL_PRIMARY` / `GEMINI_MODEL_ESCALATION`         | `gemini-3.5-flash-lite` | Set 2026-10-16, because `gemini-3.8-flash` was overloaded (503) |

What things cost in practice, from the first live run (2026-10-16):

- **One bounded discovery run:** 3 searches, plus at most 3 extraction credits, and about 8–18 Gemini calls.
- **Research:** 2 searches, 1 extraction and 1–2 calls (a second call is a repair round; its reason is now recorded).
- **A question:** 1 call, streamed from the web app (2 before 2026-10-16: a separate scope check, then the answer). No search.
- **A follow-up lead:** up to 2 searches, 1 extraction and 1 call, for a short answer to its question.
- **A draft:** 1–2 calls.
- **Gemini:** list prices are on the paid tier. The app can't see whether the key is on the free tier, so Operations estimates at the paid price. The first full live journey cost about $0.10 at those prices.
- **Tavily:** the account is on the free Researcher plan (1,000 credits a month). Usage this cycle: `env:check --tavily`.

Note that opening a story's research page for the first time starts its briefing automatically. That's real spend. It happens once per story and is refused if a briefing exists or one is already running.

## Fixtures and tests

```bash
pnpm check                                          # offline: in-memory database, scripted model and search
OMENAI_RUNTIME=fixtures MONGODB_DB_NAME=omenai_fixtures pnpm db:seed-fixtures   # seed the demo newsroom
OMENAI_RUNTIME=fixtures MONGODB_DB_NAME=omenai_fixtures pnpm dev                # run it: no network spend
```

Command-line variables take precedence over the env files, so the fixtures runtime never needs the files edited.

## When a provider fails

Every model call is bounded (ADR-036): one attempt may take 25 s in chat and 180 s in background work, and the whole call, retries included, at most the chat deadline (60 s from the question) or 240 s. Each call's usage record shows its wall time, time to first text, HTTP attempts and the status of each failed one.

**In chat:**

- A rejected request (overloaded, rate limited) is retried once inside the call; the page shows "The AI service is busy. Trying again…". After that, or at the deadline, the reply fails visibly with "Ask again"; the question is saved and nothing partial is.
- **Stop** ends a reply at once (or within about a second if another server instance runs it), saves nothing of it, and shows "You stopped the last reply."
- Closing the tab or reloading doesn't stop a reply: it is saved, and a reloaded page shows "Writing a reply…" until it is.
- A reply that stops without a word (the server went away) reads as stopped after 2 minutes, and the next question takes over its lock.

**In background work** (behaviours observed live and fixed, ADR-034):

- **Overload (503) or rate limit (429) from Gemini.** Each call retries itself a few times, over about 15 seconds. If the call still fails, the background task retries.
  - **During those retries** a discovery run reads "retrying automatically" in Operations, not "failed". A second manual search is refused while it's due.
  - **When attempts run out**, the run fails with "The AI service was overloaded…". The **next search takes on everything the failed one had found, read and triaged**, so nothing paid for is lost. Once a later run completes, the failed one no longer counts as needing attention.
- **Model overloaded for a long time.** Switch tiers with `GEMINI_MODEL_<TIER>` in `apps/worker/.env`, then restart the worker. Don't switch providers.
- **Usage limit reached.** Work stops with "The daily usage limit for live development was reached". It frees up as older usage ages out of the 24-hour window, or after raising the limit deliberately.
- **Work that stops silently** (a timeout or a lost worker). After 45 minutes it reads as stopped, with "Try again", instead of "Researching…" forever, and Operations lists it.

## Keeping production separate

- **Different database.** Production uses its own (planned: an app-only user on a database not ending in `_dev`). Live development can't connect to it, because the runtime rule refuses any database name that doesn't end in `_dev`.
- **Different Trigger.dev keys and environments.** The web app refuses a non-`tr_dev_` key in live development, and the worker refuses to run outside the DEVELOPMENT environment.
- **No Anthropic in live development.** `LLM_PROVIDER` other than `gemini` is refused there; the switch is a separate milestone (DEPLOYMENT.md).
