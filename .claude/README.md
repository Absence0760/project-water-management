# .claude/ — Claude Code tooling

Agents, commands and hooks for this repo. They started from the `templates`
repo's `base` branch and are adapted to this app: a SvelteKit SPA, a Hono API
on Lambda, Postgres with RLS, and the shared model engine. Every agent names
real paths and rules from `CLAUDE.md` and `docs/`; a placeholder or a path
that doesn't exist is a bug to fix, not a template to fill in.

## How the pieces fit

Work in this repo is one GitHub issue per session, landing as one PR. The
tooling follows that lifecycle:

1. **Build**: `/issue <n>` reads the issue, makes the worktree and routes the
   work to the right workflow below.
2. **Gate every change**: `/check` (and `/safe-edit` or `/safe-migration`
   where the change warrants it) runs the engineering agents over the diff.
3. **Sweep periodically**: `/audit/*`, `/persona`, the hunt loops, and
   `/release-readiness` before a release.

Agents are grouped by team. The session that owns the issue does the building;
agents review, audit or produce one well-defined artefact (a translation, a
legal position, a screen). There is no hand-off chain between teams.

## Agents (`agents/`)

### `engineering/` — the per-change gate
- **`code-reviewer`** — reviews a diff against CLAUDE.md's project rules, the RLS and migration rules in `docs/data-model.md`, the API rules in `docs/security.md`, the Lambda bundle and engine-purity rules in `docs/STACK.md`. Strict CLEAN / NEEDS_CHANGES output. Read-only.
- **`test-gap-checker`** — maps each changed file to the test it should ship with (unit, db, security, e2e, node:test guard) and the targeted commands to run. Read-only.
- **`doc-hygiene-checker`** — maps a diff to the `docs/` sections it should update. Read-only.
- **`engine-reviewer`** — for changes to `packages/engine`: judges them by documented hydrology, mass balance, units and day boundaries, the `ENGINE_VERSION` bump, the workbook deviation list and the known-limitations list. Read-only.
- **`migration-coordinator`** — for a file under `backend/migrations/`: applies it locally, checks numbering, forward-only, RLS, grants, triggers and FK indexes, runs the catalogue guards, lists type-sync edits and the DB tests to add. Read-only on code.

### `design/`
- **`ui-designer`** — builds or reviews one screen to `docs/design/ui-playbook.md` (option A, issue #17). `build` mode commits on a PR branch; `review` mode is read-only.

### `audit/` — periodic sweeps, read-only
- **`repo-security-auditor`** — trust boundaries (CloudFront secret + WAF, tokens, RLS via `withUser`, fetcher SSRF, the renderer, SQS, OIDC, the public repo). Areas `secrets`, `xss`, `auth`, `rls`, `tokens`, `ssrf`, `queues`, `ci`, `public-repo`, `all`. Writes `reviews/security-<area>.md`.
- **`infra-auditor`** — Terraform and spend: no runaway bill, IAM, network, data, observability. Writes `reviews/infra-<area>.md`.
- **`compliance-auditor`** — POPIA first (GDPR if asked): the personal-data record in `docs/security.md`, the export and deletion paths, sub-processors, cookies, WCAG 2.2 AA.

### `personas/` — bug-hunting points of view, read-only
Each walks the app as one kind of person and writes `reviews/<persona>.md` (git-ignored). Run through `/persona`; the protocol and how to add one are in `.claude/personas/README.md`.
- Generic: `new-user`, `power-user`, `admin`, `international-user`, `accessibility-user`, `integrator`, `adversary`, `data-subject`.
- Domain: `hydrologist`, `environmentalist`, `licence-applicant`, `licensing-authority`, `wua-manager`, `farmer`.

### `i18n/`
- **`i18n-translator`**, **`i18n-checker`** — the translation pair, one language per run (`i18n/languages/<code>.md` holds each language's register and terms). Neither edits the repo; `pnpm gen:i18n:apply <lang>` checks and writes the result. See `docs/ui.md` § Language.

### `legal/`
- **`za-legal-researcher`** — pre-counsel research on one South African law question (CPA, delict, POPIA, the National Water Act, conduct codes). Research, not legal advice; `docs/legal-status.md` records which answers rest on it.

## Commands (`commands/`)

- **`issue.md`** — `/issue <n>`: one GitHub issue end to end.
- **`check.md`** — pre-commit gate: the three engineering reviewers in parallel, plus `engine-reviewer` for the model, `migration-coordinator` for SQL and `ui-designer` review for screens. Advisory.
- **`safe-edit.md`** — coder, reviewer, fix, re-review; for access, tokens, RLS, personal data, the job queue, Lambda entry points, infra, engine behaviour.
- **`safe-migration.md`** — any change under `backend/migrations/`, with `migration-coordinator`.
- **`polish-ui.md`** — runs `ui-designer`: `/polish-ui <target>` builds, `/polish-ui review <target>` reports.
- **`persona.md`** — runs one, several or all personas in parallel and consolidates.
- **`release-readiness.md`** — go/no-go before a `backend@X.Y.Z` or `web@X.Y.Z` release.
- **`endpoint-inventory.md`** — the HTTP route inventory from the router source.
- **Hunt and fix loops** (commit path-scoped, land through a PR, never push `main`): `bug-hunt`, `ux-hunt`, `perf-hunt`, `a11y-hunt`, `coverage-hunt`, `audit-and-fix`, `improve-round`, `fix-ci`.
- **`audit/`** — focused read-only audits; index in `audit/README.md`.

## Skills (`skills/`)

- **`steward/SKILL.md`** — how a session drives a PR here to green: the `CI gate`, what docs-only PRs still run, the local command for each CI job, flakes, updating a branch that fell behind, reviews, and what to ask the operator first.

## Hooks (`hooks/`, wired in `settings.json`)

- **`git-scope-guard.py`** (PreToolUse on Bash) — blocks whole-tree git commands and any push to `main`, so sessions sharing one checkout don't sweep up each other's work. Tests: `git-scope-guard.test.py`.
- **`unmerged-worktree-check.sh`** (SessionStart) — warns when a branch holds commits not on `main`.

## Adding or changing an agent

- Put it in the team folder it belongs to; a new team gets a folder once it has more than one member.
- Name real paths, commands and rules, and cite where each rule lives (`CLAUDE.md` rule N, `docs/<file>.md` § …). Don't copy a rule's reasoning into the agent; point at the doc.
- Say whether it is read-only, and what it writes if not.
- Update this file and, if a command uses it, that command.
- `pnpm check:claude` (CI job `claude-tooling`, which runs on docs-only PRs too) fails on a cited path that doesn't exist, a template placeholder, or frontmatter without a description or with a name that isn't the file name.
