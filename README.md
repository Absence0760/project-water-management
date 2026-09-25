# water-management

A web app for **daily catchment water-balance modelling**. It replaces the
spreadsheet-based Water Balance Tool (WBT b023) the client used before. For
each catchment it models:

- natural river flow from rainfall
- irrigation demand per farm (crops × A-pan evaporation)
- farm dams, spills, diversions and transfers between farms
- whether the **Environmental Water Requirement (EWR)** is met at each farm and
  at the outflow gauge

Each catchment is a **project**. You can keep several side by side (place A, B,
C…), create more, copy one to try a what-if, and share each project with other
users as viewer, editor or owner.

**Status:** building V1, a local demo for the client. The roadmap is in
[docs/plan.md](./docs/plan.md). The target production URL is
`https://water-management.jaredhoward.com` (not deployed yet).

## Quick start

Needs Node 24, pnpm 10 (Corepack) and Docker.

```bash
pnpm setup      # install deps, start Postgres 17 (docker, :5434), run migrations, start Mailpit
pnpm dev        # frontend http://localhost:7777 + API http://localhost:3001
```

No env setup is needed: the local defaults are committed, and they are
non-sensitive. Register an account at http://localhost:7777 and create a
project.

**Demo data (invented):** `pnpm seed:examples` loads three invented example
catchments, each with a run, for two demo users (`demo@example.com` /
`analyst@example.com`, password `demo-password`, local only). They are
synthetic and committed, so this works on any clone
([docs/run-locally.md § Example catchments](./docs/run-locally.md#example-catchments)).

**Demo data (client catchment):** the client workbook stays local in `../project-water-management-source/Original/` (a sibling folder outside the repo; override with `WBT_SOURCE_DIR`)
(gitignored). With a Python venv that has openpyxl installed,
`PYTHON=.venv/bin/python pnpm seed:demo` extracts it into `data/` (also
gitignored) and imports it for a local demo user. Step by step:
[docs/run-locally.md § Import the client catchment](./docs/run-locally.md#import-the-client-catchment-demo-data).

## How it's built

- **packages/engine**: the model, in pure TypeScript. The same code runs in the
  browser (instant what-ifs) and on the server (stored runs). Its correctness
  is judged by documented hydrology and invariant tests; a regression suite
  against the client workbook lists every intended departure
  ([docs/engine-audit.md](./docs/engine-audit.md)).
- **backend**: Hono API (Node locally, AWS Lambda in production) on
  **Postgres**. Per-project access is enforced with row-level security.
- **frontend**: SvelteKit static site with uPlot charts.
- **infra**: Terraform for S3 + CloudFront + Lambda + RDS Postgres + SES (not deployed yet).

Details: [docs/architecture.md](./docs/architecture.md) ·
[docs/STACK.md](./docs/STACK.md).

## Commands

```bash
pnpm dev                    # frontend + backend
pnpm dev:db:up | dev:db:down | dev:db:migrate | dev:db:reset | dev:db:psql
pnpm check                  # typecheck all workspaces
pnpm test                   # unit tests (no DB)
pnpm test:backend:db        # API + RLS tests (needs dev:db:up)
pnpm test:e2e               # Playwright end-to-end (needs dev:db:up)
pnpm build                  # static site + Lambda bundle
```

The full list is in [docs/STACK.md](./docs/STACK.md#commands-run-from-repo-root).

## Documentation

| Doc | What's in it |
| --- | --- |
| [docs/plan.md](./docs/plan.md) | Roadmap from V1 to a deployed product, acceptance criteria, **questions for the client**, risks |
| [docs/planned-work.md](./docs/planned-work.md) | Feature backlog beyond V1 — gaps from the workbooks, hydrologist needs, multi-catchment team features (Now / Next / Later) |
| [docs/model.md](./docs/model.md) | The water-balance model step by step, the AI modules, workbook quirks to confirm, glossary |
| [docs/engine-audit.md](./docs/engine-audit.md) | Where and why the engine departs from the workbook |
| [docs/ui.md](./docs/ui.md) | The catchment workspace: tabs, Add data, schematic, results dashboard |
| [docs/data-model.md](./docs/data-model.md) | Tables, mapping to the workbook's sheets, roles and RLS, time-series storage |
| [docs/api.md](./docs/api.md) | HTTP API contract |
| [docs/architecture.md](./docs/architecture.md) | System diagram, workspaces, request and run lifecycle |
| [docs/STACK.md](./docs/STACK.md) | Stack, commands, conventions |
| [docs/run-locally.md](./docs/run-locally.md) | Local setup, importing a workbook, troubleshooting |
| [docs/deployment.md](./docs/deployment.md) | AWS deployment (account, secrets, Terraform, CI/CD) |
| [docs/security.md](./docs/security.md) | Auth, RLS, secrets, known gaps, incident playbook |
| [infra/README.md](./infra/README.md) | Terraform specifics |

## Public repo: secrets and client data

This repo is public. Client workbooks and anything extracted from them
(kept outside the repo in `../project-water-management-source/`; `data/`, `*.xlsm`, `*.xlsx` are gitignored) are **never committed**, and
committed test fixtures are synthetic. Production secrets are SOPS-encrypted in
the private `Absence0760/infra-secrets` repo under `water-management/`, never
here. See [docs/security.md § Public repo hygiene](./docs/security.md#public-repo-hygiene).
