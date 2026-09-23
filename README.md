# water-management

A web app for **daily catchment water-balance modelling**. It reimplements the
Water Balance Tool (WBT b023) Excel workbook that SmartMatix built for the
Freshwater Research Centre. For each catchment it models:

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
pnpm setup      # install deps, start Postgres 17 (docker, :5434), run migrations
pnpm dev        # frontend http://localhost:7777 + API http://localhost:3001
```

No env setup is needed: the local defaults are committed, and they are
non-sensitive. Register an account at http://localhost:7777 and create a
project.

**Demo data (client catchment):** the client workbook stays local in `Original/`
(gitignored). With a Python venv that has openpyxl installed,
`PYTHON=.venv/bin/python pnpm seed:demo` extracts it into `data/` (also
gitignored) and imports it for a local demo user. Step by step:
[docs/run-locally.md § Import client catchment](./docs/run-locally.md#import-client-catchment-demo-data).

## How it's built

- **packages/engine**: the model, in pure TypeScript. The same code runs in the
  browser (instant what-ifs) and on the server (stored runs). It is
  regression-tested against the client catchment workbook.
- **backend**: Hono API (Node locally, AWS Lambda in production) on
  **Postgres**. Per-project access is enforced with row-level security.
- **frontend**: SvelteKit static site with uPlot charts.
- **infra**: Terraform for S3 + CloudFront + Lambda (+ Postgres when deployed).

Details: [docs/architecture.md](./docs/architecture.md) ·
[docs/STACK.md](./docs/STACK.md).

## Commands

```bash
pnpm dev                    # frontend + backend
pnpm dev:db:up | dev:db:down | dev:db:migrate | dev:db:reset | dev:db:psql
pnpm check                  # typecheck all workspaces
pnpm test                   # unit tests (no DB)
pnpm test:backend:db        # API + RLS tests (needs dev:db:up)
pnpm build                  # static site + Lambda bundle
```

The full list is in [docs/STACK.md](./docs/STACK.md#commands-run-from-repo-root).

## Documentation

| Doc | What's in it |
| --- | --- |
| [docs/plan.md](./docs/plan.md) | Roadmap from V1 to a deployed product, acceptance criteria, **questions for the client**, risks |
| [docs/planned-work.md](./docs/planned-work.md) | Feature backlog beyond V1 — gaps from the workbooks, hydrologist needs, multi-catchment team features (Now / Next / Later) |
| [docs/model.md](./docs/model.md) | The water-balance model step by step, the AI modules, workbook quirks to confirm, glossary |
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
(`Original/`, `AI/`, `data/`, `*.xlsm`, `*.xlsx`) are **never committed**, and
committed test fixtures are synthetic. Production secrets are SOPS-encrypted in
the private `Absence0760/infra-secrets` repo under `water-management/`, never
here. See [docs/security.md § Public repo hygiene](./docs/security.md#public-repo-hygiene).

## Credits

The WBT b023 model architecture is © Freshwater Research Centre. The original
workbook's code and formulas are © SmartMatix. Whether this reimplementation is
permitted is an open question with the client (see [docs/plan.md](./docs/plan.md#questions-for-the-client)).
