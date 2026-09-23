# Roadmap: from local V1 to a fully working product

**Goal right now:** a **V1 that runs on a laptop**, used to show the client and
ask *"is this what you want?"*. We then iterate on their answers before building
more. Deploying comes later and is deliberately cheap, because nothing is
decided until the client has seen V1.

Decisions already made (the reasoning is in [architecture.md](./architecture.md)
and [data-model.md](./data-model.md)):

- **Hybrid model.** The data model is node-based and general. The first engine
  is a **faithful port of b023** that has to match the client catchment workbook
  number for number. The AI runoff module comes later as an *alternative flow
  generator*.
- **Multi-project, multi-user.** A user can have any number of projects
  (catchments A, B, C, … and more later). Access is set per project with the
  roles viewer, editor and owner, and **Postgres RLS enforces it**.
- **Local-first.** Postgres 17 runs in docker on `:5434`, and nothing needs a
  cloud account. AWS comes later.
- **One TypeScript engine** (`packages/engine`) is used by the browser (for
  instant what-if runs) and by the Lambda (for stored runs). A full client catchment
  run takes about 18 ms.
- Time series are stored as `double precision[]`, and run outputs as one array
  per series. Sessions use a JWT in an httpOnly cookie. Migrations are plain
  SQL. Charts use uPlot.
- **Excel import:** a Python extractor (`scripts/wbt-import`) turns a workbook
  into `project.json`. An in-browser importer (SheetJS) comes later.
- **The repo is public.** No secret, client workbook or client-derived data is
  ever committed. `Original/`, `AI/`, `data/` and `*.xlsm`/`*.xlsx` are
  gitignored, and committed fixtures are synthetic, with no real farm names or
  values. All production secrets are SOPS-encrypted in the private
  `Absence0760/infra-secrets` repo under `water-management/`
  ([security.md § Public repo hygiene](./security.md#public-repo-hygiene)).
- **Production URL: `water-management.jaredhoward.com`.** The slug is
  `water-management`, and the URL is a delegated child zone of `jaredhoward.com`
  ([Phase 6](#phase-6-deploy-to-aws)).

Status key: ✅ done · 🚧 in progress · ⬜ not started.

---

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
import client catchment, run the model and look at the results. They can also create
a second and third project (empty, or copied) side by side.

### 1a. Engine: port b023 ([model.md §2](./model.md#2-the-b023-model-what-v1-ports))

- ⬜ Natural flow from rain (§2.4): season state, base flow, recession index,
  pulse index, response flow, Pitman fallback. This needs the extra calibration
  settings: recession curve and factors, shift-peak indices, reset ratio, winter
  thresholds, amplitude, max days.
- ⬜ Net irrigation demand per day (§2.3), with the workbook's rounding.
- ⬜ Flow shares by the Area, Hi/Lo and Specific methods, plus fragmented flow
  and EWR (§2.5).
- ⬜ Farm balance in network order, with gauges (§2.7).
- ⬜ Transfers from structured rules (§2.6).
- ⬜ EWR check at the outflow gauge, per-farm summaries, and calibration stats
  (NSE, PBIAS, RMSE) against the observed series.
- ⬜ A `warnings[]` list: shares not summing to 1, missing series, gaps in rain,
  days that fell back to Pitman flow.

**Acceptance:** regression tests driven by fixtures extracted from client catchment
(under `data/`, gitignored, skipped when absent) match the workbook's columns
**exactly** for all 16 161 days: natural flow, net demand per farm, storage,
spill, outflow, deficit, EWR shortfall and simulated outflow. Committed
synthetic fixtures cover the same code paths on CI.

### 1b. Import

- 🚧 `scripts/wbt-import` (Python + openpyxl, read-only) extracts the network,
  farm spec, crops, crop areas, transfer parameters, calibration and pragmatic
  EWR from a b023 workbook. It also extracts the daily input series. The output
  is `data/<name>/project.json` (the `ProjectModel` + settings + series shape).
- 🚧 `pnpm import:project <project.json> --email …` creates a project from
  `project.json`, and `pnpm seed:demo` extracts and imports the local
  workbooks for a demo user. Still to come: an import action in the UI.
- ⬜ The importer reports whatever it could not map: hand-written transfer
  formulas that don't fit the rule shape, or a Specific method with no values.

**Acceptance:** importing client catchment gives a project whose run reproduces the
workbook (as in 1a) with **no manual edits**.

### 1c. Backend API ([api.md](./api.md))

- ⬜ Auth: register, login, logout, me (bcryptjs; jose HS256 in the `wm_session`
  httpOnly cookie).
- ⬜ Projects: CRUD plus copy. Members: list, add by email, change role, remove.
- ⬜ Model document: `GET`/`PUT` with tree validation. Series: list, get,
  upsert, delete. Runs: create (synchronous), list, get, fetch one series,
  delete.
- ⬜ Every project-scoped query runs in a transaction as `water_app` with
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
  `/auth/register`, `/auth/login`). API errors never include raw DB error text.

### 1d. Frontend

- ⬜ Sign in / register. A project list with role badges. Create, copy, delete.
- ⬜ Project workspace: **Network** (a tree view of farms and gauges, with an
  editable table of farm parameters), **Crops** (monthly factors, and an
  area-per-farm grid), **Transfers**, **Settings** (A-pan, effective rain, flow
  share method, calibration, pragmatic EWR, date window), **Data** (upload CSV
  series, show coverage and gaps).
- ⬜ **Run and results:** a run button, a run history, catchment charts (natural
  vs simulated vs observed flow, EWR line, days not met), per-farm charts
  (demand vs supplied, dam storage, spill), a Shortfalls table, and calibration
  stats. Charts use uPlot and handle 16k points without lag.
- ⬜ A browser-side instant preview: change a parameter and see the effect
  without saving, using the same engine.
- ⬜ Members page (owner only).
- ⬜ **Request sequencer** for list and series fetches, so that a slow, stale
  response can't overwrite a newer one when the user switches project or
  series quickly.
- ⬜ **e2e (Playwright)** under `e2e/`, running fully locally against docker
  Postgres and the dev servers. Pinned `timezoneId: 'UTC'`, and waits on real
  signals (no `networkidle`). The first spec is the demo path: register,
  create project, import, run, chart.
- ✅ `packageManager` is pinned (pnpm 10) in the root `package.json`.
- ⬜ Run date-sensitive unit tests under a skewed `TZ`, so that code which
  accidentally depends on local time fails.

**Phase 1 acceptance (the demo):**

- [ ] A fresh clone with `pnpm setup && pnpm dev` works with no other setup
      ([run-locally.md](./run-locally.md)).
- [ ] client catchment imported: its results match the workbook, the charts and
      Shortfalls table appear, and a run finishes in under 2 s including storage.
- [ ] Projects A, B, C exist side by side. Creating D and copying C both work.
- [ ] A second user sees nothing until they are invited. As a viewer they can't
      edit.
- [ ] `pnpm check`, `pnpm test` and `pnpm test:backend:db` pass.

---

## Phase 2: Client review and first iteration

**Goal:** show V1 to the client, get answers to the
[questions below](#questions-for-the-client), and change V1 accordingly.

- ⬜ A demo script: the client catchment walkthrough, one what-if (for example
  doubling one farm's dam, or switching a transfer off), and the Shortfalls
  table compared with the workbook side by side.
- ⬜ Record the answers here and in [model.md §3](./model.md#3-workbook-quirks-and-suspected-bugs).
- ⬜ For each quirk the hydrologist calls a bug, add a **corrected mode** as a
  project setting. The workbook-compatible mode stays available so old results
  can still be reproduced. Bump `ENGINE_VERSION`.
- ⬜ Fill in the rest of the Shortfalls report (target volume, reduce/gain,
  volume left after balancing) once the formulas are confirmed (Q11).
- ⬜ Export: CSV per series, and an Excel download of a run (a sheet per farm,
  like the element sheets).
- ⬜ UX fixes from the session.

**Acceptance:** the client confirms the model behaviour and the UI direction in
writing, or gives a ranked change list.

## Phase 3: Complete the b023 feature set

- ⬜ **Scenarios:** compare two runs or two projects (for example the baseline
  and "farm X's dam +50%"), with difference charts and a difference table.
- ⬜ **EWR tooling:** derive the pragmatic EWR from Desktop Reserve tables
  (percentile, scale factor, per-month overrides), as `[EWR Cfg]` does (Q10).
- ⬜ **Reports:** EWR analysis by farm × year × month, count and % of days not
  met, and annual water balance (observed vs simulated MAR per year).
- ⬜ **Calibration workbench:** plot observed vs simulated, adjust the rain→flow
  parameters with live NSE/PBIAS, and save a calibration version (the
  workbook's "Calibration" button and `[Log]`).
- ⬜ **In-browser Excel import** with SheetJS. Load it from its official CDN
  tarball, because the npm `xlsx` 0.18.5 is stale and has known advisories. The
  import then needs no Python.
- ⬜ An audit log per project: who changed what, and which run used which
  inputs. Add an input-series content hash to runs.

## Phase 4: Node-based extensions ([model.md §4](./model.md#4-the-ai-node-based-model-v004-dev))

- ⬜ Node types beyond farm/gauge: headwater, dam/bypass, run-of-river,
  confluence, natural. Add a migration for the new node attributes (pump
  capacity, trigger/stop %, pool storage, river abstraction fraction).
- ⬜ **Pump scenarios** per farm: Dam-first, River-first, Trigger-based and
  Run-of-river first. Then seasonal river-first, no river pumping,
  drought-saving and opportunistic. Groundwater last.
- ⬜ **Stress classes** (≥95 Low, ≥85 Moderate, ≥70 High, ≥50 Severe, else
  Critical) per farm and month, shown as a map or grid.
- ⬜ Naturalisation, done properly. The v004 version is circular: every farm
  shows 100% met.
- ⬜ A network diagram editor (drag and drop), if the client wants to build
  networks rather than import them.

## Phase 5: AI runoff module as an alternative flow generator ([model.md §5](./model.md#5-the-ai-runoff-module-dev-003))

- ⬜ Fix the water balance first: the 56% of effective rain that goes
  untracked, drainage that creates water, the unused `RainfallFactor`, and the
  hard-coded outlet node.
- ⬜ Hydrological units per project (area, MAP, reference gauge). Multiple rain
  stations.
- ⬜ A `flowGenerator` project setting: `b023-recession` (default) or
  `bucket-v1`. Both produce natural flow per node for the same farm balance.
- ⬜ Calibration metrics (NSE, PBIAS, KGE) and the annual water-balance table,
  as in the module's TODO list P1–P5.

**Acceptance:** the hydrologist accepts the bucket model's calibration for at
least one catchment, **and** its water balance closes to within a tolerance
that the tests assert.

---

## Phase 6: Deploy to AWS

Do this after Phase 2, once the client wants other people to use it. The
mechanics are in [deployment.md](./deployment.md). What has to be built or
decided:

### 6a. Account, domain, secrets

Decided: slug **`water-management`**, URL **`https://water-management.jaredhoward.com`**.

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
- ⬜ **Lambda runtime `nodejs24.x`** (the repo moves to Node 24). Timeout ~30 s
  for runs and memory ~1024 MB (engine plus large JSON). Reserved concurrency
  stays capped.
- ⬜ CloudFront already proxies same-origin `/api/*` to the Function URL with a
  shared-secret header. Keep that, so the session cookie is first-party and
  `SameSite=Lax` works. Tighten or drop the Function URL CORS block, since the
  browser never calls the Function URL directly.
- ⬜ Budget and alarms: DB CPU, free storage and connections, plus Lambda
  errors and duration. Budget $25–50/month.

### 6c. CI/CD

- 🚧 CI (`.github/workflows/ci.yml`) runs on PRs and on `main`, including the
  DB tests against a Postgres service container. Once the account exists, make
  `CI gate` a required check.
- ⬜ Deploy workflows: turn on the release trigger. Add a **migrate** step
  (a one-off Lambda invocation or a CI job with DB access) that runs before the
  new code is published. All of this is gated on `environment: production`.
- ⬜ `~/github/templates/scripts/export-tf-vars.sh infra/` to push Terraform
  outputs into GitHub variables and secrets.

**Acceptance:** `gh release create v0.x` deploys after the reviewer approves.
The site is served at the chosen domain over HTTPS, a smoke test (register,
import, run) passes against production, and a restore from backup has been
rehearsed once.

## Phase 7: Production hardening

- ⬜ **Accounts:** password reset and email verification (SES), and invitations
  by email for people without an account yet (today the invitee must register
  first).
- ⬜ **Abuse limits:** **per-account login lockout** (back off after N failed
  attempts per email, stored in the DB so it holds across Lambda instances),
  plus a per-IP limit on register. This adds to the WAF rate rule at the edge.
- ⬜ **Session revocation watermark:** `app_user.sessions_revoked_at`. A JWT
  whose `iat` is older than the watermark is rejected. "Sign out everywhere",
  a password change and an admin lock all set it. That gives revocation
  without a session table.
- ⬜ **Data protection (POPIA):** a privacy notice, data export and account
  deletion, a retention policy for runs, and a sub-processor list (AWS). Run
  `/audit/gdpr`, `/audit/account-deletion-completeness` and
  `/audit/data-export-completeness`.
- ⬜ **Run storage:** trim output keys, cap the number of runs kept, and
  consider float4 ([data-model.md](./data-model.md#time-series-storage)).
- ⬜ Background runs if some run ever exceeds the Lambda timeout (for example
  many scenarios at once). SQS + a worker Lambda, with a status on
  `model_run`.
- ⬜ **Accessibility (WCAG 2.2 AA):** axe checks in the Playwright specs for
  every page, a 320 px-wide reflow check (no horizontal scroll except inside
  the chart and grid scrollers), and a contrast test over the design tokens
  (every text/background pair ≥ 4.5:1, UI ≥ 3:1).
- ⬜ **CSP:** a Content-Security-Policy through a CloudFront response-headers
  policy. SvelteKit's static build needs `'unsafe-inline'` for its bootstrap
  script unless hashes are generated. This is accepted as a documented risk
  ([security.md](./security.md#known-gaps-tracked-in-planmd)); revisit with
  hash-based CSP.
- ⬜ A user guide written for hydrologists and farmers' associations.
- ⬜ `/audit/all`, `/release-readiness` before a 1.0 tag.

---

## Questions for the client

Take these to the V1 demo. Answers go in this section (dated) and, for model
questions, in [model.md §3](./model.md#3-workbook-quirks-and-suspected-bugs).

### Model and hydrology (for the hydrologist)

1. **Which model should the app be built on?** b023 is complete and in use. The
   node-based v004 and the runoff module are unfinished experiments. Is the plan
   right: b023 first, then node-based features, then the runoff module as an
   alternative flow generator? Or is one of the AI workbooks meant to *replace*
   b023?
2. **"Upstream inflow above dam %" (Q1).** The formula sends `inflow × pct`
   *below* the dam. client catchment has 100% for 10 farms, which means that no
   upstream water reaches those dams except through the diversion capacity. The
   `[Models]` sheet says a stand-alone dam should be 100%. Which is intended? If
   the formula is wrong, client catchment's results change.
3. **Transfers (Q2, Q3).** The blank template draws one transfer from the
   *Spill* column instead of *Storage*. Could this be in other catchment
   workbooks? Should a transfer be limited by the receiver's free space, and
   should irrigation at the source come before a transfer, or the other way
   round? Are all real transfers of the form "from dam A to dam B, in these
   months, up to X m³/s, keep Y%"? If not, what other shapes do they take?
4. **Per-farm EWR (Q4).** "Cumulative EWR" at a farm is only its own fragment.
   Should it add up the upstream fragments?
5. **Dam reserve (Q5).** Should irrigation also stop at the minimum dam level,
   or only transfers?
6. **Pitman fallback (Q7).** When the rain model gives zero, natural flow falls
   back to Pitman flow. Is that intended, or only for days with no rain data?
7. **Shortfalls report (Q11).** What do "target volume", "reduce/gain" and
   "volume left after irrigation balanced & EWR met" mean exactly? Which of
   these numbers do farmers actually see?
8. **Pragmatic EWR (Q10).** Is entering the 12 monthly values enough, or must the
   app derive them from Desktop Reserve tables?
9. **Reference results.** Is the client catchment "WORKING 007" workbook the version to
   match? Are there other catchments (B, C…) with workbooks we can use as test
   cases?

### Product

10. **Who uses it?** Only the hydrologist, or also farmers, catchment forums,
    FRC staff, or government? This decides what the UI needs (a simple farmer
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

### Data, legal, hosting

15. **Licence and IP.** The workbook says the model architecture is © FRC and
    the code and formulas are © SmartMatix, and it allows modification "within
    the licensed organisation". Is a web reimplementation allowed? **This repo
    is public**, so the ported formulas become publicly readable. Is that
    acceptable, or must the engine live in a private repo? Who owns the app and
    its code? Do SmartMatix and FRC need to agree?
16. **Cloud storage and POPIA.** May client data (farm names, dam sizes, crop
    areas, and possibly owners' names) be stored in AWS? Must it stay in South
    Africa (`af-south-1`)? Is any of it confidential between farms, for example
    one farm's abstraction hidden from its neighbours?
17. **Domain (for information).** The app will live at
    `water-management.jaredhoward.com`. Tell the client this, and flag it early
    if they need a branded domain.
18. **Budget and support.** What is the expected monthly hosting budget, and
    who pays? Who supports the users?

---

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| **Hidden workbook behaviour** (VBA steps, rounding, freeze-to-values, hand-edited cells) means we can't match number for number | V1 can't be trusted | Regression tests on every column, stage by stage. Extract the workbook's *computed* columns and compare against those, not against our reading of the formulas. Document every mismatch in model.md §3. |
| **Workbook bugs**: fix them or copy them? | Results differ from what the client is used to | Workbook-compatible mode by default. Corrected modes are opt-in per project and recorded in the engine version. |
| **Licence / IP** (FRC and SmartMatix) | Could block any use beyond a demo | Ask first (question 15), before investing past Phase 2. |
| **Client data in the cloud** (POPIA, confidentiality between farms) | Could block hosting, or force a region choice | Local-first V1. Ask question 16. `af-south-1`. Per-project RLS already isolates catchments. |
| **Scope creep**: three model families, pump scenarios, AI runoff | Nothing gets finished | The phases gate on client sign-off. The node-based and runoff features wait until the b023 port is accepted. |
| **VPC Lambda cold starts / DB connection limits** | Slow first request; too many connections from concurrent Lambdas | RDS stays warm. Small `pg` pool per Lambda (1–2). Reserved concurrency is capped. RDS Proxy only if connection counts become a problem. |
| **Run output volume** (up to ~25 MB/run) | DB growth and cost | Trim keys, cap the number of runs, float4. Runs can be recomputed deterministically. |
| **Lambda payload limits** (6 MB request/response) | Large imports or series downloads fail | One series per request. Imports are ~2 MB for client catchment. Use S3 presigned upload if a project goes over. |
| **Public repo**: a secret, workbook or real farm data is committed by accident | Leak of credentials or client data | gitleaks pre-commit and CI; `.gitignore` guards; synthetic-only fixtures; secrets only in `infra-secrets`. If it happens, rewrite history *before* pushing ([security.md](./security.md#incident-playbook)). |
| **Public repo exposes the ported model** (FRC/SmartMatix IP) | Licence breach | Question 15 before the engine port is pushed publicly. The fallback is making the repo, or just `packages/engine`, private. |
| **Single developer / bus factor** | Stalls | Docs (this folder), tests as the spec, conventional commits. |
| **Stale SheetJS on npm** | Security advisories | Use the official CDN tarball when the in-browser importer lands. The Python importer covers V1. |
