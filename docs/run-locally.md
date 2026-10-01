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
(MinIO, for report PDFs and evidence packs' reproduction bundles, see
[Reports](#reports)).
On first boot of the empty volume, `dev/postgres/00-roles.sql` creates the
`water_app` login role and the `water_test` database. The migrations then
create the schema.

No env files to write. `backend/.env.development` and
`frontend/.env.development` are committed and hold only throwaway local values:

| Variable | Local value | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://water_app:water_app@127.0.0.1:5434/water` | The runtime connection, bound by RLS |
| `MIGRATION_DATABASE_URL` | `postgresql://water:water@127.0.0.1:5434/water` | Schema owner, used for migrations |

In a git worktree both URLs point at that worktree's own dev database,
`water_w<n>` (see below), not `water`.
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
| `PACKS_BUCKET` | `water-packs` | Issued evidence packs' files: the reproduction bundle, stored when a pack is issued (created on first use; [evidence-pack.md § Reproduction](./evidence-pack.md#reproduction)) |
| `REPORT_DOWNLOADS` | `presigned` | How the download route signs a PDF link: `presigned` = a 60 s MinIO GET; production uses `cloudfront` (a CloudFront signed URL on the site's `/reports/*`, with `CLOUDFRONT_KEY_PAIR_ID` / `CLOUDFRONT_PUBLIC_KEY` from Terraform and `CLOUDFRONT_PRIVATE_KEY` from sops; security.md § Reports) |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | `minioadmin` / `minioadmin` | MinIO's documented default login, for the local container only (`pnpm check:env` holds them to it) |
| `ALERTS_TOKEN_SECRET` | a dev-only string (≥ 32 chars) | Signs alert emails' unsubscribe links (the worker). Production gets a random one from Terraform. See [Alerts](#alerts) |
| `API_PUBLIC_URL` | `http://localhost:3001` | Where a mail client posts an alert's one-click unsubscribe (production: `SITE_URL/api`, the default) |
| `ALERTS_ENABLED` / `ALERTS_DAILY_CAP` | `true` / `5` | The alert kill switch, and immediate alert emails per person per day |
| `PUBLIC_API_URL` (frontend) | `http://localhost:3001` | `/api` in production |
| `PUBLIC_WAF_CAPTCHA_SCRIPT_URL`, `PUBLIC_WAF_CAPTCHA_API_KEY` (frontend) | empty (no sign-in CAPTCHA: there is no WAF locally) | set by `deploy-frontend.yml` from Terraform outputs (security.md § Sign-in CAPTCHA) |

To override something on your machine, create a gitignored
`.env.development.local` next to the committed file. It wins.

## Run the app

```bash
pnpm dev
```

- **Frontend:** http://localhost:7777
- **Backend:** http://localhost:3001 (`GET /health` → `{ "ok": true }`)
- `pnpm dev` starts Postgres first (`pnpm dev:db:up`, which returns at once when
  it is already up), so a reboot or a `pnpm dev:db:down` doesn't leave the
  backend failing with `ECONNREFUSED 127.0.0.1:5434`. `dev:full`,
  `dev:run:backend` and `dev:run:worker` do the same. Mailpit and MinIO stay
  opt-in (`pnpm dev:mail:up`, `pnpm dev:s3:up`). Every checkout, git worktrees
  included, drives the same containers: `docker-compose.yml` fixes the compose
  project name, so `pnpm dev:db:down` in any of them stops the shared database.
- Each checkout has its **own dev database** in that Postgres: `water` in the
  main checkout, `water_w<n>` in a git worktree (n from a hash of its path,
  the same as its `water_test_w<n>`). The backend's dev entry points
  (`backend/src/config/devEnv.ts`) point `DATABASE_URL` and
  `MIGRATION_DATABASE_URL` at it, and `pnpm dev` / `pnpm dev:db:migrate`
  create it on first use. A new worktree's database starts empty: run
  `pnpm seed:examples` there for the demo catchments. This keeps a branch's
  unmerged migrations out of the main checkout's database; when one branch
  migrated `water` and then renumbered that migration before merging, the
  main checkout's dev server refused to start ("applied but its file is
  missing"). `DEV_DB_NAME=water` (in the worktree's
  `backend/.env.development.local`) shares the main checkout's database
  instead; only a local URL naming `water` is redirected, so a custom
  `DATABASE_URL` is left alone.
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
WP-2.6's). A demo **applicant** (WP-3.3), `applicant@example.com`, is a
contributor on Sandspruit, linked to Klipdrift, with one submitted
application doubling its dam and keeping the EWR in the river before River
to dam fills it (the hands-off condition a new licence carries, so its
evidence report passes the river checks, [evidence-pack.md](./evidence-pack.md#what-stops-issue-on-the-river);
`backend/scripts/examples/application.ts`): sign in as them for the Applicant view, or as
analyst@ for Sandspruit's **Applications** tab to decide it. To try a **share link** (WP-2.3 phase 2), sign in as the owner
(analyst@ for Sandspruit, demo@ for the team's catchments), make one on the
Overview's Share links panel and open it in a private window; none is seeded,
since the URL is shown only when it is made. Every name and
number is synthetic, so the examples are committed
(`backend/scripts/examples/`) and work on any clone. Re-seeding gives the same
projects. Kleinberg also ships in the frontend as the example a new user can
start from on an empty project list (**Start from an example**, docs/ui.md §
Project list): `pnpm gen:example` writes it to
`frontend/src/lib/components/projects/exampleCatchment.generated.json`, and
`backend/scripts/example-file.test.ts` fails until you rerun that after
changing the examples or the model's fields. Between them they show every
feature of the current engine:

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

## Two-step sign-in

An account can add an authenticator app on the Account page (issue #282,
[security.md § Two-step sign-in](./security.md#two-step-sign-in)): scan the
QR code with any TOTP app on your phone (Google Authenticator, Microsoft
Authenticator, Aegis, 1Password …), or type the key it shows. Nothing leaves
the laptop: the code is checked locally and the QR code is drawn in the page.
The TOTP secrets are sealed with `APP_ENCRYPTION_KEY`, a `dev-only-`
placeholder in the committed `backend/.env.development`; changing it voids
every authenticator set up against your local database.

**Owners, team admins and assessors need it here too**, as in production:
an owner's actions (members, invites, API keys, data feeds, share links,
deleting a project), a team admin's, publishing to farmers, deciding an
application and issuing or withdrawing an evidence pack answer
`403 mfa_required` until the account has an authenticator, and
`403 mfa_step_up` from a session signed in before it was added. The seeded
demo accounts (`pnpm seed:examples`) start without one: set one up on the
Account page, or, to try those actions without a phone, put
`MFA_REQUIRED=false` in `backend/.env.development.local` and restart the
backend (Lambda refuses that setting). The DB tests and the e2e API server
set it themselves; `stepUp.db.test.ts` and `two-step-signin.spec.ts` test
the feature with it on and off.

Without a phone, a code for a secret is one line in the backend workspace:
`pnpm -C backend exec tsx -e "import('./src/auth/totp.ts').then(t => console.log(t.totp(t.base32Decode(process.argv[1]), Date.now())))" <SECRET>`
(the key the Account page shows, spaces removed). Lost the codes and the
app locally? `pnpm dev:db:psql`, then
`DELETE FROM user_recovery_code WHERE user_id = '…'; DELETE FROM user_totp WHERE user_id = '…';`.

## Alerts

Alert emails (WP-2.13, [architecture.md § Alert emails](./architecture.md#alert-emails))
go to Mailpit like every other email, sent by the worker, so run
`pnpm dev:full` (or `pnpm dev:run:worker` beside `pnpm dev`) and
`pnpm dev:mail:up`. To try them:

1. In a catchment with a published run, open Overview → **Set up alert
   emails**, switch **Farm dams** on for a farm and set the level above its
   dam (say 99 %), then Save. That evaluates at once: the worker opens the
   alert and mails the farm's farmers (`seed:examples`' farmer1@ /
   farmer2@example.com) and the editors and owners.
2. Mailpit shows the mail with its *Stop these emails* link
   (`/alerts/unsubscribe#t=…`) and its `List-Unsubscribe` headers; the
   one-click address is `API_PUBLIC_URL/alerts/unsubscribe?token=…`.
3. Lower the level below the dam (plus 5 points) and save to clear it; raise
   it again for a second crossing and a second mail.
4. Each person's choices are at `/account/alerts`. More than 5 immediate
   alerts in a day go into the next 06:00 digest (06:00 in the project's time zone, SAST by default): `pnpm dev:jobs:tick`
   sends what is due.

`ALERTS_ENABLED=false` in `backend/.env.development.local` is the kill
switch (restart the worker): nothing is sent, and waiting mails are dropped.

**A bounce or complaint.** There is no SES locally, so nothing ever
bounces. `pnpm dev:mail:bounce <email>` stands in for it: it builds the event
SES would publish for that address and runs it through the worker's own
handler (`mail/suppression.ts`) against the local database. Add
`--complaint` for a spam complaint, or `--transient` for a full mailbox
(which changes nothing). That person's alert emails pause, and their
account and alert pages show why, with **Turn alert emails back on**
(which, locally, just clears the flag; in production it also takes the
address off SES's suppression list).

```bash
pnpm dev:mail:bounce farmer1@example.com
```

## Background jobs

Some work runs later, in a worker, instead of inside a request: a queued
model run (`POST /projects/:id/jobs`), the data feeds (below), automatic
re-runs after new data, and alert emails ([architecture.md § Background work](./architecture.md#background-work)).
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

**Automatic runs** (Settings → Automatic runs, off by default) queue a re-run
after new data, due after the project's wait (15 minutes by default). Set the
wait to 0 while trying it out: with the worker running (`pnpm dev:full`), an
upload's run then appears within seconds; without it, `pnpm dev:jobs:tick`
runs it ([architecture.md § Automatic runs](./architecture.md#automatic-runs)).

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

An **issued evidence pack's PDF** is made the same way
([evidence-pack.md § The PDF](./evidence-pack.md#the-pdf)): issuing a pack
queues its render, and the worker prints the pack's own page
(`/projects/:id/packs/:packId`), stores the PDF in MinIO's `water-packs`
bucket (`PACKS_BUCKET`, created on first use) under its SHA-256, and records
that hash on the pack. MinIO keeps it like any object: the production
bucket's Object Lock retention (infra/packs.tf) has no local stand-in. Without
the worker the pack's PDF stays "rendering"; `pnpm dev:jobs:tick` prints it.

## Import the client catchment (demo data)

The client workbooks live outside the repo in `../project-water-management-source/Original/` (never committed). The
quickest route is the demo seed. It runs `seed:examples`, extracts the client
workbook into `data/` (also gitignored), then imports it as a project with one
run for the local demo user (details in `scripts/wbt-import/README.md`):

```bash
python3 -m venv .venv && .venv/bin/pip install openpyxl
pnpm seed:demo
```

The seed uses `$PYTHON` if set, else the checkout's `.venv/bin/python`, else
`python3`.

The seed imports every b023 workbook in `Original/` that isn't the blank template, each
as its own project.
A project is named from its workbook's file name, the part before
`_WBT_b023` with its CamelCase split, and extracted into
`data/client-<name>-app/`; both are worked out when the seed runs, since the
file names name the clients and never appear in the repo. Set
`WBT_CLIENT_WORKBOOK=/path/to/workbook.xlsm` to import just one. Running the
seed again makes no copies: a client project the demo user already owns
under the same name is skipped (`import:project --skip-existing`), and so
are the example catchments once they exist (all three: a partial set stops
the seed with a message, since they're linked by a team, shares, farmers and
an application). It never updates a project either: to reload one from a
changed workbook, delete it in the app (or `pnpm dev:db:reset` for a clean
database) and seed again.

A b023 gauge column need not measure the modelled catchment itself, so by
default the seed imports it as a reference gauge (`--gauge-as-reference`)
rather than as observed flow. Per-workbook settings live beside the workbooks, in
`../project-water-management-source/wbt-import.<Prefix>.env`, `<Prefix>`
being the file name before `_WBT_b023` (outside the repo, because they are
client data): for example, the gauge-scaling options
(`scripts/wbt-import/README.md`):

```bash
WBT_GAUGE_SCALING_FROM=YYYY-MM-DD
WBT_GAUGE_SCALE_FACTOR=F
```

and, for a workbook with units that pump straight from the river, to
import the units the importer flags as probable run-of-river with the
run-of-river supply rule (issue #54, 2c/2d; off unless set; the in-app
**Import b023 workbook** review has the same option as its *River pumping
units* checkbox, [ui.md](./ui.md#import-a-b023-workbook)):

```bash
WBT_RUN_OF_RIVER=1
```

and, for a workbook whose gauge is the modelled catchment's own record, to
import the gauge as observed flow, apply a settings patch kept beside the workbooks (an
areal rainfall correction from an independent MAP, the calibration window and
flow series; [model.md §2.4g](./model.md#24g-areal-rainfall-correction-engine--1130))
and fit GR4J to the gauge before the initial run
([model.md §2.10b](./model.md#210b-automatic-calibration-engine--050-issue-4-phase-4),
"Fit at import"):

```bash
WBT_GAUGE_AS_REFERENCE=0
WBT_SETTINGS=wbt-import.<Prefix>.settings.json
WBT_FIT=1
```

A transfer the workbook leaves switched off ([model.md §2.6a](./model.md)) is
set by a transfer patch beside the workbooks, applied before the fit:

```bash
WBT_TRANSFERS=wbt-import.<Prefix>.transfers.json   # [{ "from": "<unit>", "to": "<unit>", "set": { "enabled": true, "maxRateM3s": … } }]
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
A large workbook reads in a couple of seconds.

A large workbook takes a minute or so to read with the Python script. It uses
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
pnpm dev:db:psql            # psql as the owner role, on this checkout's dev database
pnpm dev:db:down            # stop Postgres (data is kept in the docker volume)
pnpm dev:db:reset           # DELETE all local data (every checkout's databases), recreate and migrate
```

## Checks and tests

```bash
pnpm check                  # typecheck all workspaces
pnpm test                   # unit tests (engine, frontend, backend) with no DB
pnpm test:backend:db        # API + RLS tests and catalogue guards (water_test DB; water_test_w<n> in a worktree); reports/render.db.test.ts renders a real PDF (skips, saying so, without MinIO) and reports/render.origin.db.test.ts drives Chromium (skips without it); under CI both fail instead of skipping (testing.md)
pnpm test:e2e               # Playwright end-to-end (own water_e2e DB, servers on :3101/:7801; per-worktree slot elsewhere; server-report.spec.ts needs dev:s3:up + dev:mail:up, alerts-mailpit.spec.ts dev:mail:up)
pnpm test:engine            # engine only; client catchment regression tests run when the data/ fixtures exist
pnpm check:i18n             # what has no Afrikaans yet, and any stale translation; fails if the sheet (docs/i18n/af-translation-sheet.md) or the message id list is out of date, or a translation is stale
pnpm gen:i18n:sheet         # rewrite it after adding or changing a message, or landing an Afrikaans translation
pnpm gen:i18n:stamp <id>    # re-stamp a glossary translation from the current English, once the translator has re-checked it
```

**Afrikaans locally.** Pick "Afrikaans" on the sign-in page, the farm view
or the account page. The words, `<html lang>`, dates and numbers all turn
Afrikaans (a decimal comma), and an account or invite in Afrikaans gets its
emails in Afrikaans in Mailpit ([ui.md § Language](./ui.md#language)).

The client catchment regression data comes from the import step above
(`expected.json`) and from the extractors in `scripts/wbt-import/`, all written
under `data/`. The engine's client suites and the pan-sensitivity smoke test
read `data/client-catchment`; `pnpm seed:demo` extracts to
`data/client-<name>-app/` instead, so point them at the right extract with
`WBT_CLIENT_CATCHMENT_DIR="$PWD/data/client-<name>-app" pnpm test:engine`
(absolute: a relative path resolves against the workspace the tests run in).
Without them, the
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
: Check `pnpm dev:mail:status`, and the backend console for
  `{"event":"mail_send_failed","kind":"verify","error":"Error","code":"ESOCKET"}`
  (Mailpit isn't up; the line names the email's kind and the error code, never
  the address or subject). Reset and
  verification emails go out at most once a minute per address, so a quick
  second request is silently skipped.

**A PDF stays "queued", or fails**
: The worker isn't running (`pnpm dev:full` or `pnpm dev:jobs:tick`). "The PDF
  could not be stored" means MinIO isn't up (`pnpm dev:s3:status`, then
  `pnpm dev:s3:up`). "The report could not be rendered (the browser failed)"
  usually means Playwright's Chromium isn't installed
  (`pnpm test:e2e:install`). The worker's console has the details.

**Issuing an evidence pack fails with a server error**
: Issuing stores the pack's reproduction bundle in MinIO, in the same step:
  without MinIO nothing is issued (`pnpm dev:s3:status`, then
  `pnpm dev:s3:up`, and issue again). The backend's console has the details.

**Port 7777 or 3001 already in use**
: The frontend port is fixed at 7777. The backend respects `PORT`.

## Next step

When the client wants to use it online, see [deployment.md](./deployment.md)
and [plan.md Phase 6](./plan.md#phase-6-deploy-to-aws).
