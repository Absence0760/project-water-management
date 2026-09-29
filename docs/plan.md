# Roadmap: from local V1 to a fully working product

**Goal right now:** a **V1 that runs on a laptop**, used to show the client and
ask *"is this what you want?"*. We then iterate on their answers before building
more. Deploying comes later and is deliberately cheap, because nothing is
decided until the client has seen V1.

Decisions already made (the reasoning is in [architecture.md](./architecture.md)
and [data-model.md](./data-model.md)):

- **Hybrid model.** The data model is node-based and general. The first engine
  is a **faithful port of b023** that has to match the client workbook
  number for number. A rainfall-runoff module comes later as an *alternative flow
  generator*. *Since superseded:* the engine fixes the workbook's bugs rather
  than copying them (see Risks), so correctness is judged by documented
  hydrology and invariant tests ([engine-audit.md](./engine-audit.md)), and
  GR4J became the alternative, then the default runoff
  model (engine 0.11.0, [model.md §2.4a](./model.md#24a-rain-to-flow-gr4j-engine--050-issue-4)),
  then the only one (engine 1.0.0).
- **Runoff model on record: GR4J (issue #4 Phase 6 decision gate, 2026-09-25).**
  GR4J is the daily model. **The legacy model was removed on 2026-09-26 in
  engine 1.0.0** (issue #4 Phase 10, issue #16, ahead of its 2026-11-30
  deadline): GR4J is the only runoff model, migration 064 moved every project
  to it, and stored legacy runs stay readable, badged, never re-run and never
  evidence ([model.md §2.4](./model.md#24-natural-flow-from-rain-flow-data),
  [audit H1](./engine-audit.md), closed). The planned trigger, the
  hydrologist seeing the client catchment's GR4J results with the Phase 9
  bands in a review session first, was **waived by the operator**. The
  hydrologist's sign-off, and their acceptance of the client catchment's
  validation (results in the private source repo; every client figure
  carries the Phase 9 bands), are
  **assumed by the operator**, not given in writing. Reopen issue #4 if the
  hydrologist disagrees.
- **Multi-project, multi-user.** A user can have any number of projects
  (catchments A, B, C, … and more later). Access is set per project with the
  roles viewer, editor and owner, and **Postgres RLS enforces it**.
- **Local-first.** Postgres 17 runs in docker on `:5434`, and nothing needs a
  cloud account. AWS comes later.
- **One TypeScript engine** (`packages/engine`) is used by the browser (for
  instant what-if runs) and by the Lambda (for stored runs). A full client catchment
  run takes milliseconds.
- Time series are stored as `double precision[]`, and run outputs as one array
  per series. Sessions use a JWT in an httpOnly cookie. Migrations are plain
  SQL. Charts use uPlot.
- **Excel import:** **Import b023 workbook** reads the workbook in the browser
  (a TypeScript port of the Python extractor on its own streaming workbook
  reader, in a Web Worker, WP-1.31). The Python extractor (`scripts/wbt-import`) stays for the
  regression fixtures and `pnpm seed:demo`; both give the same `project.json`.
- **The repo is public.** No secret, client workbook or client-derived data is
  ever committed. The workbooks live outside the repo (`../project-water-management-source/`); `data/` and `*.xlsm`/`*.xlsx` are
  gitignored, and committed fixtures are synthetic, with no real farm names or
  values. All production secrets are SOPS-encrypted in the private
  `Absence0760/infra-secrets` repo under `water-management/`
  ([security.md § Public repo hygiene](./security.md#public-repo-hygiene)).
- **Production URL: `water-management.jaredhoward.com`.** The slug is
  `water-management`, and the URL is a delegated child zone of `jaredhoward.com`
  ([Phase 6](#phase-6-deploy-to-aws)).

Status key: ✅ done · 🚧 in progress · ⬜ not started.

---


> Feature ideas beyond this plan — what the initial design missed, grouped
> Now / Next / Later with effort — live in [planned-work.md](./planned-work.md).

## Phase 0: Foundation ✅

- ✅ Bootstrapped from `templates/web-minimal` (SvelteKit static frontend, Hono
  backend, Terraform for S3 + CloudFront + Lambda).
- ✅ Postgres 17 in docker-compose (`:5434`), with the `water` (owner) and
  `water_app` (RLS-bound) roles.
- ✅ Migration `001_init.sql`: users, projects, members, network, crops, crop
  areas, transfers, time series, runs, RLS policies, and guards for the last
  owner and same-project references.
- ✅ The `packages/engine` workspace with shared types (`project.ts`), the
  water-year calendar and the demand functions.
- ✅ API contract ([api.md](./api.md)).

## Phase 1: V1 local demo 🚧

**Goal:** after `git clone`, `pnpm setup`, `pnpm dev`, a person can register,
import the client catchment, run the model and look at the results. They can also create
a second and third project (empty, or copied) side by side.

### 1a. Engine: port b023 ([model.md §2](./model.md#2-the-b023-model-what-v1-ports))

- ✅ Natural flow from rain (§2.4): season state, base flow, recession index,
  pulse index, response flow (the Pitman fallback was dropped in engine
  0.10.0, [audit P1](./engine-audit.md)). This needs the extra calibration
  settings: recession curve and factors, shift-peak indices, reset ratio, winter
  thresholds, amplitude, max days. From engine 0.11.0 this model was the
  `legacy` runoff model, kept for workbook comparison only ([audit H1](./engine-audit.md)),
  with GR4J the default; engine 1.0.0 removed it (issue #16). Its last
  end-to-end comparison with the workbook passed (engine 0.45.0).
- ✅ Net irrigation demand per day (§2.3). The workbook's rounding was
  dropped in the engine audit (R1).
- ✅ Flow shares by the Area, Hi/Lo and Specific methods, plus fragmented flow
  and EWR (§2.5).
- ✅ Farm balance in network order, with gauges (§2.7).
- ✅ Transfers from structured rules (§2.6).
- ✅ EWR check at the outflow gauge, per-farm summaries, and calibration stats
  (NSE, PBIAS, RMSE) against the observed series.
- ✅ A `warnings[]` list: shares not summing to 1, missing series, gaps in rain.

**Acceptance:** regression tests driven by fixtures extracted from the client catchment
(under `data/`, gitignored, skipped when absent) match the workbook's columns
**exactly** for every day of the record: natural flow, net demand per farm, storage,
spill, outflow, deficit, EWR shortfall and simulated outflow. Committed
synthetic fixtures cover the same code paths on CI. *Superseded by the
engine-correctness policy (CLAUDE.md rule 10):* the suite matches the
workbook except where [engine-audit.md](./engine-audit.md) justifies a
departure, and it lists each affected column with its finding ID.

### 1b. Import

- ✅ `scripts/wbt-import` (Python + openpyxl, read-only) extracts the network,
  farm spec, crops, crop areas, transfer parameters, calibration and pragmatic
  EWR from a b023 workbook. It also extracts the daily input series. The output
  is `data/<name>/project.json` (the `ProjectModel` + settings + series shape).
- ✅ `pnpm import:project <project.json> --email …` creates a project from
  `project.json`, and `pnpm seed:demo` extracts and imports the local
  workbooks for a demo user.
- ✅ **Import project file (.json)** on the project list (WP-1.8,
  `POST /projects/import`) takes the same `project.json`, or a project's own
  download, into any account, including production.
- ✅ **Import b023 workbook** on the project list (WP-1.31) reads the `.xlsm`
  itself in the browser, with no Python: a Web Worker, progress per sheet,
  Cancel, a review, then the same `POST /projects/import`
  ([ui.md § Import a b023 workbook](./ui.md#import-a-b023-workbook)). For
  the client workbook it gives the same `project.json` as the Python, and
  the imported project's run summary is identical.
- ✅ The importer reports whatever it could not map: hand-written transfer
  formulas that don't fit the rule shape, a Specific method with no values,
  a rule with no destination or no rate, M1 month lists, unknown element
  types, number cells holding text (the TypeScript port's `unmapped` list,
  [scripts/wbt-import/README.md](../scripts/wbt-import/README.md#the-typescript-port-in-browser-import)).
  The import review shows it as its own section, with sheet, cell and
  element (WP-1.31), and the notes and unmapped report are kept with the
  project: its Overview's **Import record** shows them long after the
  import (017_project_import, [api.md § Import report](./api.md#import-report)).

**Acceptance:** importing the client catchment gives a project whose run reproduces the
workbook (as in 1a) with **no manual edits**.

### 1c. Backend API ([api.md](./api.md))

- ✅ **Teams** (`002_teams.sql`): groups own many catchments. Team admin → owner
  and team member → editor on every team project (team viewer → viewer since
  `008_team_viewer.sql`); direct sharing still works;
  the effective role is the higher of the two. Teams UI at `/teams`.
- ✅ **Append / merge daily data**: `POST /projects/:id/series/merge` adds a
  daily or batch update to a series by date (new days extend, re-sent days
  overwrite, gaps become missing). Add data on the Data tab defaults to
  append / update.
- ✅ **Seed data**: `pnpm seed:examples` — three invented catchments (healthy
  winter-rainfall, water-stressed, larger summer-rainfall network), each with a
  run, plus a team and two demo users sharing both ways. Safe to commit (no
  client data); used by e2e.

- ✅ Auth: register, login, logout, me (bcryptjs; jose HS256 in the `wm_session`
  httpOnly cookie).
- ✅ Projects: CRUD plus copy. Members: list, add by email, change role, remove.
- ✅ Model document: `GET`/`PUT` with tree validation. Series: list, get,
  upsert, delete. Runs: create (synchronous), list, get, fetch one series,
  delete.
- ✅ Every project-scoped query runs in a transaction as `water_app` with
  `app.current_user_id` set. DB tests prove the RLS rules
  ([data-model.md § Access control](./data-model.md#access-control)). Every
  "cannot see" test has a positive control, meaning the member *can* see it,
  so an empty result isn't a false pass.
- ✅ **Catalogue guards** (`backend/src/db/catalogue.db.test.ts`): RLS is
  enabled on every table outside the allowlist, every RLS table has policies,
  `water_app` has the grants but owns nothing and can't bypass RLS, every
  function pins `search_path`, and every foreign key has a covering index.
- ✅ **Route guard** (`backend/src/routes.test.ts`): a test that walks the Hono router and fails when a route
  is neither auth-gated nor on the explicit public allowlist (`/health`,
  register, login, logout, and the forgot / reset / verify / invite-info
  email routes). API errors never include raw DB error text.

### 1d. Frontend

- ✅ Sign in / register. A project list with role badges. Create, copy, delete.
- 🚧 Project workspace (V1 built; hydrologist-focused polish in progress): **Network** (a tree view of farms and gauges, with an
  editable table of farm parameters), **Crops** (monthly factors, and an
  area-per-farm grid), **Transfers**, **Settings** (A-pan, effective rain, flow
  share method, calibration, pragmatic EWR, date window), **Data** (upload CSV
  series, show coverage and gaps).
- ✅ **Run and results** (V1 built, with flow-duration curves, a log scale and dam storage %): a run button, a run history, catchment charts (natural
  vs simulated vs observed flow, EWR line, days not met), per-farm charts
  (demand vs supplied, dam storage, spill), a Shortfalls table, and calibration
  stats. Charts use uPlot and handle a full multi-decade daily record without lag.
- ⬜ A browser-side instant preview: change a parameter and see the effect
  without saving, using the same engine.
- ✅ Members panel (owner manages; anyone can leave).
- ⬜ **Request sequencer** for list and series fetches, so that a slow, stale
  response can't overwrite a newer one when the user switches project or
  series quickly.
- ✅ **e2e (Playwright)** under `e2e/`, running fully locally against docker
  Postgres, the backend and a production build of the frontend. Pinned `timezoneId: 'UTC'`, and waits on real
  signals (no `networkidle`). The first spec is the demo path: register,
  create project, import, run, chart.
- ✅ `packageManager` is pinned (pnpm 10) in the root `package.json`.
- 🚧 Run date-sensitive unit tests under a skewed `TZ`, so that code which
  accidentally depends on local time fails. Some date tests set a skewed
  `TZ` themselves; no workspace's test script sets one yet (roadmap WP-1.12).

**Phase 1 acceptance (the demo):**

- [ ] A fresh clone with `pnpm setup && pnpm dev` works with no other setup
      ([run-locally.md](./run-locally.md)).
- [ ] Client catchment imported: its results match the workbook, the charts and
      Shortfalls table appear, and a run finishes in under 2 s including storage.
- [ ] Projects A, B, C exist side by side. Creating D and copying C both work.
- [ ] A second user sees nothing until they are invited. As a viewer they can't
      edit.
- [ ] `pnpm check`, `pnpm test` and `pnpm test:backend:db` pass.

### 1e. Data ingestion (after V1)

Catchments receive new data daily or in batches (logger readings, CHIRPS
satellite rainfall, forecasts) — the workbook's "New data from" and forecast
rows exist for this.

- ✅ Merge endpoint (above) — the building block for every feed.
- ⬜ **API keys per project** (hashed, scoped to `series:write`, revocable) so a
  logger gateway or script can push without a user session.
- ✅ **Scheduled fetchers** (issue #10, WP-2.10; [architecture.md § Data feeds](./architecture.md#data-feeds)):
  CHIRPS daily rainfall and the CHIRPS-GEFS forecast for grid cells over the
  catchment, and a DWS gauge's daily flow, on the job queue, with health and
  stale-feed warnings in Settings → Data feeds. Synthetic fixtures locally;
  in production a fetcher Lambda outside the VPC (Terraform plan only). By
  cells, not a polygon yet; DWS unverified against the live site
  ([followups.md](./followups.md)).
- ✅ **Auto re-run** after new data (WP-2.11; [architecture.md § Automatic runs](./architecture.md#automatic-runs)):
  opt-in per project (Settings → Automatic runs), debounced (15 min by
  default, at most 2 h after the first new data), one pending re-run per
  project; auto runs are tagged and capped apart (the newest unkept one is
  kept), so a person's runs stay for comparison; the "new data since last
  run" banner says when the re-run is queued. Publication stays a person's
  act unless the project opts in to "if no new warnings".
- ⬜ **Partial recompute** from the first changed day, reusing stored state
  (the workbook's "New data from" logic) — only needed if full runs get slow
  (currently a fraction of a second of engine time for the full record).
  The engine half exists since 1.1.0 (model-state snapshots, model.md
  §2.16: capture a run's state on a day, resume from it to the bit); a
  saved run would still need its snapshot stored and the pinned
  record-wide statistics refitted now and then.
- ✅ Forecast days flagged (workbook marks them "F") and shown distinctly in charts
  (roadmap WP-2.12): forecast mode keeps them out of every other figure
  (model.md §2.4f), a forecast run has its own panel, a labelled band on
  every daily chart, an `F` column in the daily CSVs, and the farmer's
  "Next 14 days" when published.

---

## Phase 2: Client review and first iteration

**Goal:** show V1 to the client, get answers to the
[questions below](#questions-for-the-client), and change V1 accordingly.

- ⬜ A demo script: the client catchment walkthrough, one what-if (for example
  doubling one farm's dam, or switching a transfer off), and the Shortfalls
  table compared with the workbook side by side.
- ⬜ Record the answers here and in [model.md §3](./model.md#3-workbook-quirks-and-suspected-bugs).
- ⬜ For each quirk the hydrologist calls a bug, fix it and bump
  `ENGINE_VERSION`. *Changed:* the operator decided to fix workbook bugs
  outright, with no workbook-compatible mode (see Risks); each run records its
  engine version, so older results stay explainable.
- ✅ Fill in the rest of the Shortfalls report (target volume, reduce/gain,
  volume left after balancing): the curtailment table (model.md §2.11). Q11
  and Q13 are decided on a simulated assessor's recommendation (engine
  0.17.0), pending the hydrologist.
- 🚧 Export: CSV per series and per run is built ([api.md § Export](./api.md#export));
  an Excel download of a run (a sheet per farm, like the element sheets) is
  not.
- ⬜ UX fixes from the session.

**Acceptance:** the client confirms the model behaviour and the UI direction in
writing, or gives a ranked change list.

## Phase 3: Complete the b023 feature set

- ✅ **Scenarios:** compare two runs or two projects (for example the baseline
  and "farm X's dam +50%"), with difference charts and a difference table.
  Run comparison is built ([run-comparison.md](./run-comparison.md)), and so
  are scenarios within a project (roadmap step 3,
  [#18](https://github.com/Absence0760/project-water-management/issues/18)):
  the engine, backend and API, and the Scenarios tab with its override
  editor and scenario-vs-base comparison ([scenarios.md](./scenarios.md),
  [ui.md § Scenarios](./ui.md#scenarios-tabscenarios)).
- ⬜ **EWR tooling:** derive the pragmatic EWR from Desktop Reserve tables
  (percentile, scale factor, per-month overrides), as `[EWR Cfg]` does (Q10).
- ✅ **Reports:** EWR analysis by farm × year × month, count and % of days not
  met, and annual water balance (observed vs simulated MAR per year). Built:
  the EWR compliance grid (`EwrHeatmap`, outlet and per farm, engine
  `EwrCompliance`) and the annual water balance table in the calibration
  panel. The printable catchment report
  ([#19](https://github.com/Absence0760/project-water-management/issues/19),
  WP-2.15 Phase A) puts them, with the rest of a run's results, on A4
  ([ui.md § Report](./ui.md#report)).
- 🚧 **Calibration workbench:** plot observed vs simulated, adjust the rain→flow
  parameters with live NSE/PBIAS, and save a calibration version (the
  workbook's "Calibration" button and `[Log]`). Built: the calibration panel,
  automatic calibration (Fit automatically, model.md §2.10b) and a fit record
  stored with the parameters and snapshotted by each run. Not built: a live
  preview while editing (roadmap WP-1.17).
- ✅ **In-browser Excel import** with SheetJS (WP-1.31, 2026-09-25), loaded
  from its official CDN tarball (the npm `xlsx` 0.18.5 is stale and has known
  advisories), in a Web Worker. The import needs no Python. Since then it
  reads workbooks with its own streaming reader instead of SheetJS (peak
  memory on the largest workbooks, measured in Chrome, Safari and phone
  simulators, [followups.md](./followups.md)).
- 🚧 An audit log per project: who changed what, and which run used which
  inputs. Done: each run snapshots its inputs with a content hash per input
  series. Not built: the change log (roadmap WP-2.4).

## Phase 4: Node-based extensions ([model.md §4](./model.md#4-the-ai-node-based-model))

- ⬜ Node types beyond farm/gauge: headwater, dam/bypass, run-of-river,
  confluence, natural. Add a migration for the new node attributes (pump
  capacity, trigger/stop %, pool storage, river abstraction fraction).
- ⬜ **Pump scenarios** per farm: Dam-first, River-first, Trigger-based and
  Run-of-river first. Then seasonal river-first, no river pumping,
  drought-saving and opportunistic. Groundwater last.
- ⬜ **Stress classes** (≥95 Low, ≥85 Moderate, ≥70 High, ≥50 Severe, else
  Critical) per farm and month, shown as a map or grid.
- ⬜ Naturalisation, done properly: a node network must not be circular (every
  farm showing 100% met).
- ⬜ A network diagram editor (drag and drop), if the client wants to build
  networks rather than import them.

## Phase 5: AI runoff module as an alternative flow generator ([model.md §5](./model.md#5-the-ai-runoff-module))

- ⬜ Close the water balance first: all effective rain tracked, no drainage that
  creates water, every parameter used, and no hard-coded outlet node.
- ⬜ Hydrological units per project (area, MAP, reference gauge). Multiple rain
  stations.
- ⬜ A `flowGenerator` project setting: `b023-recession` (default) or
  `bucket-v1`. Both produce natural flow per node for the same farm balance.
  The seam now exists as `settings.runoffModel` (`gr4j`, the only model
  since engine 1.0.0 removed `legacy`); the bucket model would be a second
  option.
- ⬜ Calibration metrics (NSE, PBIAS, KGE) and the annual water-balance table.

**Acceptance:** the hydrologist accepts the bucket model's calibration for at
least one catchment, **and** its water balance closes to within a tolerance
that the tests assert.

---

## Phase 6: Deploy to AWS

Do this after Phase 2, once the client wants other people to use it. The
mechanics are in [deployment.md](./deployment.md). What has to be built or
decided:

### 6a. Account, domain, secrets

Decided: slug **`water-management`**, URL **`https://water-management.jaredhoward.com`**,
region **`af-south-1`**, **minimal tier** to start (`budget_monthly_usd = 80`;
[deployment-tiers.md](./deployment-tiers.md)).

- ⬜ Bootstrap tfvars `~/github/templates/infra/bootstrap/projects/water-management.tfvars`
  with `create_subdomain = true`.
- ⬜ Run `~/github/templates/scripts/new-project-account.sh water-management`
  (with `--plan` first). It creates the in-org sub-account, the tfstate bucket
  `water-management-tfstate-<account-id>` (S3 lockfile, no DynamoDB), the
  `alias/water-management-sops` KMS key, the GitHub OIDC deploy role
  `water-management-deploy` (trust pinned to `environment:production`), the
  `production` environment with a required reviewer, and branch protection.
  It also creates the **child Route 53 zone `water-management.jaredhoward.com`**.
  Its delegation stage runs as the `dns-parent` profile and writes the NS
  records into the `jaredhoward.com` parent zone (in the `jaredhoward`
  account), the same way as `disag.jaredhoward.com`.
- ⬜ This repo's Terraform owns the ACM certificate (us-east-1, DNS-validated
  in the child zone) and the CloudFront alias and Route 53 A/AAAA records for
  `water-management.jaredhoward.com`. `domain_name` and `route53_zone_id` in
  `terraform.tfvars` point at the child zone.
- ⬜ Secrets: `cd ~/github/infra-secrets && ./bin/sops-init.sh --project water-management --region <region>`,
  then `sops water-management/prod.sops.yaml` with `AUTH_JWT_SECRET`, the
  `water_app` DB password and the owner/migration DB password (unless RDS
  Secrets Manager manages it). Terraform reads them with the `carlpett/sops`
  provider (`data "sops_file"`), or through a decrypt-to-tfvars step. Plaintext
  never touches this repo.
- ⬜ **Region.** Given POPIA and latency to South Africa, `af-south-1` (Cape
  Town) is the natural choice for the DB and Lambda. It is an opt-in region with
  somewhat higher prices, and RDS PostgreSQL 17 on t4g must be available
  there. CloudFront's certificate stays in `us-east-1` whatever the
  region.

### 6b. Terraform additions (`infra/`)

The infrastructure is Terraform in `infra/` and follows the estate pattern:
state in the bootstrap's S3 bucket (lockfile), a deploy role looked up from the
bootstrap, secrets from `infra-secrets` through sops. Resource-level detail
lives in [infra/README.md](../infra/README.md). The intent:

- 🚧 **Database: RDS PostgreSQL 17** (`db.t4g.micro`, the same major version as
  local). Private subnets only, encrypted at rest, TLS, automated backups with
  PITR (7+ days), deletion protection. Chosen over Aurora Serverless v2 for
  these reasons: it stays warm with no ~15 s resume on first request, the
  `pg` code path is the same as local (no Data API driver or payload limits),
  and the cost is predictable (~$12–15/month). Revisit Aurora with
  scale-to-zero only if idle cost matters more than first-request latency.
- 🚧 **VPC Lambda.** The API Lambda runs in the DB's VPC and reaches AWS APIs
  through VPC endpoints rather than a NAT. It connects as `water_app`
  (RLS-bound).
- 🚧 **Migrate Lambda.** A separate function that runs `backend/migrations` as
  the owner role and also creates or updates `water_app`. The deploy invokes it
  before publishing new API code.
- 🚧 **Secrets through sops.** `AUTH_JWT_SECRET` and the DB passwords come from
  `infra-secrets/water-management/prod.sops.yaml` (the `carlpett/sops` provider)
  into Lambda configuration. Nothing is in this repo.
- 🚧 **Lambda runtime `nodejs24.x`** (the repo moves to Node 24). Timeout ~30 s
  for runs and memory ~1024 MB (engine plus large JSON). Reserved concurrency
  stays capped.
- 🚧 CloudFront already proxies same-origin `/api/*` to the Function URL with a
  shared-secret header. Keep that, so the session cookie is first-party and
  `SameSite=Lax` works. Tighten or drop the Function URL CORS block, since the
  browser never calls the Function URL directly (dropped in `infra/lambda.tf`).
- 🚧 Budget and alarms: DB CPU, free storage and connections, plus Lambda
  errors and duration. Budget $25–50/month (written in `infra/alarms.tf`).

### 6c. CI/CD

- 🚧 CI (`.github/workflows/ci.yml`) runs on PRs and on `main`, including the
  DB tests against a Postgres service container. Once the account exists, make
  `CI gate` a required check.
- 🚧 Deploy workflows: turn on the release trigger. Add a **migrate** step
  (a one-off Lambda invocation or a CI job with DB access) that runs before the
  new code is published. All of this is gated on `environment: production`.
  Built: `deploy-backend.yml` and `deploy-frontend.yml` run on `backend@` /
  `web@` releases behind a preflight, and the backend deploy updates the
  migrate Lambda and runs it before the API. The preflight refuses every
  release until the account exists ([deployment.md § Releasing](./deployment.md#releasing)).
- ⬜ `~/github/templates/scripts/export-tf-vars.sh infra/` to push Terraform
  outputs into GitHub variables and secrets.

**Acceptance:** `gh release create backend@X.Y.Z` (and `web@X.Y.Z`) deploys after the reviewer approves.
The site is served at the chosen domain over HTTPS, a smoke test (register,
import, run) passes against production, and a restore from backup has been
rehearsed once (`infra/scripts/restore-db.sh`, the checklist in
[deployment.md § Restoring the database](./deployment.md#restoring-the-database)).

## Phase 7: Production hardening

- ✅ **Accounts:** password reset and email verification (SES), and invitations
  by email for people without an account yet — "Forgot password?" on sign-in,
  a confirm-email banner, sign-up through an invite link (address locked, joins
  on sign-up), and pending invites with re-send / revoke on the project Members
  panel and the team page. Farmers are invited with their farms, one by one
  or from a CSV of up to 200 rows with a preview (WP-2.2, issue #27).
- ✅ **Abuse limits:** **per-account login lockout** (back off after N failed
  attempts per email, stored in the DB so it holds across Lambda instances),
  plus a per-IP limit on register. This adds to the WAF rate rule at the edge.
  The lockout is `005_login_throttle.sql`; the register limit (per client
  address and global) is `079_signup_throttle.sql`.
- ✅ **Session revocation watermark:** `app_user.sessions_revoked_at`. A JWT
  whose `iat` is older than the watermark is rejected. "Sign out everywhere",
  a password change and an admin lock all set it. That gives revocation
  without a session table.
- 🚧 **Data protection (POPIA):** a privacy notice, data export (done:
  `GET /auth/me/export`, the Account page's "Download my data") and account
  deletion, a retention policy for runs, and a sub-processor list (AWS). Run
  `/audit/popia`, `/audit/account-deletion-completeness` and
  `/audit/data-export-completeness`.
- 🚧 **Run storage:** trim output keys, cap the number of runs kept
  (done: `RUNS_KEPT_PER_PROJECT`, default 20), and consider float4 ([data-model.md](./data-model.md#time-series-storage)).
- ⬜ Background runs if some run ever exceeds the Lambda timeout (for example
  many scenarios at once). SQS + a worker Lambda, with a status on
  `model_run`.
- 🚧 **Accessibility (WCAG 2.2 AA):** axe checks in the Playwright specs for
  every page, a 320 px-wide reflow check (no horizontal scroll except inside
  the chart and grid scrollers), and a contrast test over the design tokens
  (every text/background pair ≥ 4.5:1, UI ≥ 3:1). Done: the axe scan of every
  page, tab and main state in both themes, plus the phone layout
  (`e2e/tests/a11y.spec.ts`). Not yet: the 320 px reflow check and the token
  contrast test.
- ✅ **CSP:** a Content-Security-Policy through a CloudFront response-headers
  policy. SvelteKit's static build needs `'unsafe-inline'` for its bootstrap
  script unless hashes are generated. Done with hashes: SvelteKit's per-build
  meta CSP narrows scripts to `'self'` plus the bootstrap hash, and the
  frontend deploy refuses a build without it. Styles keep `'unsafe-inline'`,
  an accepted risk ([security.md](./security.md#known-gaps-tracked-in-planmd)).
- ⬜ A user guide written for hydrologists and farmers' associations.
- ⬜ `/audit/all`, `/release-readiness` before a 1.0 tag.

---

## Questions for the client

Take these to the V1 demo. Answers go in this section (dated) and, for model
questions, in [model.md §3](./model.md#3-workbook-quirks-and-suspected-bugs).

### Model and hydrology (for the hydrologist)

> **Calibration record ([#1](https://github.com/Absence0760/project-water-management/issues/1), closed).**
>
> **Decided 2026-09-25: calibrate and validate on the logger. The workbook's
> gauge column is used only as a regional wet/dry index.** Question 1 below
> was answered yes by the operator on the hydrologist's behalf (their
> agreement assumed, not yet written down by them); if the hydrologist later
> disagrees, reopen #1. This is what the
> workbook and the imported settings already do. The research behind it
> ([model.md §2.10](./model.md#210-calibration-statistics-flow-calibration-cfg)):
> the workbook's gauge column isn't a suitable calibration record for the
> modelled catchment (evidence in the private source repo). Since engine
> 0.7.1 the importer can bring the gauge in as a reference series the engine
> never scores against.
>
> 1. **Confirm:** the logger is the calibration and validation target, and the
>    workbook's gauge is a regional wet/dry index only (ranking water years
>    for the dry→wet test). **Yes (2026-09-25, assumed on the hydrologist's
>    behalf; see above).**
> 2. **Rating (CR-18):** what is the highest field gauging at the logger, and
>    which rating curve converts its stage to flow? Flows above that gauging
>    are extrapolated, so peak days and wet-season volumes are uncertain; the
>    answer decides which days get flagged.
> 3. **Area:** which catchment area should the project use where published
>    figures disagree?
> 4. **Accept the limitation:** where a calibration record can't pin down
>    GR4J's parameters (evidence in the private source repo), the fit to present is the one with
>    Perrin's typical bounds plus the WR2012 MAR band; the durable fix is a
>    proxy-basin model of a gauged neighbour (CR-9). Is that acceptable for
>    now, with the uncertainty reported?
>
> The yes to 1 closed #1. Questions 2–4 are still open and don't reopen it;
> each is its own follow-up.

> **Rain forcing ([#12](https://github.com/Absence0760/project-water-management/issues/12), closed).**
>
> **Decided 2026-09-26: force the model with the #12 era treatment.** The
> operator accepted the research's recommendation on the hydrologist's
> behalf (their agreement assumed, not yet written down by them); if the
> hydrologist later disagrees, reopen #12. The central configuration:
> the station series as recorded where it is sound, with an uncertainty band
> where it is less so; gaps filled from ERA5 × reference-era monthly factors
> (the per-range fit period, #40); any era where the station record fails
> replaced by a better source (the per-period rain source, #40), its gaps
> filled from ERA5 and never CHIRPS v3; the absolute level chosen from the
> joint rain × PE grid by a Budyko check; `kgeNp` for EWR and low-flow statistics, with a KGE′ fit kept
> for peak-flow and event questions. EWR is reported as a range, separately
> for the calibration and replaced eras; EWR figures from the untreated
> record are withdrawn. The method is in
> [calibration-research.md § Rain forcing](./calibration-research.md#rain-forcing-which-record-and-how-to-homogenise-it-issue-12);
> figures in the private repo's `Research/rainfall-forcing.md`.
>
> 5. **Rain gauges:** which gauges are behind the catchment rain series? With
>    a fixed station set a replaced era could be rebuilt rather than
>    replaced, and the point-to-area factor pinned down. Still open; it doesn't reopen #12. (High-flow gaugings at the
>    logger are question 2; the A-pan row and a station ET₀ record are
>    questions 6 and 7.)

> **Evaporation ([#13](https://github.com/Absence0760/project-water-management/issues/13), closed).**
>
> **Decided 2026-09-26: keep the workbook's A-pan row, and set GR4J's PE at
> the station-scaled ET₀ level.** The operator accepted the research's
> recommendation on the hydrologist's behalf (their agreement assumed, not
> yet written down by them); if the hydrologist later disagrees, reopen #13.
> The A-pan row isn't switched, so irrigation demand and dam evaporation
> don't move; GR4J's PE is set through its own monthly PE row with its
> source (#39, engine 0.31.0), not the pan coefficient. It is settled jointly
> with the rain level above (#12), and PE is carried at three levels (as
> is, station-scaled ET₀, the workbook's pan row × 0.70/0.75), refitted at each,
> with EWR and MAR reported as the band. `PAN_COEFFICIENT_PRESETS` stay as
> they are ([model.md §2.4a](./model.md#24a-rain-to-flow-gr4j-engine--050-issue-4)).
> Figures in the private repo's `Research/evaporation.md`.
>
> 6. **A-pan row:** where did the workbook's A-pan row come from (station,
>    years, screened pan or not), and has any conversion factor been applied
>    to it? Still open; it doesn't reopen #13.
> 7. **Station ET₀:** is there a multi-year station ET₀ record near the
>    catchment (ARC agro-climatic or provincial agriculture network), or a
>    daily pan record (usable directly since engine 0.38.0)? It is the most
>    useful single piece of evidence on the PE level, and on EWR now that
>    `kgeNp` has taken the rating out of it. Still open.


1. **Which model should the app be built on?** b023 is complete and in use;
   node-based modelling and a rainfall-runoff module would be new. Is the plan
   right: b023 first, then node-based features, then a runoff module as an
   alternative flow generator? Or should a node-based model *replace* b023?
2. ~~**"Upstream inflow above dam %" (Q1).**~~ **Answered (2026-09):** the
   percentage is the share of upstream inflow that enters the dam, as the label
   says; the workbook's formula was backwards. Fixed in engine 0.9.0
   ([model.md §3 Q1](./model.md#3-workbook-quirks-and-suspected-bugs)).
3. **Transfers (Q2, Q3).** The blank template draws one transfer from the
   *Spill* column instead of *Storage*. Could this be in other catchment
   workbooks? Should a transfer be limited by the receiver's free space, and
   should irrigation at the source come before a transfer, or the other way
   round? Are all real transfers of the form "from dam A to dam B, in these
   months, up to X m³/s, keep Y%"? If not, what other shapes do they take?
   *Built pending your answer (engine 0.16.0, audit N4/Q18): a transfer is
   capped at the receiver's room, rules run by priority, and transfers are
   settled before irrigation.*
4. **Per-farm EWR (Q4).** "Cumulative EWR" at a farm is only its own fragment.
   Should it add up the upstream fragments?
5. **Dam reserve (Q5).** *Built on a persona recommendation (engine 0.16.0),
   to confirm:* irrigation now stops at the dam's minimum operating level, and
   transfers keep the higher of their own minimum and that level. Which dams
   keep a reserve, and how much?
6. ~~**Pitman fallback (Q7).**~~ **Settled (2026-09-24):** the app has no
   Pitman input, so natural flow comes only from the rain model
   ([audit P1](./engine-audit.md)). Worth telling the hydrologist.
7. **Shortfalls report (Q11).** What do "target volume", "reduce/gain" and
   "volume left after irrigation balanced & EWR met" mean exactly? Which of
   these numbers do farmers actually see? *Interim (engine 0.17.0, persona
   recommendation):* the equitable share is labelled a fairness benchmark,
   "Not an allocation or licence condition".
8. **Pragmatic EWR (Q10).** Is entering the 12 monthly values enough, or must the
   app derive them from Desktop Reserve tables? *Built pending your answer
   (engine 0.21.0, hydrologist Q6): a Reserve rule table (12 months × % points)
   can be entered per EWR site beside the pragmatic EWR, and every run then
   reports monthly compliance with it ([model.md §2.9c](./model.md#29c-ewr-compliance-by-the-reserves-assurance-rules-engine--0210-hydrologist-q6)).
   The pragmatic EWR sets the daily charge and curtailment unless the project
   chooses the rule tables (engine 1.3.0).* See 17.
9. **Reference results.** Is the client catchment's current working workbook the version to
   match? Are there other catchments (B, C…) with workbooks we can use as test
   cases?
10. **Zero observed flows.** The workbook skips days where observed flow is
    zero when scoring the fit; the app keeps them. Real readings or gaps?
11. **Fit rating.** Moriasi thresholds were set for monthly flows. Rate daily
    fits against them, or also score monthly totals? *Decided (calibration
    research CR-6): daily fits carry no rating words; monthly scoring is the
    WR2012 five-statistic table, CR-28.*
12. **EWR "days not met".** Count days that were actually short (app default)
    or the workbook macro's running monthly total? (model.md §2.9)
    *With a Reserve rule table the headline is months met against it, and
    days not met is the secondary measure (engine 0.21.0).*
13. **Curtailment targets** (model.md §2.11, Q11–Q15): is reduce/gain a
    fairness target or a schedule farms can follow (a downstream surplus can't
    reach an upstream farm)? The column "Reduction of demand required (%)" is
    actually the share of demand *left* — which do you report? How does a cut
    apply to a farm with no irrigation? Should l/s truncate (hiding cuts under
    0.1 l/s)? *Interim (engine 0.17.0, persona recommendation, to confirm):*
    reduce/gain is shown as a fairness benchmark only; "Demand left %" is
    bounded 0–100 and blank under 1 m³/day; a farm with no demand gets no
    irrigation cut, its EWR charge shown as *store less / pass inflow*; the
    EWR shortfall is charged to upstream farms by net impact
    ([engine-audit.md](./engine-audit.md) Q13, Q17).
14. **Comparing runs.** Is a higher simulated outflow good or neutral, and a
    PBIAS closer to 0 better? Do you need per-farm series (e.g. the same
    farm's dam storage) overlaid across runs?
15. **Zero-rain runs (issue #2).** The catchment rain has long runs of
    zeros where CHIRPS recorded rain (details in the private source repo). From CR-20 the app fills them
    with bias-corrected CHIRPS by default. Are they missing data, or real
    dry spells? Are there other stretches (e.g. partial-record years that
    read far below CHIRPS) that should be treated as missing?
16. **Multi-day accumulations (issue #2).** Some readings look like several
    days' rain entered on the day the gauge was read, after days entered as
    0. From engine 0.20.0 the app
    spreads each such total back over the days it covers by CHIRPS
    ([model.md §2.4d](./model.md#24d-multi-day-rainfall-accumulations)).
    Do the station's records (observer logs, "accumulated" flags) say which
    readings are multi-day totals? Should a total that reads far below CHIRPS
    be scaled up for the catch an unread gauge loses, or treated as missing?
17. **Reserve rule tables (hydrologist Q6).** *Built from the literature
    (engine 0.21.0, model.md §2.9c), to confirm.* Which gazetted table applies
    at the outlet and at each EWR site (so which gauges to add), and is it the
    total flow or the low flows? Should a month's natural-flow percentile come
    from the run's own natural flow (the default) or the gazette's natural
    curve? Linear interpolation between % points (as built) or log
    interpolation? Below the driest point, should the requirement scale with
    the flow (as built) or hold at the drought flow? Is monthly compliance the
    measure the CMA wants, or % of time from daily flows as well? And should
    the daily EWR charge and curtailment follow the rule table's requirement
    instead of the pragmatic EWR? *Both ways are built (engine 1.3.0, issue
    #64, `settings.ewrChargeSource`, the pragmatic EWR by default).* Should a
    low-flow requirement be judged on the month's base flow rather than its
    volume, and with which filter parameter? *Built as an option
    (`settings.lowFlowMeasure`, Lyne–Hollick α 0.995, three passes, the volume
    by default; from engine 1.6.0 each month filtered over its own days and
    the two years before it, so later days never change a month's verdict;
    model.md §2.9d).*
18. **Uncertainty bands (issue #4 phase 9).** *Built to the assessor's
    criteria (engine 0.26.0, model.md §2.10e), defaults to confirm.* Is a
    parameter set behavioural at KGE′ ≥ 0.5 on the first half of the record,
    with a low-flow FDC bias within ±50 % and a WR2012 flag no worse than
    *query*? Is ±0.1 the right spread for the monthly pan coefficient, and is
    CHIRPS alone a fair second rain source for this catchment? Are 300
    Latin-hypercube members enough, and should the ensemble sample the typical
    or the wide bounds when the fit used wide ones? What coverage of the
    held-out half would the CMA accept (the app warns below 70 %)?
19. **Portfolio traffic lights (roadmap step 2, D11).** *Built as a team
    setting (055_team_settings), defaults to confirm.* A catchment shows green
    when its outlet EWR was not met on under 5 % of the last 30 days, amber
    under 20 %, red otherwise. Are 5 % and 20 % the right defaults for a WUA,
    and is "days not met over 30 days" the right measure (or months met
    against the Reserve rule table, see 17)? A team admin can already set
    other cut-offs on the team page; only the defaults' sign-off is open.
20. **Issue #54's configuration questions (2026-09-27).** Its
    questions, with the evidence and numbers behind each, are in the private
    source repo. Built for them, each set from assumed values until
    answered: an areal rainfall correction (model.md §2.4g), a GR4J fit at
    import (§2.10b) and a river off-take (engine 1.14.0, model.md §2.6a).
    In general terms:
    - **Rain:** which rain record and MAP should force the model?
    - **The gauge:** which flow record, if any, measures the modelled
      catchment?
    - **Evaporation:** is the A-pan row representative of the catchment?
    - **Off-takes:** where a dam is fed from the river, where does the
      off-take leave the river, what is its capacity or licence (by month
      if it varies), what hands-off flow or EWR condition applies, what are
      its losses, and does it run full or draw only what is ordered?

    **Answered by the client, 2026-09-28 (issue #90):**
    - **Default irrigation system:** drip (0.90, SABI 2021). New farms start
      on it; the engine keeps one SABI 2021 table (model.md § Irrigation
      efficiency, migration 099).
    - **Demand priority:** senior/junior is enough; a demand with both parts
      is two demand objects (model.md §2.7f).
    - **Demand sources:** meter records, else the reconciliation strategy's
      AADD, else population × litres per person per day, recording which
      (model.md §2.7f; a structured field is in followups.md).
    - **GIS:** open data only (Copernicus 30 m DEM, WR2012, other openly
      licensed layers), proposed by the app and confirmed by the modeller
      (planned-work.md § Catchment map).
    - **Restrictions and basic needs:** a 25 l/person/day domestic floor,
      DWS % cuts, municipal levels as an optional display. Agreed, not built
      (followups.md "Restrictions: the basic-needs floor").
    - **Afrikaans:** the client's native-speaker translator reviews the
      farmer text before farmers are invited in Afrikaans (followups.md
      § Afrikaans).

### Product

10. **Who uses it?** Only the hydrologist, or also farmers, catchment forums,
    the client's staff, or government? This decides what the UI needs (a simple farmer
    view against a full model editor) and who needs accounts.
11. **Accounts and roles.** Who needs an account at launch, and who should be
    owner, editor or viewer per catchment? Should anyone be able to register, or
    only by invitation?
12. **What does the result need to look like?** Charts, the Shortfalls table, a
    downloadable Excel sheet, a PDF report for meetings? Must the output look
    like the workbook's sheets?
13. **Excel round-trip.** Will the hydrologist keep working in Excel, so the app
    has to import updated workbooks again and again? Or does the app become the
    source of truth?
14. **Forecast and live data.** Should forecast rain or logger data be pulled in
    automatically, or will they be uploaded?

### Decision-support outputs (2026-09-26)

From the client's four sketched outputs; research and recommendations in
[design/planning-outputs.md](./design/planning-outputs.md), build in
[#53](https://github.com/Absence0760/project-water-management/issues/53).

- **O1. Risk cut-offs.** In the outcome matrix, what share of Reserve months
  met (or % of days below the EWR) counts as high risk, increasing risk,
  lower risk? *Built as project settings (`settings.outcomes`, Settings →
  Outcome matrix, issue #53 R4): the defaults (months met 90 % / 75 %, days
  below the EWR 5 % / 20 %). The client agreed to them (2026-09-28, issue
  #90); the hydrologist's confirmation is still open, so they stay marked
  pending the hydrologist, and a project can already set its own.*
- **O2. Year classes.** Split water years by the run's own natural-flow
  terciles (dry / normal / wet), or by fixed percentile years (25th, median,
  75th)? *Built as a project setting (`settings.outcomes.yearClassMethod`):
  automatic, terciles, quintiles once the record has 25 years, the default;
  terciles or quintiles can be fixed. Fixed percentile years would be a new
  method.* **Answered 2026-09-28 (issue #90):** the client confirmed the
  default (terciles, quintiles from 25 years).
- **O3. Decision and review dates.** On what date does the WUA set the
  season's irrigation level, and when does it review? *The decision date is
  built as a project setting (`settings.outlook.season`, Settings →
  Seasonal outlook, issue #53 R5): the season as a month and day each end,
  default 1 October – 30 April; the review date too
  (`settings.outlook.review`, R6), default the engine's
  `defaultReviewDate`, 1 January for that season.*
  **Answered 2026-09-28 (issue #90):** the client confirmed the season
  1 October – 30 April with a review on 1 January; the pending badges are
  gone.
- **O4. Restrictions per category.** Should the share-the-pain view cut
  domestic, industrial and irrigation users by different percentages (as DWS
  gazettes restrictions), and is a town's use domestic or irrigation?
  **Answered in part 2026-09-28 (issue #90):** every category is cut by the
  same %, the built rule (`ShareRule { kind: 'equal' }`). Still open to the
  client: whether the town's uses count as domestic or irrigation.
- **O5. Audience.** Is the seasonal outlook for the WUA only, or also for
  farmers on their phones (so in Afrikaans too)?
  **Answered 2026-09-28 (issue #90):** farmers too. *Built (issue #53 R5,
  E3): the WUA publishes the level it set, and each farm's page shows what
  that level gave the farm in past years' weather, in English and
  Afrikaans (ui.md § Farmer view).*
- **O6. Planning share.** The outlook reports the highest demand level that
  meets the EWR in a set share of past years. What share: 80 %? The app
  reports the trade-off; the WUA publishes the decision (disclaimer, D10).
  *Built as a project setting (`settings.outlook.planningShare`): default
  80 %; a project can set its own.* **Answered 2026-09-28 (issue #90):** the
  client confirmed 80 %; the pending badges are gone.

### Data, legal, hosting

15. **Cloud storage and POPIA.** May client data (farm names, dam sizes, crop
    areas, and possibly owners' names) be stored in AWS? Must it stay in South
    Africa (`af-south-1`)? Is any of it confidential between farms, for example
    one farm's abstraction hidden from its neighbours?
    *Hosting decided 2026-09-26 regardless of the answer: `af-south-1`, so
    the data stays in South Africa ([deployment-tiers.md § Where the data
    lives](./deployment-tiers.md#where-the-data-lives)). The confidentiality
    part is still open.*
16. **Domain (for information).** The app will live at
    `water-management.jaredhoward.com`. Tell the client this, and flag it early
    if they need a branded domain.
17. **Budget and support.** What is the expected monthly hosting budget, and
    who pays? Who supports the users? *Expected: ≈ $58–63/month on the
    minimal tier in af-south-1, ≈ $135–150 on the full (highly available)
    tier ([deployment-tiers.md](./deployment-tiers.md)); suggest passing it
    through in the hosting fee.*

---

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| **Hidden workbook behaviour** (VBA steps, rounding, freeze-to-values, hand-edited cells) means we can't match number for number | V1 can't be trusted | Regression tests on every column, stage by stage. Extract the workbook's *computed* columns and compare against those, not against our reading of the formulas. Document every mismatch in model.md §3. |
| **Workbook bugs**: fix them or copy them? | Results differ from what the client is used to | **Fix them** (operator decision, 2026-09; engine 0.4.0). Where the b023 algorithm is physically or numerically unsound the engine replaces it outright, with no workbook-compatible mode; policy and domain questions go to the hydrologist first. [engine-audit.md](./engine-audit.md) lists every deviation and its reason, the client catchment regression suite documents where and why results differ, and each run records the engine version so older results stay explainable. |
| **Client data in the cloud** (POPIA, confidentiality between farms) | Could block hosting, or force a region choice | Local-first V1. Ask question 15. `af-south-1`. Per-project RLS already isolates catchments. |
| **Scope creep**: three model families, pump scenarios, a runoff module | Nothing gets finished | The phases gate on client sign-off. The node-based and runoff features wait until the b023 port is accepted. |
| **VPC Lambda cold starts / DB connection limits** | Slow first request; too many connections from concurrent Lambdas | RDS stays warm. Small `pg` pool per Lambda (1–2). Reserved concurrency is capped. RDS Proxy only if connection counts become a problem. |
| **Run output volume** (up to ~25 MB/run) | DB growth and cost | Trim keys, cap the number of runs, float4. Runs can be recomputed deterministically. |
| **Lambda payload limits** (6 MB request/response) | Large imports or series downloads fail | One series per request. Imports for the client catchment are well under the limit. Use S3 presigned upload if a project goes over. |
| **Public repo**: a secret, workbook or real farm data is committed by accident | Leak of credentials or client data | gitleaks pre-commit and CI; `.gitignore` guards; synthetic-only fixtures; secrets only in `infra-secrets`. If it happens, rewrite history *before* pushing ([security.md](./security.md#incident-playbook)). |
| **Single developer / bus factor** | Stalls | Docs (this folder), tests as the spec, conventional commits. |
| **Stale SheetJS on npm** | Security advisories | The official CDN tarball (SheetJS CE 0.20.3), pinned with its integrity hash; bumped by hand, since Dependabot can't see a URL dependency. |
