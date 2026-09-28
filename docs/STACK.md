# Stack: water-management

A multi-project web app for daily catchment water-balance modelling. It is a
port of the WBT b023 Excel tool (see [model.md](./model.md)). There is a static
SvelteKit frontend, a Hono API (a Node server locally, Lambda in production),
Postgres with row-level security, and one TypeScript model engine that both
sides share.

## Stack

- **packages/engine**: `@water-management/engine`. Pure TypeScript model
  (`runModel`) and shared types (`src/project.ts`). No I/O. Tested with vitest,
  two projects: `unit` (`pnpm test`) and `perf` (`*.perf.test.ts`, wall-clock
  budgets, `pnpm test:engine:perf` — median of several runs, run serially and alone,
  not part of `pnpm test`/CI since a loaded machine trips a hard budget).
  Imported as source by frontend and backend.
- **backend/**: Hono on Node (`tsx watch`, port `3001`) and AWS Lambda (Function
  URL, esbuild bundle). Uses `pg`, `zod`, `jose` (session JWT), `bcryptjs`,
  and for email `nodemailer` (SMTP → Mailpit locally) / `@aws-sdk/client-sesv2`
  (SES in production), picked by `MAIL_TRANSPORT`. Background jobs
  (`src/jobs/`) queue in a Postgres `job` table; a local worker process runs
  them (`JOB_TRANSPORT=inprocess`), and in production a worker Lambda woken
  through SQS (`@aws-sdk/client-sqs`) and a 5-minute schedule. Data feeds
  (`src/feeds/`: CHIRPS, CHIRPS-GEFS, DWS) run on that queue, reading
  synthetic fixtures (`fixtures/feeds/`, `FEED_SOURCE=fixtures`, the
  default) everywhere but the production fetcher Lambda. Server-side report
  PDFs (`src/reports/`) print the report route in headless Chromium
  (`playwright-core`, the browser e2e installs) and store the PDF through
  `@aws-sdk/client-s3` (MinIO locally, `STORAGE=local`; a private S3 bucket in
  production, where a container-image renderer Lambda does the printing).
  Alert emails (`src/alerts/`) are evaluated by an `alert_eval` job and sent
  by the tick, each built as its recipient under RLS (Mailpit locally;
  `ALERTS_ENABLED=false` is the kill switch).
  Plain SQL migrations live in `backend/migrations/`, run by
  `backend/scripts/migrate.ts`. vitest has four projects: `unit` (no DB),
  `db` (needs Postgres), `perf` (same wall-clock-budget caveat as the
  engine's) and `perf-db` (wall-clock budgets against Postgres,
  `*.db.perf.test.ts`, with the db project's global setup; the portfolio
  query's, the RLS role check's and the Step 2 60-farm load checks).
- **frontend/**: SvelteKit 2 (Svelte 5) **SPA** (`adapter-static` with a fallback
  `index.html`; `ssr = false`, `prerender = false`, except the public landing
  page at `/welcome`, prerendered, architecture.md), Vite, TypeScript, uPlot
  charts, vitest. No spreadsheet library ships: the `.xlsx` run export
  writes its own OOXML (`lib/spreadsheet/export/writer.ts`) and the b023
  import reads workbooks with its own streaming reader
  (`lib/spreadsheet/import/`). SheetJS CE 0.20.3 (`xlsx`, Apache-2.0) is a
  dev dependency the tests check both against (`writer.test.ts` fails if app
  code imports it), pinned as a URL dependency on its official CDN tarball
  (`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, integrity hash in
  `pnpm-lock.yaml`). Dependabot can't see a URL dependency, so bump it by hand. OSV can't read its version either, so `osv-scanner.toml` records the xlsx advisories 0.20.3 already fixes (with an expiry): update it with the pin. Dev port `7777`. `frontend/.env.production` sets
  `PUBLIC_API_URL=/api`.
- **e2e/**: Playwright, fully local. It uses an isolated
  `water_e2e` database and its own servers on `:3101` (API) and `:7801` (site),
  so it never collides with `pnpm dev`; a git worktree gets its own slot
  (ports + database, `e2e/support/env.ts`), so two checkouts can run it at
  once. The site is a production build (`frontend/build-e2e/`, API URL baked
  in), not the Vite dev server. CI runs it as 14 shards on one shared build
  ([e2e/README.md](../e2e/README.md)).
- **Mailpit**: docker-compose, catches all local email (SMTP **1026**, inbox
  http://localhost:8026, `pnpm dev:mail:up`).
- **MinIO**: docker-compose, S3-compatible storage for report PDFs (API
  **9002**, console http://localhost:9003, `pnpm dev:s3:up`; the community
  fork's image, since upstream stopped publishing one).
- **Postgres 17**: docker-compose, port **5434**. User/DB `water` owns the
  schema and runs migrations. The backend connects as `water_app`, which is
  bound by RLS. The `water_test` database is for DB tests (a git worktree uses its own `water_test_w<n>`, `backend/src/__tests__/test-db.ts`, so worktrees can run them at once).
- **scripts/wbt-import/**: Python 3.14 + openpyxl. Extracts a b023 workbook into
  `data/…/project.json` and regression fixtures. Output is gitignored, except
  the synthetic workbook fixture for the importer parity test and the
  string-decoding fixture that pins the reader to openpyxl
  (`scripts/wbt-import/fixtures/`, invented data).
- **infra/**: Terraform: S3 + CloudFront (+ `/api/*` → Lambda) + WAF + Lambda
  (API, plus a migrate Lambda, `backend/src/lambda-migrate.ts`, and the job
  worker, `backend/src/lambda-worker.ts`, with its SQS queue + DLQ and
  EventBridge tick, and the data feeds' fetcher, `backend/src/lambda-fetcher.ts`,
  outside the VPC with its two queues, and the report renderer,
  `backend/src/lambda-renderer.ts`, a container image in ECR, outside the VPC,
  with its two queues and a private reports bucket) + RDS Postgres 17
  in a private VPC + SES + Route 53 + ACM + budget/alarms. Not deployed yet
  ([plan.md Phase 6](./plan.md#phase-6-deploy-to-aws)).

pnpm monorepo with four workspaces (`frontend`, `backend`, `packages/*`, `e2e`).
Node 24 (`.tool-versions`), pnpm 10 (`packageManager: pnpm@10.33.2`).

## Commands (run from repo root)

```bash
pnpm setup                  # install, start Postgres, apply migrations, start Mailpit and MinIO (one-time)
pnpm dev                    # frontend :7777 + backend :3001 (needs dev:db:up; the backend applies pending migrations first)
pnpm dev:full               # dev + the background-job worker (opt-in; JOB_TRANSPORT=inprocess, Postgres only)
pnpm dev:run:frontend       # one side only
pnpm dev:run:backend
pnpm dev:run:worker         # the job worker alone: polls every 15 s and on LISTEN job_queued
pnpm dev:jobs:tick          # run every due job once and exit
pnpm dev:feeds:run          # fetch every enabled data feed once (fixtures by default, no network) and exit
pnpm dev:ingest:push        # push the synthetic logger CSV to /ingest with the API key in WM_INGEST_KEY (run-locally.md § Ingest)

pnpm dev:db:up              # Postgres 17 in docker on :5434
pnpm dev:db:down
pnpm dev:db:status | dev:db:logs
pnpm dev:db:migrate         # apply backend/migrations as `water`
pnpm dev:db:reset           # drop the volume, recreate, migrate (destroys local data)
pnpm dev:db:psql            # psql as the schema owner
pnpm dev:mail:up            # Mailpit: local inbox for all app email (UI :8026)
pnpm dev:mail:down | dev:mail:status | dev:mail:logs | dev:mail:open
pnpm dev:mail:bounce <email> [--complaint | --transient]   # stand in for an SES bounce: pauses that account's alert emails (run-locally.md § Alerts)
pnpm dev:s3:up              # MinIO: report PDFs (API :9002, console :9003, minioadmin / minioadmin)
pnpm dev:s3:down | dev:s3:status | dev:s3:logs

pnpm build                  # all workspaces (frontend/build, backend/dist/lambda.mjs)
pnpm build:frontend | build:backend
pnpm check                  # typecheck all workspaces
pnpm test:changed           # the fast loop: typecheck + only the tests your change reaches (docs/testing.md)
pnpm test                   # unit tests everywhere (no DB, no wall-clock assertions)
pnpm test:engine | test:frontend | test:backend   # test:backend includes the route-auth inventory
pnpm test:backend:db        # API + RLS tests, catalogue guards (water_test; needs dev:db:up)
pnpm test:engine:perf       # engine wall-clock budgets (median of 7, serial); run alone, not in CI/pnpm test
pnpm test:backend:perf      # backend wall-clock budgets (same caveat)
pnpm test:backend:perf:db   # backend budgets against Postgres (portfolio: 10 × 60 farms < 500 ms; the no-user role check; 60-farm runs < 10 s, ~4 min); needs dev:db:up, alone, never beside test:backend:db
pnpm test:e2e               # Playwright, incl. the new-catchment golden path (first run: test:e2e:install; also test:e2e:ui, check:e2e; server-report.spec.ts needs dev:s3:up + dev:mail:up, alerts-mailpit.spec.ts dev:mail:up)

pnpm seed:examples          # 3 invented example catchments + team + 2 demo users (demo@ / analyst@example.com) + 2 demo farmers (farmer1@ / farmer2@example.com) + a demo applicant (applicant@example.com), password demo-password
pnpm seed:demo              # seed:examples + each client workbook in ../project-water-management-source/Original/ (WBT_SOURCE_DIR), one project each (needs Python + openpyxl)
pnpm import:project <project.json> --email you@example.com [--name …] [--password …] [--run] [--skip-existing]
                             # [--settings <patch.json>] [--transfers <patch.json>] [--fit [--fit-seed n] [--fit-starts n] [--fit-budget n]]:
                             # patch the settings and transfer rules (by end-node names), fit GR4J before importing (model.md §2.10b)
pnpm pan-sensitivity <project.json> [--out <file.md>] [--seed <n>] [--starts <n>] [--budget <n>]
                             # GR4J at a few pan-coefficient choices, fixed vs refitted (no DB; refuses a monthly PE, settings.pe; model.md §2.4a)
pnpm test:scripts           # guard: root scripts point at real targets
pnpm check:infra            # Terraform fmt + validate + plan-only tests (mocked providers, no AWS creds)

pnpm check:workflows        # workflow guard (SHA pins, OIDC-only, production gating, CI-gate fan-in) + actionlint if installed
pnpm check:env              # committed env files point only at the local stack
pnpm check:claude           # the Claude agents, commands and skills cite only real paths and no template placeholders
pnpm check:bundle           # frontend gzip budget (after build:frontend); ceilings + change log in scripts/guards/check_web_bundle_budget.mjs
pnpm check:compliance       # advisory: privacy-doc drift vs origin/main
pnpm check:terms            # no client-identifying term in any tracked file (needs the terms list in ../infra-secrets; else a no-op)
pnpm check:pins             # the Playwright pins agree (backend, e2e, the renderer image's tag and npm lock)
pnpm check:renderer-image   # build the report renderer's container image and smoke-test it as Lambda runs it (docker; ~3.5 GB)
pnpm test:guards            # node:test suites for scripts/guards, scripts/release and scripts/ingest
pnpm gen:help-art           # re-render the help pictures (optional: Blender 5 + ImageMagick 7; output is committed)
pnpm gen:landing-art        # regenerate the landing page's art, screens and figures (optional tooling; docs/design/landing-art.md)
pnpm gen:limitations        # regenerate the known-limitations list from docs/engine-audit.md (after changing an audit item's decision)
pnpm gen:i18n:sheet [lang…]        # rewrite a language's translation sheet (default: every non-English language in
                             # packages/engine/src/languages.ts); check:i18n checks every language
pnpm gen:i18n:stamp <lang> <id>    # re-stamp a farmer glossary translation from the current English, once the translator has re-checked it
pnpm gen:i18n:export <lang> <dir>  # a language's untranslated sheet rows as JSON batches (for the i18n-translator agent, .claude/agents/i18n/)
pnpm gen:i18n:apply <lang> <f.json …>  # write checked words (sheet Id → text; later files win) into that language's catalogues (creating one
                             # that doesn't exist yet) and rewrite its sheet
```

## Running tests

**While you work, run only what you touched** (CLAUDE.md rule 12). The
quick way is `pnpm test:changed`: typecheck plus `vitest --changed` for what
your working changes touch, DB tests included when Postgres is up, never e2e
([testing.md](./testing.md)). By hand:

```bash
pnpm test:changed                                             # typecheck + the vitest files your changes touch
pnpm check                                                    # typecheck (fast; always)
pnpm -C backend exec vitest run --project unit src/<area>     # backend unit files you changed
pnpm -C backend exec vitest run --project db src/<area>       # backend DB/RLS files (needs dev:db:up)
pnpm -C frontend exec vitest run src/lib/components/<area>    # frontend unit files
pnpm -C packages/engine exec vitest run src/<area>            # engine unit files
pnpm -C e2e e2e tests/<spec>.spec.ts                          # e2e specs for the screens you changed
pnpm build:frontend && pnpm check:bundle                      # only when you added or moved frontend code
```

Also run the guard for anything the change touches: `src/routes.test.ts`
for a new route, `src/db/catalogue.db.test.ts` for a migration,
`pnpm test:scripts` for root scripts.

**The full suite runs on GitHub Actions, not locally.** CI
(`.github/workflows/ci.yml`) runs on every push to `main` and every PR: unit
tests, `test:backend:db`, the guards, the bundle budget, and e2e as 14
parallel shards on one shared build. Locally, before a commit, run
`pnpm check && pnpm test` plus the DB test files and e2e specs for what you
touched. Don't run the full `pnpm test:backend:db` or `pnpm test:e2e`
locally, and never run the suites one after another; if you do need more
than one locally, their parts are independent (unit tests use no database;
the DB tests use this checkout's `water_test…`; e2e uses its own
`water_e2e…` database and ports, `e2e/support/env.ts`), so start them as
background commands in parallel. Run `pnpm build:frontend && pnpm
check:bundle` when you added or moved frontend code. The DB project stays
serial *inside* itself (its queue and feed tests claim jobs globally;
`backend/vitest.config.ts` pins it to one worker, `maxWorkers: 1`). The perf projects
(`test:*:perf`) run alone, never alongside anything, since they assert
wall-clock budgets.

Don't pipe `pnpm test:e2e` into `grep`, `head` or `tail`: Playwright's web
servers keep the pipe open after the tests finish, so the command hangs
until something kills it. Redirect to a file (`> e2e.log 2>&1`) and read that.

Releases: `gh release create backend@X.Y.Z` / `web@X.Y.Z --target main
--generate-notes` deploys that component after a preflight and the
`production` approval ([deployment.md § Releasing](./deployment.md#releasing)).

## First-time setup

Local dev needs **no env setup**. `backend/.env.development` and
`frontend/.env.development` are committed and hold only non-sensitive local
defaults (localhost URLs, the throwaway docker DB passwords, a dev-only JWT
secret). Needs Node 24, pnpm 10, and docker (with compose).

```bash
pnpm setup
pnpm dev
```

The walkthrough, including how to import the client catchment, is in
[run-locally.md](./run-locally.md). Personal overrides go in a gitignored
`<workspace>/.env.development.local`. Never edit the committed file for those.

Deploying (only when the client is ready for it) is covered in
[deployment.md](./deployment.md).

## Where to look

- `docs/model.md`: the water-balance model, formulas, workbook quirks, glossary
- `docs/engine-audit.md`: where and why the engine departs from the workbook (finding IDs); `docs/engine-review.md`: the earlier faithfulness review
- `docs/legal/disclaimer-review.md`: the report disclaimer, sign-off statement and farmer liability lines, quoted for the client's legal review (issue #47)
- `docs/legal/operator-agreement.md` (POPIA s20–21 template for each client) and `docs/legal/incident-procedure.md` (personal-information breach: who decides, timelines, the Regulator's report); `docs/legal/information-officer.md` (registering with the Information Regulator); `docs/legal-status.md` tracks what is open
- `docs/calibration-research.md`: literature and South African practice review of calibration, recession, data uncertainty and EWR reporting, with prioritised recommendations (CR-1 … CR-34)
- `docs/data-model.md`: tables, workbook mapping, roles and RLS, series storage
- `docs/api.md`: HTTP contract
- `docs/ui.md`: the catchment workspace (tabs, Add data, schematic, results dashboard)
- `docs/run-comparison.md`: comparing two runs (matching rules, what the input diff sees)
- `docs/allocations.md`: registered water-use volumes (WARMS, licences) vs modelled use: import, matching, the comparison, who sees names
- `docs/scenarios.md`: scenarios, overrides on a base run (the engine's op catalogue, classification, problems; the backend, data model and API)
- `docs/testing.md`: which test command when, and how long each takes
- `docs/contributing.md`: the git workflow for sessions sharing a checkout, code organization, the root scripts format, and which files the templates repo owns; `.claude/README.md`: the Claude agents and commands
- `docs/plan.md`: roadmap, acceptance criteria, questions for the client, risks
- `docs/planned-work.md`: feature backlog beyond V1; `docs/followups.md`: known open work
- `docs/design/ui-playbook.md`: how screens are designed, built and tested (process, layout rules, reusable pieces, testing traps; the `ui-designer` agent works from it)
- `docs/design/`: design specs written before a build (the farmer view, issue #14; the licensing evidence report, issue #15), each with its prototype; planning outputs (share the pain, outcome matrix, seasonal outlook, licence impact by year class, issue #53), research and recommendations only
- `docs/roadmap/`: the four-step growth plan (hydrologist tool → shared catchment → licensing → platform), one build plan per step
- `docs/architecture.md`: system diagram, workspaces, request/run lifecycle
- `docs/run-locally.md`, `docs/deployment.md`, `docs/security.md`
- `docs/deployment-tiers.md`: minimal vs full (highly available) deployment, their tfvars and monthly cost
- `infra/README.md`: Terraform specifics

Prefer reading these over guessing. Update them when behaviour changes.

## Conventions and gotchas

- **This repo is public.** Never commit secrets (they live in the private
  `Absence0760/infra-secrets` repo under `water-management/`), client
  workbooks, or anything derived from them. Committed fixtures are synthetic,
  with no real farm names or values ([security.md § Public repo hygiene](./security.md#public-repo-hygiene)).
- **The engine stays pure.** No `fetch`, no DB, no Node or DOM APIs in
  `packages/engine`, because it has to run in the browser *and* in Lambda.
  Engine correctness is judged by documented hydrology and the invariant tests
  (`run.invariants.test.ts`), not by agreement with the workbook: an
  intentional departure is justified in [engine-audit.md](./engine-audit.md)
  and listed, column by column, in the client catchment regression suite's deviation
  list, which must stay green. A change in behaviour bumps `ENGINE_VERSION`.
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
  out. The same pair for the job worker: `jobs/worker.ts` (local, dotenv) and
  `lambda-worker.ts` (AWS, never dotenv), and `lambda-fetcher.ts` and
  `lambda-renderer.ts` are AWS only; `infra/scripts/package-lambdas.sh`
  refuses a Lambda bundle that contains dotenv, and any static import of
  `playwright-core` in a bundle but the renderer's (the lazy `import()` in
  `reports/render.ts` is the one allowed path; `scripts/guards/check_lambda_bundle.mjs`).
- **Static SPA frontend only.** No SSR adapters. Routes render client-side from
  the fallback `index.html` (CloudFront maps 404s to it). `PUBLIC_API_URL` is
  `http://localhost:3001` in dev and `/api` in production (CloudFront proxy).
- **Svelte 5 runes** (`$state`, `$derived`, `$effect`, `$props`).
- **i18n messages (WP-2.5).** Farmer-facing strings (farm view, sign-in
  pages, account and alert pages, `/share`, the landing page) are their English, written at the
  call: `t('Your dam')`, `tRich(…)`, `tn(DAYS, n)`; a message kept in a table
  or variable is `msg('…')`, a counted word `plural({ one, other })`, and a
  file's messages sit under an `// i18n-section:` marker. Farmer emails come
  from `backend/src/mail/i18n/en.ts` (keyed) through `mailT()`. Never show a
  string there without `t()`, never write another language's words by hand:
  a new or changed message goes through the `i18n-translator` and
  `i18n-checker` agents and `pnpm gen:i18n:apply <lang>` (ui.md § Language),
  and run `pnpm gen:i18n:sheet` after changing a message (the
  tests throw on English that isn't on the sheet; [ui.md §
  Language](./ui.md#language)). The workspace stays English. Those pages
  show a server error through `errorText` (`lib/i18n/apiError.ts`, from the
  API's stable `code`), never its English `error` text; a new error a farmer
  can meet gets a code in `backend/src/http/errors.ts` `ERROR_CODES` and a
  message in `apiError.ts` `CODES` (`http/errorCodes.test.ts` fails on an
  uncoded one in those routes).
- **`pnpm check` doesn't compile components.** svelte-check type-checks the
  TypeScript in `<script lang="ts">`; the Svelte compiler strips it at build
  time, and a stripping bug fails every `vite build` (production and the e2e
  site alike) while `check` stays green. Svelte 5.56.0–5.56.3 left `?` on
  optional parameters (sveltejs/svelte#18455). The guard is
  `frontend/src/lib/components/__fixtures__/tsSyntax.test.ts`: it compiles a
  fixture through `svelte.config.js`'s preprocess and Vite's parser (Rolldown's). Add a
  case to its fixture when a new TS form breaks a build.
- **Postgres on 5434**, because this workstation's 5432 (Supabase) and 5433
  (native) are taken.
- **Terraform:** `plan` is fine; never `apply` without the operator's go-ahead.

## What not to do

- Don't add a test framework beyond vitest (unit) and Playwright (e2e, `e2e/`). Python importer tests aside, and the
  dependency-free CI/release guards under `scripts/` (and `e2e/support/*.test.ts`) use Node's built-in `node:test`
  (the estate pattern), since the root package has no dependencies.
- Don't replace pnpm, and don't `npm install -g` anything.
- Don't add the npm `xlsx` package (stale, with known advisories). SheetJS
  comes from its CDN tarball (see frontend above); keep the `package.json` URL
  pin, never a registry version.
- Don't call the DB or secret-bearing services from the frontend.
