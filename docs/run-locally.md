# Running locally

Everything runs on a laptop with no cloud account: Postgres and Mailpit in
docker, the API on Node, and the site on Vite.

## Prerequisites

- **Node.js 24** (`.tool-versions`; `node --version`). On this workstation it
  comes from nvm.
- **pnpm 10** via Corepack (`corepack enable`). Don't `npm install -g` it.
- **Docker** with the compose plugin (`docker compose version`).
- *(Only for importing workbooks)* **Python 3.14** with `openpyxl` in a virtual
  environment.
- `psql` (optional) for `pnpm dev:db:psql`.

## One-time setup

```bash
pnpm setup
```

This runs `pnpm install`, then `pnpm dev:db:up` (Postgres 17 on
**127.0.0.1:5434**, waiting until it is healthy), then `pnpm dev:db:migrate`,
then `pnpm dev:mail:up` (Mailpit, see [Email](#email)), then `pnpm dev:s3:up`
(MinIO, for report PDFs, see [Reports](#reports)).
On first boot of the empty volume, `dev/postgres/00-roles.sql` creates the
`water_app` login role and the `water_test` database. The migrations then
create the schema.

No env files to write. `backend/.env.development` and
`frontend/.env.development` are committed and hold only throwaway local values:

| Variable | Local value | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://water_app:water_app@127.0.0.1:5434/water` | The runtime connection, bound by RLS |
| `MIGRATION_DATABASE_URL` | `postgresql://water:water@127.0.0.1:5434/water` | Schema owner, used for migrations |
| `AUTH_JWT_SECRET` | a dev-only string (≥ 32 chars) | Signs session cookies. Production uses a real secret. |
| `ALLOWED_ORIGINS` | `http://localhost:7777` | CORS allow-list (with credentials) |
| `COOKIE_SECURE` | `false` | Session cookie `Secure` flag; local dev is plain http. Unset (Secure on) when deployed. |
| `CLOUDFRONT_SHARED_SECRET` | empty | Empty turns the CloudFront header check off locally |
| `SITE_URL` | `http://localhost:7777` | Base of the links in emails |
| `PORT` | `3001` | Local dev server port; the backend respects it |
| `COOKIE_SECURE` | `false` | Session cookie `Secure` flag; off for local http, unset (on) in every deployed environment |
| `MAIL_TRANSPORT` | `smtp` | `smtp` → Mailpit locally; `log` prints emails to the console; `ses` in production |
| `SMTP_HOST` / `SMTP_PORT` | `127.0.0.1` / `1026` | Mailpit's SMTP port |
| `MAIL_FROM` | `Water Management <no-reply@localhost>` | Sender |
| `RUNS_KEPT_PER_PROJECT` | `20` | Runs kept per project; each new run deletes the oldest beyond it (default 20 when unset or invalid) |
| `JOB_TRANSPORT` | `inprocess` | How the job worker is woken: `inprocess` (the local worker polls and LISTENs), `memory` (tests), `sqs` (production). See [Background jobs](#background-jobs) |
| `JOB_POLL_SECONDS` | `15` | How often the local worker looks for due jobs without a wake-up |
| `REPORT_RENDERER` | `inline` | Where a report PDF is printed: `inline` (the worker's own headless Chromium), `sqs` (production's renderer Lambda). See [Reports](#reports) |
| `RENDER_SITE_URL` / `RENDER_API_URL` | `http://localhost:7777` / `http://localhost:3001` | The site the renderer opens, and the API it signs in to |
| `STORAGE` | `local` | Where PDFs go: `local` = MinIO from docker-compose; `s3` in production |
| `REPORTS_BUCKET` / `S3_ENDPOINT` | `water-reports` / `http://127.0.0.1:9002` | The bucket (created on first use) and MinIO's API |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | `minioadmin` / `minioadmin` | MinIO's documented default login, for the local container only (`pnpm check:env` holds them to it) |
| `PUBLIC_API_URL` (frontend) | `http://localhost:3001` | `/api` in production |

To override something on your machine, create a gitignored
`.env.development.local` next to the committed file. It wins.

## Run the app

```bash
pnpm dev
```

- **Frontend:** http://localhost:7777
- **Backend:** http://localhost:3001 (`GET /health` → `{ "ok": true }`)
- The backend applies any pending migrations every time it starts or restarts
  (`backend/scripts/dev-server.ts` under `tsx watch`, which also watches `backend/migrations/`).
  So a database set up before a new migration landed, or a `git pull` that adds one while
  `pnpm dev` is running, catches up instead of failing requests with a 500.

Register an account on the site. The first user needs no invitation, and each
user starts with no projects.

## Example catchments

```bash
pnpm seed:examples          # needs dev:db:up; about 10 s
```

This loads three invented catchments, each with one run (published by its
owner, WP-2.3; Sandspruit's with an advisory notice in English and
Afrikaans), for two local demo
users: `demo@example.com` and `analyst@example.com`, password `demo-password`
(they exist only in your docker Postgres). The team "Demo Catchment
Consultants" (demo is admin, analyst a member) owns Kleinberg and Droëvlei;
analyst owns Sandspruit and shares it with demo as a viewer. Two demo
**farmers** (WP-2.1) see only their own farms: `farmer1@example.com` is linked
to Vaalbank (Sandspruit), `farmer2@example.com` to Rietspruit (Sandspruit) and
Kareebos (Droëvlei), same password; each reads their farm's published
figures through `GET /projects/:id/farm/:nodeId` (the farm page is
WP-2.6's). To try a **share link** (WP-2.3 phase 2), sign in as the owner
(analyst@ for Sandspruit, demo@ for the team's catchments), make one on the
Overview's Share links panel and open it in a private window; none is seeded,
since the URL is shown only when it is made. Every name and
number is synthetic, so the examples are committed
(`backend/scripts/examples/`) and work on any clone. Re-seeding gives the same
projects. Between them they show every feature of the current engine:

| Example | What it shows |
| --- | --- |
| **Kleinberg** (winter rainfall) | A branching network with four fruit farms on drip and micro irrigation. Two winter transfers leave the upper dam by priority. The rain gauge has a blank spell, a logger fault exported as zeros (a flagged zero-rain run) and a fortnight entered as 0 mm (a listed missing period). Bias-corrected CHIRPS fills all three. The weir drowned in the 2013/14 floods, so that water year is excluded from calibration, and its flat top shows in the data checks. A GR4J fit is stored (**Settings → Fit record**), with split-sample and dry → wet validation. |
| **Droëvlei** (water-stressed) | Farms run short and the EWR is often missed. It has sprinkler, flood and micro irrigation, shallow dams (one a leaky earth dam with seepage), a smaller soil-water store and a higher dam evaporation factor. The curtailment report covers the last four water years. A logger beside the weir drifted high in 2020/21, and the gauge-vs-logger check flags that year. |
| **Sandspruit** (summer rainfall) | A bigger tree with a mid-catchment gauge and maize under centre pivots. Three transfers: two of equal priority share one dam pro rata, and one has a daily cap. Calibration is scored over a window. It also has a gauge on a neighbouring river as a reference series, a 10-day forecast that extends the run past the record, and a WR2012-style reference: the run notes that its natural flow is 11 % below it. |

Every dam has a surveyed full-supply area, so dam evaporation and rain on the
dam are not estimated. The only run warnings are the ones each example is built
to show (the CHIRPS and zero-rain infill, the drowned weir, the logger, the
WR2012 note), plus the plausibility check on Droëvlei (2015/16) and
Sandspruit (2014/15 and 2015/16), where the fitted GR4J falls more than 10 %
short of the invented weir record's volume (model.md §2.10d). `backend/scripts/examples/catchments.test.ts` fails if any other
warning appears, if a self-check fails, or if an example stops parsing as a
project document. So an engine or schema change that leaves the examples
behind shows up in `pnpm test`.

## Email

Every email the backend sends locally (confirm your address, password reset,
invitations) is caught by **Mailpit** in docker — nothing leaves the laptop:

```bash
pnpm dev:mail:up            # start Mailpit (SMTP 127.0.0.1:1026)
pnpm dev:mail:open          # open the inbox at http://localhost:8026
pnpm dev:mail:status | dev:mail:logs | dev:mail:down
```

It listens on 1026/8026 rather than Mailpit's default 1025/8025 so it can run
beside other projects' Mailpit. To try the flows: register (a "Confirm your
email" message arrives), use "Forgot password?" on the sign-in page, or add an
address with no account to a project's members (an invitation arrives with a
`/register?invite=…` link).

Without Mailpit running, sending fails with a logged error and the request
still succeeds. If you'd rather not run it at all, put `MAIL_TRANSPORT=log` in
`backend/.env.development.local` and the emails (links included) are printed
to the backend console instead. The DB tests use an in-memory transport and
the e2e stack uses `log`, so neither needs Mailpit.

## Background jobs

Some work runs later, in a worker, instead of inside a request: a queued
model run (`POST /projects/:id/jobs`) and the data feeds (below), and in step
2 automatic re-runs and alerts ([architecture.md § Background work](./architecture.md#background-work)).
Locally the worker is one Node process against the same Postgres, with no AWS
and no queue emulator (`JOB_TRANSPORT=inprocess`, the default). It is opt-in:

```bash
pnpm dev:full               # pnpm dev + the worker, all three in one terminal
pnpm dev:run:worker         # the worker on its own, beside a running pnpm dev
pnpm dev:jobs:tick          # run every due job once, print what happened, exit
```

The worker ticks every `JOB_POLL_SECONDS` (15) and straight away when a job
is queued (the job table's insert trigger NOTIFYs `job_queued`). Each job runs
as the user who queued it, so a job fails (and says why) if that user has
since lost the role. Without the worker, jobs just wait in the table: the
project's `GET /projects/:id/jobs` shows them `queued`, and the next tick runs
them. Stopping the worker mid-job is safe: the job is claimed again once its
lease (`JOB_LEASE_SECONDS`, 6 minutes) runs out.

## Data feeds

Settings → **Data feeds** attaches CHIRPS rainfall, the CHIRPS-GEFS forecast
or a DWS gauge to a project ([architecture.md § Data feeds](./architecture.md#data-feeds)).
Locally they need **no network**: `FEED_SOURCE=fixtures` (the default)
answers every source from the synthetic files in `backend/fixtures/feeds/`,
re-dated to today, and the panel shows a "Sample data" badge. The sample grid
is invented: use a cell inside latitude −20.00 to −20.30, longitude 25.00 to
25.40 (e.g. `-20.12, 25.17`; `-20.27, 25.37` is its "sea", to see a failing
feed), and any river-gauge (H) code for DWS (e.g. `X0H000`).

Feeds run on the job worker, so with the worker running (`pnpm dev:full`)
they fetch daily on their own, and "Run now" fetches at once. Without it:

```bash
pnpm dev:feeds:run          # one tick that queues EVERY enabled feed, due or not, runs them, exits
pnpm dev:jobs:tick          # one tick: only the feeds that are due (and any other due job)
```

To try the real sources from your machine, put `FEED_SOURCE=live` in a
gitignored `backend/.env.development.local` and use real coordinates. CHIRPS
and the forecast are public; the DWS site may refuse requests from outside
South Africa (HTTP 403), which the feed shows as failing.

## Ingest

A logger gateway or a script pushes readings to `POST
/ingest/v1/series/merge` with a per-project API key
([api.md § Ingest](./api.md#ingest)). Locally, the push script stands in for
the gateway:

1. Sign in as a project's owner, open Settings → **API keys**, make a key
   and copy it (it is shown once).
2. Put it in a gitignored `.env.development.local` at the repo root:
   `WM_INGEST_KEY=wm_…` (or export it). `WM_API_URL` picks another API
   (default `http://localhost:3001`).
3. Push the synthetic logger CSV (`scripts/ingest/fixture.csv`, re-dated so
   its last day is yesterday):

```bash
pnpm dev:ingest:push                                   # into flow_logger_m3s “Logger”
pnpm dev:ingest:push --kind rain_catchment_mm --name Weir --unit mm --file my.csv --keep-dates
```

The series appears on the Data tab, and History shows the merge by
`API key “<name>”`. Nothing sensitive is committed: the key lives only in
your gitignored file.

## Reports

The report page's **Generate PDF / Email me the PDF** and Settings →
**Scheduled reports** make the PDF on the server
([architecture.md § Server-side reports](./architecture.md#server-side-reports)).
Locally that needs no AWS account, just three local pieces:

```bash
pnpm dev:s3:up              # MinIO: the PDFs (API :9002, console http://localhost:9003, minioadmin / minioadmin)
pnpm dev:mail:up            # Mailpit: the emailed links (http://localhost:8026)
pnpm test:e2e:install       # once: the Chromium the worker prints with (Playwright's, shared with e2e)
pnpm dev:full               # the app + the worker, which renders
```

The worker renders in-process (`REPORT_RENDERER=inline`): it opens the dev
site's report route (`RENDER_SITE_URL`, `:7777`) in headless Chromium, signs in
with a single-use render token through the dev API (`RENDER_API_URL`,
`:3001`), waits for the page to be ready, prints it to A4 and stores it in
MinIO (`STORAGE=local`; the `water-reports` bucket is created on first use).
All of that is in the committed `backend/.env.development`. The largest
example catchment (Sandspruit, 14 pages) renders in about 3 s. Without the
worker running a PDF stays "queued"; `pnpm dev:jobs:tick` renders it once.
Scheduled reports are queued by the worker's tick when their time comes (a
schedule never sends for a time that had passed when it was saved).

## Import the client catchment (demo data)

The client workbooks live outside the repo in `../project-water-management-source/Original/` (never committed). The
quickest route is the demo seed. It runs `seed:examples`, extracts the client
workbook into `data/` (also gitignored), then imports it as a project with one
run for the local demo user (details in `scripts/wbt-import/README.md`):

```bash
python3 -m venv .venv && .venv/bin/pip install openpyxl
PYTHON=.venv/bin/python pnpm seed:demo
```

The seed picks the one b023 workbook in `Original/` that isn't `Blank_*`. If
there are several, set `WBT_CLIENT_WORKBOOK=/path/to/workbook.xlsm`. The
workbook's file name names the client, so it never appears in the repo.

The client workbook's gauge column is a neighbouring river's gauge, so the seed
imports it as a reference gauge (`--gauge-as-reference`, into
`data/client-catchment-app/`) rather than as observed flow. To undo the
column's partial area scaling, put the two values in
`../project-water-management-source/wbt-import.env` (outside the repo, because
they are client data):

```bash
WBT_GAUGE_SCALING_FROM=YYYY-MM-DD
WBT_GAUGE_SCALE_FACTOR=F
```

Details are in `scripts/wbt-import/README.md`.

Then sign in at http://localhost:7777 as `demo@example.com` / `demo-password`.
These are local-only values: the user exists only in your docker Postgres.

To do the steps by hand, or to import another workbook for your own account:

```bash
.venv/bin/python scripts/wbt-import/extract_project.py "../project-water-management-source/Original/<client workbook>.xlsm" data/client-catchment
pnpm import:project "$PWD/data/client-catchment/project.json" --email you@example.com --name "Client Catchment"
```

This writes `data/client-catchment/project.json` (settings, model, input series) and
`data/client-catchment/expected.json` (the workbook's own results, used by the
engine's regression test). The workbook must have been calculated and saved in
Excel, because the importer reads cached values. Options are documented at the
top of each script in `scripts/wbt-import/`. `import:project` creates the
project for an existing user (`--password` also creates the user; local demo
only; `--run` also stores one model run). Open the project, press **Run**, and compare the Shortfalls table with the workbook's
`[Shortfalls]` sheet.

A project downloaded from the app (**Download project (JSON)** on its
Overview, i.e. `GET /projects/:id/export.json`) has the same shape, so
`pnpm import:project <downloaded>.json --email …` copies it into another
installation ([api.md § Export](./api.md#export)).

**Or import in the UI**, with no script and into any account: on the project
list, choose **Import project file (.json)**, pick the `project.json` (from
the workbook importer or a download), check the preview (name, team, what's
in the file), tick *Run the model after importing* if you like, and import.
It's the same code path as `import:project` (`POST /projects/import`,
[api.md § Import a project file](./api.md#import-a-project-file)), and it's
how a catchment gets into production ([deployment.md](./deployment.md#getting-a-catchment-into-production)).

**Or import the workbook itself in the UI**, with no Python at all: choose
**Import b023 workbook** on the project list and pick the `.xlsm` (or
`.xlsx`). It's read in the browser, in a Web Worker, with progress per sheet
and Cancel; then the review shows what's in it, the importer's notes (with
warnings marked), the **unmapped report** (what couldn't be carried across as
the workbook meant, with sheet, cell and element), and, if the workbook has a
gauge column, the gauge-as-reference option with its optional scaling date
and factor (the same as the Python's `--gauge-as-reference`,
`--gauge-scaling-from` and `--gauge-scale-factor`). Import, optionally with a
first run, and open the project. The TypeScript and Python importers give the
same `project.json` for the same workbook and options
([scripts/wbt-import/README.md](../scripts/wbt-import/README.md#the-typescript-port-in-browser-import)).
The client workbook reads in a couple of seconds.

The 87 MB workbook takes a minute or so to read with the Python script. It uses
openpyxl's read-only mode, so memory stays bounded.

## Multiple projects and teams

Each catchment is its own project. Create "Place A", "Place B" and "Place C"
from the project list. **Copy** duplicates a project's model and input series
(not its runs), which is the quickest way to start a what-if variant.

The project list groups projects by owner: **Personal**, one group per team
you're in, and **Shared with me** (projects shared with you directly). Filter by
owner, search by name/description/team and sort by last update or name; the
filters live in the URL (`/?owner=team:<id>&q=…&sort=name`), so Back and shared
links keep them. `/?new=1` opens the New project dialog. Each row shows how
far its data reaches, when it last ran and, once a run is published (Runs
tab), "published <date>".

**Teams** (header → Teams, `/teams`) own catchments together: team admins are
owners of every team project, members are editors and viewers are read-only.
Create a team, add colleagues by the email they registered with, and pick the
team when creating a project, or move an existing one from its Overview tab
(owners only). The Overview tab also shows a setup checklist (network → crops
& areas → rainfall and flow data → evaporation/EWR settings → run) that ticks
off as the catchment is filled in.

With the seeded demo data, `demo@example.com` is admin of the team "Demo
Catchment Consultants" and `analyst@example.com` is a member.

## Running pieces individually

```bash
pnpm dev:run:frontend       # frontend only
pnpm dev:run:backend        # backend only
pnpm dev:run:worker         # background-job worker only (see Background jobs)
pnpm dev:jobs:tick          # one job tick, then exit
pnpm dev:feeds:run          # fetch every enabled data feed once (fixtures by default), then exit
pnpm dev:db:status          # is Postgres up?
pnpm dev:db:logs            # follow Postgres logs
pnpm dev:db:psql            # psql as the owner role
pnpm dev:db:down            # stop Postgres (data is kept in the docker volume)
pnpm dev:db:reset           # DELETE all local data, recreate and migrate
```

## Checks and tests

```bash
pnpm check                  # typecheck all workspaces
pnpm test                   # unit tests (engine, frontend, backend) with no DB
pnpm test:backend:db        # API + RLS tests and catalogue guards (water_test DB; water_test_w<n> in a worktree); reports/render.db.test.ts renders a real PDF when MinIO is up, and skips (saying so) when it isn't
pnpm test:e2e               # Playwright end-to-end (own water_e2e DB, servers on :3101/:7801; per-worktree slot elsewhere; server-report.spec.ts needs dev:s3:up + dev:mail:up)
pnpm test:engine            # engine only; client catchment regression tests run when the data/ fixtures exist
```

The client catchment regression data comes from the import step above
(`expected.json`) and from the extractors in `scripts/wbt-import/`, all written
under `data/`. Without them, the
workbook-comparison tests skip with a message, and the committed synthetic
fixtures still run.

## Building

```bash
pnpm build                  # frontend/build (static) + backend/dist/lambda.mjs
```

## Common issues

**`pnpm dev:db:up` fails: port 5434 in use**
: Another container or Postgres is on 5434. Stop it, or change the published
  port in `docker-compose.yml` together with both URLs in a local
  `backend/.env.development.local`.

**`password authentication failed for user "water_app"`**
: The docker volume was created before `dev/postgres/00-roles.sql` existed (the
  init scripts only run on an empty volume). Run `pnpm dev:db:reset`.

**Everything returns 404 for a project that exists**
: Working as intended. Under RLS, a project you are not a member of is
  invisible. Sign in as a member, or have an owner add you.

**Session lost on every request / CORS errors**
: `ALLOWED_ORIGINS` must include `http://localhost:7777` exactly, and the
  frontend must call the API with `credentials: 'include'`.

**No email arrives in Mailpit**
: Check `pnpm dev:mail:status`, and the backend console for `email "…" failed:
  connect ECONNREFUSED 127.0.0.1:1026` (Mailpit isn't up). Reset and
  verification emails go out at most once a minute per address, so a quick
  second request is silently skipped.

**A PDF stays "queued", or fails**
: The worker isn't running (`pnpm dev:full` or `pnpm dev:jobs:tick`). "The PDF
  could not be stored" means MinIO isn't up (`pnpm dev:s3:status`, then
  `pnpm dev:s3:up`). "The report could not be rendered (the browser failed)"
  usually means Playwright's Chromium isn't installed
  (`pnpm test:e2e:install`). The worker's console has the details.

**Port 7777 or 3001 already in use**
: The frontend port is fixed at 7777. The backend respects `PORT`.

## Next step

When the client wants to use it online, see [deployment.md](./deployment.md)
and [plan.md Phase 6](./plan.md#phase-6-deploy-to-aws).
