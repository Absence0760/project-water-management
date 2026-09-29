# Audit commands

Read-only sweeps, invoked as `/audit/<name>`. Each reports findings (Critical /
High / Medium / Low, then Clean) and applies nothing without confirmation.
The knowledge of the app lives in the agent each one delegates to; the
command says which area to sweep and what to look at first.

## Index

### Security (`repo-security-auditor`)

| Command | What it checks |
|---|---|
| [/audit/secrets](secrets.md) | Secrets in tracked files or history, committed env files, server config in the bundle, dotenv in Lambda bundles, workflow secrets, logs |
| [/audit/xss](xss.md) | `{@html}`, dynamic `href`/`src`, SVG, the CSP, the report page the renderer prints, mail templates |
| [/audit/auth](auth.md) | Route gating and the public allowlist, role checks, `withUser` discipline and RLS (runs the `auth` and `rls` areas) |

The agent's other areas (`tokens`, `ssrf`, `queues`, `ci`, `public-repo`) have no command of their own: spawn it with `Audit area: <area>.`

### Infra and spend (`infra-auditor`)

| Command | What it checks |
|---|---|
| [/audit/infra](infra.md) | IAM least privilege, network exposure, data protection and recovery, alarms |
| [/audit/cost-controls](cost-controls.md) | Worst-case monthly ceilings, queue and job loops, retry storms, fan-out caps, growth, budget and alarms |

### Privacy and accessibility (`compliance-auditor`)

| Command | What it checks |
|---|---|
| [/audit/popia](popia.md) | The personal-data record in `docs/security.md` against the code: retention, notice, sub-processors, transfers, breach procedure |
| [/audit/data-export-completeness](data-export-completeness.md) | "Download my data" covers everything kept about the person |
| [/audit/account-deletion-completeness](account-deletion-completeness.md) | Deleting an account reaches every row, text column and S3 object |
| [/audit/third-party-data-flows](third-party-data-flows.md) | Every outbound call carrying personal data, as a sub-processor list |
| [/audit/cookie-consent](cookie-consent.md) | Only strictly necessary cookies and no third-party origins, so no banner |
| [/audit/accessibility](accessibility.md) | WCAG 2.2 AA, farmer pages and phone layouts first |

### Dependencies (`general-purpose`)

| Command | What it checks |
|---|---|
| [/audit/deps](deps.md) | `pnpm audit`, hand pins Dependabot can't see, Dependabot coverage, action pinning, overrides, Node versions |

### Dispatcher

| Command | What it does |
|---|---|
| [/audit/all](all.md) | The core sweep in parallel (security, deps, infra, cost) with one consolidated report |

## When to run

- **Before a release**: `/audit/all`, fix Critical and High, then `/release-readiness`.
- **After a migration that adds personal data**: `/audit/data-export-completeness` and `/audit/account-deletion-completeness`.
- **After adding a route, role or policy**: `/audit/auth`.
- **After editing `infra/`**: `/audit/infra` and `/audit/cost-controls` before anyone runs `terraform apply`.
- **After a dependency major**: `/audit/deps`.
- **Monthly**: `/audit/all`; `audit.yml` already runs `pnpm audit` weekly.

For per-change checks use `/check`, `/safe-edit` and `/safe-migration` instead.
