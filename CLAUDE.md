# CLAUDE.md

Guidance for Claude Code working in this repository. Keep this file short — it loads into every conversation.

**Stack overview, dev commands, and first-time setup live in `docs/STACK.md`.** Read it before doing anything else here — this file deliberately stays stack-agnostic.

@docs/STACK.md

## How this repo was bootstrapped

This project was started from a template branch in `templates`. Shared scaffolding (`.claude/`, security workflows, `CLAUDE.md` itself, `.gitignore`, etc.) is owned by that repo's `base` branch and is not unique to this project. Stack-specific code, business logic, and `docs/STACK.md` are owned here.

If you find a rule worth applying to *every* future project, propose it for the templates repo's `base` branch — don't fork the convention locally.

## Repo-wide hard rules

- **Secrets** — Real production secrets do **NOT** live in this repo. They live in the private estate repo `Absence0760/infra-secrets` (sibling of this repo under `~/github/`), one subdir per project (`infra-secrets/<project-slug>/*.sops.yaml`), each SOPS-encrypted under that project's own `alias/<project-slug>-sops` AWS KMS key; decryption needs `kms:Decrypt` on that key (access is IAM, not repo membership). Bootstrap a project's slot with `infra-secrets/bin/sops-init.sh --project <slug> --region <region>`. Plaintext siblings (`.env`, `terraform.tfvars`) are gitignored and exist transiently for local dev. Never commit a secret to a project repo (encrypted or not), never `git add -f` one, and never add a SOPS recipient other than the project KMS key without discussing.
- **Local-dev env is committed; real secrets never are.** Stack defaults for local dev go in a **committed `.env.development`** (per workspace), loaded automatically by the dev script, so a fresh clone runs with zero env setup. It may contain *only non-sensitive* values — localhost URLs, default ports, docker-compose default creds (`flakey_app`/`flakey_app`, `minioadmin`), dev-only fallback flags — things that grant access to nothing outside a throwaway local environment, so committing them is harmless. The test of "safe to commit" is **non-sensitivity, not "it's only local"**: anything that authenticates to a real or shared system, or that you reuse elsewhere, is a real secret — keep it SOPS-encrypted (above) or in a gitignored `.env.development.local` (loaded last, so it wins). Don't edit the committed file for machine-local tweaks (it dirties the shared tree); use `.env.development.local`. `.env` stays gitignored — it's the personal / SOPS-plaintext slot.
- **Local-first.** Every part of the app must run on a dev laptop with no cloud account. Each external dependency ships a local equivalent (Postgres/Mailpit/MinIO via docker-compose, a local LLM, a webhook sink) *and* a code default that points at it (`STORAGE=local`, an in-process fallback, the feature off until configured) in the *same* change that introduces the dependency — never make the dev server require a real SaaS credential. Give every service or long-running process a dev script (`dev:core`, `dev:db:up`, `dev:run:<app>`, … — see "Root package.json scripts" below) so no one memorizes raw `docker compose`/tool invocations.
- **CI auth** — CI must use GitHub OIDC against AWS. Never introduce static AWS access keys in workflow files or secrets store.
- **Deploys go through the `production` GitHub environment.** Every repo that ships to a real environment must have a GitHub environment named **`production`** with the operator set as a **required reviewer**, and every deploy job must be gated on `environment: production`. This is the human-in-the-loop that makes the OIDC deploy role load-bearing: the role's trust policy pins the `environment:production` `:sub` claim, so a workflow can only assume it *after* a human approves the run. A deploy path that skips the environment (or an environment with no required reviewer) is a bug — treat it like a missing auth check. See `.github/workflows/deploy.yml.example` (Gate 3) for the pattern; the environment itself is provisioned from the `templates` repo's estate scripts (`new-project-account.sh` for new in-org projects, `backfill-prod-environment.sh` for existing repos).
- **Pre-commit hooks** — `.pre-commit-config.yaml` runs gitleaks on staged changes. Install once with `pre-commit install`. Don't bypass with `--no-verify`.

## Project rules (water-management)

Rules only. The reasoning and the catalogues live in `docs/` (`data-model.md`, `security.md`, `model.md`, `plan.md`).

1. **Never bypass RLS.** All project data goes through the backend's `withUser` (a transaction as `water_app` with `app.current_user_id` set). App code never connects as the owner or a superuser. A migration that adds a table adds its RLS policies **and** `GRANT … TO water_app` in the same file.
2. **Migrations are forward-only once deployed.** `001` may still be edited until the first production deploy. After that, add `NNN_*.sql`. Prefer expand/contract.
3. When changing a SQL function or policy, start from its **latest** definition. `DROP POLICY` needs the exact name.
4. Every SQL function pins `search_path`, and every foreign key has a covering index. Catalogue tests guard both, so keep them green.
5. RLS "cannot see" tests need a **positive control** (a member *can* see it).
6. Every route is auth-gated or on the public allowlist (guarded by a test). API responses never contain raw DB error text.
7. Date-sensitive tests run under a skewed `TZ`.
8. Never `git stash`, not even with a path.
9. e2e is Playwright under `e2e/`. It runs fully locally against docker Postgres, the backend and a production build of the frontend (not `vite dev`), with no `networkidle` waits and a pinned `timezoneId: 'UTC'`.
10. Engine correctness is judged by documented hydrology and invariant tests, not by agreement with the b023 workbook. Where the engine departs from the workbook, `docs/engine-audit.md` says why and the client catchment regression suite in `packages/engine` lists the affected columns with the finding ID; any other difference is a bug. Those regression tests may skip **only** when the gitignored `data/` fixtures are absent.
11. **The repo is public.** Client data (workbooks, extracted data, real farm names or values) is never committed; fixtures are synthetic. Secrets live only in `infra-secrets/water-management/`.
12. **Test the area you changed; the full suite is CI's job.** While working, run `pnpm test:changed` (typecheck + the vitest files your changes touch), or `pnpm check` plus the tests for what you touched by hand: the vitest files or directories you changed, the DB test files for backend/SQL you changed, and the e2e specs for the screens you changed. Before a commit, `pnpm check && pnpm test` plus those targeted DB/e2e files. **Don't run the full `test:backend:db` or `test:e2e` locally, and never run the suites one after another**: GitHub Actions runs the whole suite on every push to `main` and every PR, with e2e split into 14 parallel shards (`.github/workflows/ci.yml`). Don't have parallel agents run full suites either: give each agent targeted test commands. Commands: `docs/STACK.md` § Running tests.

## Working alongside other Claude sessions

Several Claude sessions may share this checkout, its working tree and its git index. `.claude/hooks/git-scope-guard.py` enforces these rules; if it denies a command, use the scoped alternative its message names. The full workflow and the reasons: `docs/contributing.md` § Git workflow.

- **Every change reaches `main` through a PR; never push or commit on `main`.** One worktree per PR branch, off `origin/main` (`git worktree add ../wm-<slug> -b <type>/<slug> origin/main`). Don't merge your own PR unless the operator asks. No `Co-Authored-By`/generated-by trailer in commits or PR bodies.
- **Commit path-scoped, always:** `git commit -m "…" -- <paths>`. Bare `git commit`, `git add -u/-A/.`, `git commit -a` and `--amend` with staged changes are blocked.
- **Only touch what your task owns**, and **never whole-tree:** no `git add .`, `checkout/restore .`, `reset --hard`, `git rm .`, `git stash`, `git clean -f`.
- **HEAD moves under you.** Commits you didn't make and files you didn't change are other sessions' work; leave them. Update a PR branch that falls behind by merging `origin/main`, not rebasing.

## Code organization

- Group `src/lib`, `.claude/agents/`, `.claude/commands/` and `docs/` by topic once they pass a flat handful; co-locate each test beside its module.
- No preemptive abstraction: extract on the third caller. Pin rendered behaviour with an e2e test before folding duplicated UI into a component.
- The root `package.json` `scripts` block follows the estate format (grouped `//--` dividers, `verb:surface` names, one-liners only) and `pnpm test:scripts` guards it. Details: `docs/contributing.md` § Root package.json scripts.

## Every code change updates tests + docs in the same change

1. Add or update tests for the workspace you touched. If something is genuinely untestable (config, infra, pure styling), say so explicitly — don't skip silently.
2. Update the relevant file in `docs/` if the change affects architecture, commands, env vars, deployment, or features. A one-line doc edit is still an edit.

Treat "code changed, docs and tests unchanged" as an incomplete task — flag it before handing back.

## Fix bugs at the source — never adjust the test to hide them

When a test fails, the only acceptable resolution paths are:

1. **The test itself is broken** (wrong fixture, missing required field, typo, race in test setup, unique-constraint collision with seed data). Fix the test.
2. **The app has a real bug or missing primitive.** Fix the app code. If the app needs a new affordance for the test to wait deterministically (a `data-ready` attribute backed by a real readiness signal, an exposed status, a broadcast handshake), add it in the app code — it's a real API, not test scaffolding.

There is no third option. These are forbidden because they ship the bug behind a green check:

- Inflating a Playwright `expect` / `toBeVisible` timeout to absorb a flake (`5_000` → `15_000` → `30_000`). Fix whatever makes the page slow.
- `await page.waitForTimeout(N)` between two actions. Wait on a real signal (DOM node, state attribute, network response).
- Bumping `--retries` (or relying on Playwright's `retries: 1`) to mask a real race.
- `test.skip(…)` / `test.fixme(…)` / `test.fail(…)` against a real bug without an open follow-up that names what's broken + when it'll be fixed.
- Loosening strict assertions (`toHaveText('Race armed')` → `toContainText(/arm|connect|ready/i)`) to "absorb variance" — the variance IS the bug.
- Replacing a real wait with a sleep "because the real signal is unreliable" — the real signal needs fixing.

If you spot a candidate fix that fits one of those patterns: stop, surface the underlying app issue, and either fix it in the same session or flag it explicitly to the operator. Don't half-mask it via the test.

## Fix the root cause; recommend the durable fix; don't leave findings dangling

- **Fix the root cause, not the symptom.** The "fix bugs at the source" rule above is the test-specific case of a general one: no masking a real failure anywhere — inflated timeouts, sleeps, blanket retries, swallowed errors, `try/catch` that hides a failure. If you can't fix it now, surface it explicitly; don't half-mask it.
- **Recommend the long-term solution.** When a quick patch and a durable fix diverge, name the durable fix and its tradeoffs even if you also ship the patch — don't let an expedient workaround pass as the answer.
- **No dangling "deferred" / "out-of-scope" findings.** A real issue you surface — in a review, an audit, a code comment, or your own analysis — gets driven to resolution, not left as a passing mention. Default: fix it the same session when it's bounded and you've already diagnosed it. Only when a fix is genuinely too large or risky may you defer — and a deferral is a tracked follow-up (a GitHub issue or Jira ticket — confirm before creating), naming what's broken, the durable fix, and the trigger to do it. Surfacing starts the obligation; it doesn't end it.

## UI verification

Don't spin up the dev server to visually verify UI/frontend changes before reporting a task complete. `pnpm check` + `pnpm test` (or the stack's equivalent — see `docs/STACK.md`) are sufficient; the operator reviews visuals themselves. Only run the dev server if explicitly asked.

## Claude tooling

Agents live in `.claude/agents/` by team (`engineering/`, `design/`, `audit/`, `personas/`, `i18n/`, `legal/`); commands in `.claude/commands/`. The index is `.claude/README.md`. The ones to reach for:

- `/issue <n>` — work one GitHub issue end to end: worktree, route, `/check`, PR.
- `/check` — pre-commit gate over the diff (review, test gaps, doc gaps; migration and UI review when those are touched).
- `/safe-edit` — reviewer loop for security-sensitive or load-bearing changes. `/safe-migration` — any change under `backend/migrations/`.
- `/polish-ui` — build or review one screen to `docs/design/ui-playbook.md`.
- `/audit/<area>`, `/audit/all`, `/persona`, `/release-readiness` — periodic sweeps and the pre-release gate.

## Where to look

`docs/STACK.md` first; the rest of `docs/` from its § Where to look. Which files the `templates` repo's `base` branch owns: `docs/contributing.md` § Base-owned files.
