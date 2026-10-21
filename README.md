# Omenai Newsroom

The Omenai AI newsroom ("Stories Shaping Culture"): daily discovery of global contemporary-culture
stories, scored against the CEO's editorial playbook, with a research assistant and a content
studio for invited editors. Nothing is published automatically.

A TypeScript monorepo managed with [pnpm workspaces](https://pnpm.io/workspaces) and
[Turborepo](https://turborepo.com). Project records (conventions, plan, decisions, progress and
verification) are kept locally in `CLAUDE.md` and `docs/`, outside the repository: this README is
the only Markdown file it tracks.

```text
apps/
  web/        Next.js 16 (App Router, React 19, Tailwind v4, shadcn/ui), Better Auth  :3000
              (email + password, invite-only)
              UI, route handlers under src/app/api, auth at /api/auth/[...all]
  worker/     Trigger.dev v4 background tasks (discovery, research, generation)
packages/
  core/       @repo/core: MongoDB (Mongoose + shared MongoClient), auth rules, provider-agnostic
              LLM layer (Gemini + Anthropic adapters), Tavily, services (Node-only)
  shared/     @repo/shared: taxonomy, roles, Zod schemas, scoring (browser-safe)
  config/     @repo/config: TypeScript presets and ESLint configs
```

## Prerequisites

- **Node.js 24** (`nvm use` picks it up from `.nvmrc`)
- **pnpm 12.11.2**, provided by Corepack: run `corepack enable` once. The version is pinned by the
  `packageManager` field in `package.json`, so everyone uses the same pnpm.

## Getting started

```bash
corepack enable
pnpm install
cp apps/web/.env.example apps/web/.env.local     # then fill in the values
cp apps/worker/.env.example apps/worker/.env     # same database name and runtime as the web app
pnpm env:check                                   # both sides agree; prints no secrets
pnpm db:indexes                                  # create MongoDB indexes
pnpm owner:invite you@example.com                # first owner: prints a one-time invitation link
pnpm --filter @repo/worker dev:trigger           # background worker (separate terminal)
pnpm dev
```

Local development runs against real services by default: `OMENAI_RUNTIME=live-dev`, the Atlas `omenai_live_dev` database, Gemini, Tavily and the Trigger.dev development worker, within hard daily usage limits. The details are in the local `docs/LIVE_DEVELOPMENT.md` (not in the repository).

Open the printed invitation link and set a password. Later users are invited by an owner from the
app. `pnpm owner:invite` refuses to run once an active owner exists, and
there is no HTTP route for creating owners. `GET /api/health` reports service status.

## Environment variables

`apps/web/.env.example` and `apps/worker/.env.example` document every variable. Real `.env`
files are gitignored, so never commit secrets. A missing required variable raises a
`ConfigError` that names it. The app still builds without secrets.

`OMENAI_RUNTIME` (`live-dev`, `fixtures` or `production`) and `MONGODB_DB_NAME` are required in
both files and must agree with each other: neither is ever assumed. `pnpm env:check` verifies it.

- Variables without the `NEXT_PUBLIC_` prefix are only available on the server (route handlers and
  server components).
- `NEXT_PUBLIC_*` variables are inlined into the browser bundle at build time, so never put secrets
  in them.
- Because the API is served by the same Next.js app as the UI, browser requests are same-origin
  and no CORS configuration is needed. Add explicit CORS headers to a route handler only if a
  different origin must call it.

## Commands

Run these from the repository root. Turborepo orders them by dependency (for example, it builds
`@repo/shared` before the app) and caches results.

| Command                             | Description                                                          |
| ----------------------------------- | -------------------------------------------------------------------- |
| `pnpm dev`                          | Run the web app and the shared-package watcher together              |
| `pnpm dev:web`                      | Same, limited to the web app and the packages it depends on          |
| `pnpm build`                        | Production builds (`apps/web/.next`, `packages/shared/dist`)         |
| `pnpm lint`                         | ESLint in every package                                              |
| `pnpm typecheck`                    | `tsc --noEmit` in every package                                      |
| `pnpm test`                         | Vitest suites (web app and shared package)                           |
| `pnpm format` / `pnpm format:check` | Format with Prettier / verify formatting                             |
| `pnpm check`                        | Everything CI should run: format check, lint, typecheck, test, build |
| `pnpm db:indexes`                   | Create or update MongoDB indexes (idempotent; run on deploy)         |
| `pnpm owner:invite <email>`         | Issue the first owner's invitation link (refuses if an owner exists) |
| `pnpm db:seed-fixtures`             | Fill a `*_fixtures` database with fixture runs for local UI work     |
| `pnpm env:check`                    | Check that web and worker configuration agree (no secrets printed)   |

### Working on the dashboard without API spend (fixtures)

```bash
OMENAI_RUNTIME=fixtures MONGODB_DB_NAME=omenai_fixtures pnpm db:seed-fixtures            # "full" scenario
OMENAI_RUNTIME=fixtures MONGODB_DB_NAME=omenai_fixtures pnpm db:seed-fixtures -- empty   # a brand-new newsroom
OMENAI_RUNTIME=fixtures MONGODB_DB_NAME=omenai_fixtures pnpm dev                          # sign in as owner@fixtures.example
```

Command-line variables override the env files, so this never needs them edited. The fixtures
runtime is the only one in which scripted answers, the fake search, in-process background work or
simulated email are used; the seed refuses anything else, so real data is never touched.
The command prints each seeded edition and the sign-in accounts (password `fixture-password-only`).
While in the fixtures runtime every page shows a "Development fixtures" banner, and fixture usage
is labelled simulated. To see the invitation "emailed" or "email failed" states without sending
mail, add `EMAIL_TRANSPORT=fixture-sent` or `fixture-failed` (refused in any other runtime).
Fixture content is invented (example.* domains) and must never be presented as reporting.
Fixture preview images are loaded from picsum.photos, so they need network access; without it the
cards show the typographic fallback.

The interface is a single light theme. Shared editorial components live in
`apps/web/src/components/editorial/`, and every editor-facing word for an internal state comes
from `copy.ts` there. Change wording in that file rather than in individual pages.

Background tasks run with the Trigger.dev CLI: `npx trigger.dev@latest login` once, then
`pnpm --filter @repo/worker dev:trigger` (reads `apps/worker/.env`).

The LLM provider is chosen by `LLM_PROVIDER` in the worker env: `gemini` for development and
`anthropic` for production. To check the configured provider against the real API (this spends
quota):

````bash
cd packages/core && LLM_LIVE_TESTS=1 node --env-file=../../apps/worker/.env node_modules/vitest/vitest.mjs run src/llm/live.test.ts
``` DB-backed tests use an in-memory MongoDB replica set; the first run
downloads a `mongod` binary into `~/.cache/mongodb-binaries`.

To target a single package, use a filter, for example `pnpm --filter @repo/web test`.

To run the production build locally:

```bash
pnpm build
pnpm --filter @repo/web start
````

## How it fits together

- **Backend endpoints.** Add a route handler per endpoint at `apps/web/src/app/api/<name>/route.ts`
  and keep logic in `src/lib` so tests can call it directly (see `api/health` and `lib/health.ts`).
  Handlers that depend on the request or the clock must call `await connection()` so
  `cacheComponents` does not prerender them.
- **Shared code.** `@repo/shared` compiles to `dist/` (ESM plus type declarations) and is imported
  as `@repo/shared`. Keep it free of Node.js and browser APIs: its tsconfig includes neither set
  of globals. `ApiErrorResponse` and `HealthResponse` define the API response shapes.
- **TypeScript.** `tsconfig.base.json` holds the strict compiler settings. Each package extends it
  together with a runtime preset from `@repo/config/typescript` (`library` or `nextjs`).
- **Linting and formatting.** ESLint flat configs with type-aware `typescript-eslint` rules come
  from `@repo/config/eslint`, and the web app adds `eslint-config-next`. Prettier formats
  everything and sorts Tailwind classes.

## Adding a workspace package

1. Create `packages/<name>/package.json` with `"name": "@repo/<name>"`, `"private": true`,
   `"type": "module"`, and an `exports` map pointing at its build output (copy
   `packages/shared/package.json` as a starting point).
2. Add a `tsconfig.json` that extends
   `["../../tsconfig.base.json", "@repo/config/typescript/library.json"]`, plus a
   `tsconfig.build.json` if the package emits code, and an `eslint.config.js` (copy the one in
   `packages/shared`).
3. Use the standard script names (`build`, `dev`, `lint`, `typecheck`, `test`) so Turborepo picks
   them up. Packages without a given script are skipped.
4. Add it to a consumer with `pnpm --filter @repo/web add @repo/<name>@workspace:*`, which also
   runs the install.

Versions used by several packages live in the `catalog` in `pnpm-workspace.yaml`; reference them
as `"catalog:"`.

## Notes

- pnpm blocks dependency install scripts unless they are listed under `allowBuilds` in
  `pnpm-workspace.yaml` (`pnpm approve-builds` adds entries). pnpm also refuses versions published
  very recently (its `minimumReleaseAge` policy), which protects against compromised releases.
- ESLint stays on v9 because the plugins used by `eslint-config-next` 16.4 do not support v10 yet.
  TypeScript stays on 6.0 because `typescript-eslint` supports versions below 6.1.
- `AGENTS.md` is maintained locally by Turborepo for AI coding agents and isn't tracked. Set
  `"agentGuidance": false` in `turbo.json` to opt out.
