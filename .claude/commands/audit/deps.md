---
description: Cross-workspace dependency audit — pnpm audit, the hand-pinned packages Dependabot can't see, Dependabot coverage, action pinning, overrides, Node versions
---

Sweep dependencies for known advisories and drift, and check that every
dependency has something watching it.

## What this is

- **pnpm workspaces** (`pnpm-workspace.yaml`): `frontend`, `backend`,
  `packages/*` (the engine), `e2e`, with one root `pnpm-lock.yaml`. The root
  `package.json` holds scripts only; overrides and the 7-day
  `minimumReleaseAge` live in `pnpm-workspace.yaml`.
- **The renderer's own npm lock**: `backend/renderer-deps/` (its
  `playwright-core` must match the other pins, `pnpm check:pins`).
- **Python**: `scripts/wbt-import/` and `brand/` (pip).
- **Hand pins Dependabot can't see**: SheetJS `xlsx` as a CDN tarball URL in
  `frontend/package.json`, with its advisories recorded in `osv-scanner.toml`
  (`docs/STACK.md` § Stack, frontend).
- **GitHub Actions**, SHA-pinned (`pnpm check:workflows` enforces it).
- **Terraform providers** (`infra/`) and the docker-compose images.
- The scheduled `audit.yml` runs `pnpm audit` weekly and files an issue; this
  command adds the checks it doesn't cover.

## What to check

1. **Advisories.** `pnpm audit --audit-level=moderate` from the root, and
   `npm audit` in `backend/renderer-deps/`. For each: package, version,
   advisory, fixed version, and whether it reaches a runtime path (a Lambda
   bundle or the shipped SPA) or only dev tooling.
2. **Open audit issue.** `gh issue list --label dependency-audit --state open`,
   if `gh` is available; compare with today's result.
3. **Hand pins.** Is there a newer SheetJS release on its CDN? Does
   `osv-scanner.toml` list only advisories the pinned version fixes, with an
   expiry that hasn't passed?
4. **Dependabot coverage** (`.github/dependabot.yml`): npm at `/` and
   `/backend/renderer-deps`, pip, github-actions, docker-compose, terraform.
   Flag any manifest or lockfile with no entry, and cooldowns that disagree
   with `minimumReleaseAge`.
5. **Lockfile sync.** `.github/workflows/dependabot-lockfile.yml` exists and
   uses a token that can retrigger CI.
6. **Action pinning.** `pnpm check:workflows` passes (SHA pins, OIDC only,
   production gating).
7. **Overrides.** Each entry under `overrides` in `pnpm-workspace.yaml` has a
   comment naming its advisory, a tight range, and is still needed (has
   upstream shipped the fix?).
8. **Node.** `engines` (`>=24`), `.tool-versions`, the CI `node-version` and
   the Lambda runtime in `infra/lambda.tf` (`nodejs24.x`) agree.

## Report

- **Critical**: an exploitable advisory in a runtime path.
- **High**: an advisory with a fix available; a manifest with nothing watching it.
- **Medium**: an overdue upgrade; a loose or stale override; a version mismatch
  between CI, `engines` and the Lambda runtime.
- **Low**: an override without its reason; grouping that could be tighter.

For each: package, version, advisory link, the file to change, the command.

## Delegate to

A `general-purpose` agent with this file as the prompt. Read-only: recommend
upgrades, don't apply them (a major bump is its own PR).
