---
description: Find secrets or server-only config that may have leaked into a tracked file, git history, the client bundle, a workflow or a log — via repo-security-auditor
---

Find any secret, credential or server-only value that sits on the wrong side of
water-management's boundary. Real secrets live only in the private estate repo,
SOPS-encrypted under `../infra-secrets/water-management/`; this repo is public
and may hold only non-sensitive local defaults (CLAUDE.md § Repo-wide hard
rules, rule 11).

## Procedure

1. Spawn one **`repo-security-auditor`** agent with the prompt `Audit area: secrets.`
   It checks, with `file:line` evidence:
   - secret-shaped literals in tracked files and in history (`git log -p -S`),
     any tracked `*.sops.yaml`, `.env` or `terraform.tfvars`;
   - the committed `*/.env.development` files hold only local, non-sensitive
     values (`pnpm check:env`);
   - frontend code reading anything but `PUBLIC_*` (`$env/static/private`,
     `$env/dynamic/*`, `process.env`), and server config inlined into the bundle;
   - `dotenv` reachable from a Lambda entry point
     (`scripts/guards/check_lambda_bundle.mjs`);
   - workflow `env:` blocks with literals, secrets echoed in logs, and any
     static AWS key instead of OIDC (`pnpm check:workflows`);
   - tokens, passwords or email bodies written to logs (`console.` and
     `backend/src/logging/`);
   - client-identifying terms (`pnpm check:terms`, a no-op without the
     list in `../infra-secrets`).
2. Relay its report as is: findings most severe first, then Clean.

Never paste a found value into the report: name the variable and where it is. A secret that ever reached git history needs rotating, whatever happened after.

Read-only. Don't apply fixes; offer them, one path-scoped commit per finding
on a PR branch.

## When

After adding an env var, a workflow or a log line, before a release, and monthly.
