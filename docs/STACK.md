# Stack: water-management

A multi-project web app for daily catchment water-balance modelling. It is a
port of the WBT b023 Excel tool (see [model.md](./model.md)). There is a static
SvelteKit frontend, a Hono API (a Node server locally, Lambda in production),
Postgres with row-level security, and one TypeScript model engine that both
sides share.

## Stack

- **packages/engine**: `@water-management/engine`. Pure TypeScript model
  (`runModel`) and shared types (`src/project.ts`). No I/O. Tested with vitest.
  Imported as source by frontend and backend.
- **backend/**: Hono on Node (`tsx watch`, port `3001`) and AWS Lambda (Function
  URL, esbuild bundle). Uses `pg`, `zod`, `jose` (session JWT), `bcryptjs`,
  and for email `nodemailer` (SMTP → Mailpit locally) / `@aws-sdk/client-sesv2`
  (SES in production), picked by `MAIL_TRANSPORT`.
  Plain SQL migrations live in `backend/migrations/`, run by
  `backend/scripts/migrate.ts`. vitest has two projects: `unit` (no DB) and `db`
  (needs Postgres).
- **frontend/**: SvelteKit 5 **SPA** (`adapter-static` with a fallback
  `index.html`; `ssr = false`, `prerender = false`), Vite, TypeScript, uPlot
  charts, vitest. Dev port `7777`. `frontend/.env.production` sets
  `PUBLIC_API_URL=/api`.
- **e2e/**: Playwright, fully local. It uses an isolated
  `water_e2e` database and its own servers on `:3101` (API) and `:7801` (site),
  so it never collides with `pnpm dev`.
- **Mailpit**: docker-compose, catches all local email (SMTP **1026**, inbox
  http://localhost:8026, `pnpm dev:mail:up`).
- **Postgres 17**: docker-compose, port **5434**. User/DB `water` owns the
  schema and runs migrations. The backend connects as `water_app`, which is
  bound by RLS. The `water_test` database is for DB tests.
- **scripts/wbt-import/**: Python 3.14 + openpyxl. Extracts a b023 workbook into
  `data/…/project.json` and regression fixtures. Output is gitignored.
- **infra/**: Terraform: S3 + CloudFront (+ `/api/*` → Lambda) + WAF + Lambda +
  Route 53 + ACM + budget/alarms. The database is added in Phase 6
  ([plan.md](./plan.md)).

pnpm monorepo with three workspaces (`frontend`, `backend`, `packages/*`).
Node 24 (`.tool-versions`), pnpm 10 (`packageManager: pnpm@10.33.2`).

## Commands (run from repo root)

```bash
pnpm setup                  # install, start Postgres, apply migrations (one-time)
pnpm dev                    # frontend :7777 + backend :3001 (needs dev:db:up)
pnpm dev:run:frontend       # one side only
pnpm dev:run:backend

pnpm dev:db:up              # Postgres 17 in docker on :5434
pnpm dev:db:down
pnpm dev:db:status | dev:db:logs
pnpm dev:db:migrate         # apply backend/migrations as `water`
pnpm dev:db:reset           # drop the volume, recreate, migrate (destroys local data)
pnpm dev:db:psql            # psql as the schema owner
pnpm dev:mail:up            # Mailpit: local inbox for all app email (UI :8026, dev:mail:open)

pnpm build                  # all workspaces (frontend/build, backend/dist/lambda.mjs)
pnpm check                  # typecheck all workspaces
pnpm test                   # unit tests everywhere (no DB)
pnpm test:engine | test:frontend | test:backend
pnpm test:backend:db        # API + RLS tests, catalogue guards, route-auth inventory (water_test; needs dev:db:up)
pnpm test:e2e               # Playwright, 48 specs incl. the new-catchment golden path (also test:e2e:ui, check:e2e)

pnpm seed:examples          # 3 invented example catchments + team + 2 demo users (demo@ / analyst@example.com, password demo-password)
pnpm seed:demo              # seed:examples + the Client Catchment client workbook from Original/ (needs Python + openpyxl)
pnpm import:project <project.json> --email you@example.com [--name …]
pnpm test:scripts           # guard: root scripts point at real targets
```

## First-time setup

Local dev needs **no env setup**. `backend/.env.development` and
`frontend/.env.development` are committed and hold only non-sensitive local
defaults (localhost URLs, the throwaway docker DB passwords, a dev-only JWT
secret). Needs Node 24, pnpm 10, and docker (with compose).

```bash
pnpm setup
pnpm dev
```

The walkthrough, including how to import client catchment, is in
[run-locally.md](./run-locally.md). Personal overrides go in a gitignored
`<workspace>/.env.development.local`. Never edit the committed file for those.

Deploying (only when the client is ready for it) is covered in
[deployment.md](./deployment.md).

## Where to look

- `docs/model.md`: the water-balance model, formulas, workbook quirks, glossary
- `docs/data-model.md`: tables, workbook mapping, roles and RLS, series storage
- `docs/api.md`: HTTP contract
- `docs/run-comparison.md`: comparing two runs (matching rules, what the input diff sees)
- `docs/plan.md`: roadmap, acceptance criteria, questions for the client, risks
- `docs/architecture.md`: system diagram, workspaces, request/run lifecycle
- `docs/run-locally.md`, `docs/deployment.md`, `docs/security.md`
- `infra/README.md`: Terraform specifics

Prefer reading these over guessing. Update them when behaviour changes.

## Conventions and gotchas

- **This repo is public.** Never commit secrets (they live in the private
  `Absence0760/infra-secrets` repo under `water-management/`), client
  workbooks, or anything derived from them. Committed fixtures are synthetic,
  with no real farm names or values ([security.md § Public repo hygiene](./security.md#public-repo-hygiene)).
- **The engine stays pure.** No `fetch`, no DB, no Node or DOM APIs in
  `packages/engine`, because it has to run in the browser *and* in Lambda.
  Every engine change must keep the b023 regression tests green
  ([model.md §6](./model.md#6-porting-strategy-and-regression-testing)). A
  change in behaviour bumps `ENGINE_VERSION`.
- Tests that need client-derived fixtures (under `data/`) skip when the
  fixture is absent.
- **Every project-scoped query runs as `water_app` inside a transaction that
  sets `app.current_user_id`.** Never connect the running backend as `water`,
  and never add `BYPASSRLS`. A new project table needs RLS policies,
  same-project triggers and grants (use `/safe-migration`).
- **Migrations move forward once deployed.** Add `NNN_name.sql`. `001` may
  still be edited until the first production deploy. Prefer expand/contract
  ([data-model.md § Migrations](./data-model.md#migrations)).
- **Two backend entry points.** `server.ts` imports `dotenv/config`. `lambda.ts`
  must not reach any module that imports dotenv, so that esbuild tree-shakes it
  out.
- **Static SPA frontend only.** No SSR adapters. Routes render client-side from
  the fallback `index.html` (CloudFront maps 404s to it). `PUBLIC_API_URL` is
  `http://localhost:3001` in dev and `/api` in production (CloudFront proxy).
- **Svelte 5 runes** (`$state`, `$derived`, `$effect`, `$props`).
- **Postgres on 5434**, because this workstation's 5432 (Supabase) and 5433
  (native) are taken.
- **Terraform:** `plan` is fine; never `apply` without the operator's go-ahead.

## What not to do

- Don't add a test framework beyond vitest (unit) and Playwright (e2e, `e2e/`). Python importer tests aside.
- Don't replace pnpm, and don't `npm install -g` anything.
- Don't add the npm `xlsx` package (stale, with known advisories). Use SheetJS
  from its CDN tarball when the in-browser importer is built.
- Don't call the DB or secret-bearing services from the frontend.
