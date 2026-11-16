# Security policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Report it privately through GitHub's private vulnerability reporting: open
<https://github.com/Absence0760/project-water-management/security/advisories/new>
(or the repository's **Security** tab → **Report a vulnerability**). Only the
maintainers see the report, and the fix is coordinated in that draft advisory.
Include:

- A description of the vulnerability and its impact
- Steps to reproduce (PoC if possible)
- The commit SHA or version where you observed it

You can expect an acknowledgement within 72 hours and a triage decision within 7 days.

## Scope

This template ships with the following defensive scaffolding:

- **Secret scanning** — `.github/workflows/secret-scan.yml` runs TruffleHog on every push and every PR (ci.yml's `secret-scan` job, part of the `CI gate`), and `secret-scan-sweep.yml` runs it over the full history weekly; a verified (live) or unverifiable credential fails it. `.pre-commit-config.yaml` runs gitleaks locally before commit.
- **Dependency review** — `.github/workflows/audit.yml` runs `pnpm audit` / equivalent per workspace and fails on high-severity findings.
- **Static analysis** — `.github/workflows/security.yml` runs CodeQL (SAST) on the configured languages on every PR + weekly.
- **Supply-chain scoring** — `.github/workflows/scorecard.yml` runs OpenSSF Scorecard weekly; results flow to the Security tab and to scorecard.dev.
- **Automated updates** — `.github/dependabot.yml` opens grouped weekly PRs for npm/pip/terraform/GitHub Actions.

## Out of scope

- Issues in dependencies — please report upstream and then optionally let us know.
- Issues that require a malicious maintainer or compromised developer machine.
