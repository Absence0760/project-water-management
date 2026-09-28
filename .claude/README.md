# .claude/ — Claude Code tooling

These agents and commands were derived from a real working web app (SvelteKit + Hono + DynamoDB + CMS + payment-redirect shape) and **lightly generalized** with placeholder names: `<payment-processor>`, `<CMS>`, `<email-service>`, `<aws-region>`, `<EMAIL_SERVICE>_API_KEY`, etc.

**They will not be 100% accurate for your project out of the box.** Each new project should re-read these and replace placeholder examples with the actual services / routes / file paths in use. Treat them as templates of *structure and rigor*, not as fully-portable boilerplate.

## What's here

### Agents (`agents/`)

- **`code-reviewer.md`** — invoked at PR / pre-commit time to review the diff against the project's documented rules.
- **`doc-hygiene-checker.md`** — checks that code changes update docs and tests in the same change.
- **`test-gap-checker.md`** — finds modules / routes without test coverage.
- **`ui-designer.md`** — this app's UI/UX designer, working from `docs/design/ui-playbook.md` (the lessons of the option A redesign, issue #17). Two modes: `build` redesigns one screen (board or sibling page first, screenshots at 1440/1280/390 in light and dark, a "nothing lost" inventory, specs, docs; commits, never pushes) and `review` checks a diff or screen against the playbook (read-only). Replaces the template's `ui-polisher`, which described a different site.
- **`repo-security-auditor.md`** — read-only security auditor, adapted to this project: trust boundaries (CloudFront shared secret + WAF, tokens, Postgres RLS via `withUser`, fetcher SSRF, renderer, SQS message trust, OIDC, public repo), areas `secrets` / `xss` / `auth` / `rls` / `tokens` / `ssrf` / `queues` / `ci` / `public-repo` / `all`. Writes `reviews/security-<area>.md`.
- **`infra-auditor.md`** — read-only Terraform + spend auditor. Main job: no runaway bill (Lambda concurrency ceilings with worst-case arithmetic, queue/job loops, retry storms, fan-out caps, log/storage growth, budget + alarms against `docs/deployment-tiers.md`); also `iam`, `network`, `data`, `observability`, `all`. Never calls AWS. Writes `reviews/infra-<area>.md`.
- **`compliance-auditor.md`** — read-only privacy / legal / accessibility auditor. Backs the GDPR, cookie-consent, data-export, account-deletion, third-party-data-flows, and accessibility audit commands. Knows enough about GDPR / ePrivacy / CCPA / WCAG to flag the obvious gaps; the operator still owns the final policy / legal call.
- **`migration-coordinator.md`** — DB schema-change coordinator. Applies a migration locally, verifies RLS coverage on tenant tables, surfaces manual type-sync edits, proposes smoke-test additions. Pairs with `/safe-migration`.
- **`persona-*.md`** — bug-hunting personas. Each adopts a real-world point of view (`new-user`, `power-user`, `admin`, `international-user`, `accessibility-user`, `integrator`, `adversary`, `data-subject`) and walks the app the way that person would, finding logic / UX / domain bugs a code review misses. Read-only; each writes a living report to `reviews/<persona>.md` (git-ignored). Stack-agnostic — they discover the app first. Protocol + how to add project-specific domain personas (an invoicing app's approver/CFO/accountant, a marketplace's buyer/seller, …): `personas/README.md`. Run via `/persona`. This project's domain pack: `hydrologist`, `environmentalist`, `licence-applicant`, `licensing-authority`, `wua-manager`, `farmer`.
- **`i18n/i18n-translator.md`, `i18n/i18n-checker.md`** — the translation pair (WP-2.5; language-parameterised since issue #58, one pair for every language in `packages/engine/src/languages.ts`). The target language is the first line of the prompt; both read `i18n/languages/<code>.md` for that language's register, spelling authority and terminology (`i18n/languages/af.md` for Afrikaans, §5.1 of `docs/design/farmer-view.md` is its word list). The translator turns a JSON batch from `pnpm gen:i18n:export <lang>` into id → words for farmers; the checker reviews the whole set against the English (meaning, placeholders, bold, plural forms, register, one term per English word across batches) and writes corrections. Neither edits the repo: `pnpm gen:i18n:apply <lang> <translations.json> <corrections.json>` checks and writes the result. See `docs/ui.md` § Language.

### Commands (`commands/`)

- **`check.md`** — pre-commit gate: runs `code-reviewer`, `test-gap-checker` and `doc-hygiene-checker` in parallel over the working diff. Advisory; applies nothing.
- **`safe-edit.md`** — workflow for edits to security-sensitive or load-bearing files.
- **`safe-migration.md`** — DB-schema-change workflow with `migration-coordinator` in the loop.
- **`polish-ui.md`** — runs `ui-designer` on one screen: `/polish-ui <target>` builds, `/polish-ui review <target|diff>` reports.
- **`persona.md`** — runs one, several, or all of the `persona-*` bug-hunting auditors in parallel and consolidates their reports.
- **`release-readiness.md`** — go/no-go checklist before tagging a release.
- **`endpoint-inventory.md`** — builds the HTTP-route inventory from the router source.
- **Hunt / fix loops** (each commits path-scoped, never pushes): `bug-hunt.md`, `ux-hunt.md`, `perf-hunt.md`, `a11y-hunt.md`, `coverage-hunt.md`, `audit-and-fix.md`, `improve-round.md`, `fix-ci.md`.
- **`audit/`** — directory of focused audits. Each command delegates to `repo-security-auditor` (security surfaces) or `compliance-auditor` (privacy / legal / a11y surfaces):
  - Security: `secrets.md`, `infra.md`, `deps.md`, `xss.md`, `cost-controls.md`, `auth.md` (route gating + tenant-context discipline)
  - Privacy / compliance: `gdpr.md`, `cookie-consent.md`, `data-export-completeness.md`, `account-deletion-completeness.md`, `third-party-data-flows.md`
  - Quality: `accessibility.md`
  - Only for stacks that have them: `llm-endpoint.md`, `websocket-hub.md`
  - `all.md` runs five of them in parallel (secrets, xss, deps, infra, cost-controls); `README.md` is the index

### Hooks (`hooks/`, wired in `settings.json`)

- **`git-scope-guard.py`** (PreToolUse on Bash) — blocks whole-tree git commands (`git add .`, bare `git commit`, `git stash`, …) so sessions sharing one checkout don't sweep up each other's work. Tests: `git-scope-guard.test.py`.
- **`unmerged-worktree-check.sh`** (SessionStart) — warns when a branch holds commits not on `main` (e.g. a forgotten worktree branch).

## Adapting these for a new project

1. Rewrite the trust-boundary map in `agents/repo-security-auditor.md` to match your stack's actual third-party integrations.
2. Update route tables in `audit/cost-controls.md` and `audit/infra.md` to match your `backend/src/routes/*` and `infra/*.tf`.
3. Replace the `<placeholder>` tokens (`<payment-processor>`, `<CMS>`, `<email-service>`, `<aws-region>`) with real service names so the agents stop emitting them in reports.
4. Add stack-specific audits not covered here (Postgres RLS? Edge functions? Mobile-twin parity? GDPR / app-store privacy? — extend `audit/` with the checks that matter for your trust surface).
5. Remove audits that don't apply (e.g. `cost-controls.md` doesn't apply to a static-only site with no Lambda / no third-party APIs).
6. Add domain personas. The generic `persona-*` panel applies to any app; most projects also deserve personas tied to their domain (an invoicing app's approver/CFO/accountant, a marketplace's buyer/seller/dispute, a healthcare app's patient/clinician). Copy the closest generic persona and follow `personas/README.md` § "Domain packs".
