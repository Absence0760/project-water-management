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
then `pnpm dev:mail:up` (Mailpit, see [Email](#email)).
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
| `CLOUDFRONT_SHARED_SECRET` | empty | Empty turns the CloudFront header check off locally |
| `SITE_URL` | `http://localhost:7777` | Base of the links in emails |
| `MAIL_TRANSPORT` | `smtp` | `smtp` → Mailpit locally; `log` prints emails to the console; `ses` in production |
| `SMTP_HOST` / `SMTP_PORT` | `127.0.0.1` / `1026` | Mailpit's SMTP port |
| `MAIL_FROM` | `Water Management <no-reply@localhost>` | Sender |
| `PUBLIC_API_URL` (frontend) | `http://localhost:3001` | `/api` in production |

To override something on your machine, create a gitignored
`.env.development.local` next to the committed file. It wins.

## Run the app

```bash
pnpm dev
```

- **Frontend:** http://localhost:7777
- **Backend:** http://localhost:3001 (`GET /health` → `{ "ok": true }`)

Register an account on the site. The first user needs no invitation, and each
user starts with no projects.

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

## Import client catchment (demo data)

The client workbooks live in `Original/` (gitignored, never committed). The
quickest route is the demo seed. It extracts client catchment and the blank b023
sample into `data/` (also gitignored), then imports both as projects for a local
demo user (details in `scripts/wbt-import/README.md`):

```bash
python3 -m venv .venv && .venv/bin/pip install openpyxl
PYTHON=.venv/bin/python pnpm seed:demo
```

Then sign in at http://localhost:7777 as `demo@example.com` / `demo-password`.
These are local-only values: the user exists only in your docker Postgres.

To do the steps by hand, or to import another workbook for your own account:

```bash
.venv/bin/python scripts/wbt-import/extract_project.py "Original/Client_WBT_b023_v001_20260407_WORKING 007.xlsm" data/client-catchment
pnpm import:project "$PWD/data/client-catchment/project.json" --email you@example.com --name "Client Catchment"
```

This writes `data/client-catchment/project.json` (settings, model, input series) and
`data/client-catchment/expected.json` (the workbook's own results, used by the
engine's regression test). The workbook must have been calculated and saved in
Excel, because the importer reads cached values. Options are documented at the
top of each script in `scripts/wbt-import/`. `import:project` creates the
project for an existing user (`--password` also creates the user; local demo
only). Open the project, press **Run**, and compare the Shortfalls table with the workbook's
`[Shortfalls]` sheet.

The 87 MB workbook takes a minute or so to read. The importer uses openpyxl's
read-only mode, so memory stays bounded.

## Multiple projects

Each catchment is its own project. Create "Place A", "Place B" and "Place C"
from the project list. **Copy** duplicates a project's model and input series
(not its runs), which is the quickest way to start a what-if variant.

## Running pieces individually

```bash
pnpm dev:run:frontend       # frontend only
pnpm dev:run:backend        # backend only
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
pnpm test:backend:db        # API + RLS tests, catalogue guards and route-auth inventory (water_test DB)
pnpm test:e2e               # Playwright end-to-end (own water_e2e DB, servers on :3101/:7801)
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

**Port 7777 or 3001 already in use**
: The frontend port is fixed at 7777. The backend respects `PORT`.

## Next step

When the client wants to use it online, see [deployment.md](./deployment.md)
and [plan.md Phase 6](./plan.md#phase-6-deploy-to-aws).
