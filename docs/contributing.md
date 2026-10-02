# Contributing: git workflow, code organization, root scripts

The rules are in the root `CLAUDE.md`; this is the detail behind them, kept
out of `CLAUDE.md` because that file loads into every Claude session.

## Git workflow

More than one Claude session may run in **this one checkout at the same time** — sharing a single working tree *and* a single git index, so a careless `git add` + `git commit` sweeps up another session's in-flight work. The `.claude/hooks/git-scope-guard.py` PreToolUse hook enforces the rules below; if a git command is denied, its message names the scoped alternative — follow it, don't work around it.

- **Every change reaches `main` through a pull request; never push `main`.** `main` is protected on GitHub (PRs only, for admins too) and the hook blocks any push to it. For each piece of work: make a worktree on a new branch off `origin/main` (`git fetch origin && git worktree add ../wm-<slug> -b <type>/<slug> origin/main`), commit there (path-scoped, one logical unit per commit), push the branch (`git push -u origin <type>/<slug>`), and open a PR (`gh pr create --fill` or a written title/body). The PR title must be a conventional commit, `<type>(<scope>): <subject>` with the type one of feat, fix, chore, docs, refactor, test, perf, ci, build or revert and the subject starting lowercase with no closing period (`fix(api): return null for a project with no import report`): `.github/workflows/pr-title-lint.yml` fails anything else, and `.claude/hooks/git-scope-guard.py` refuses a `gh pr create`/`gh pr edit` whose `--title` wouldn't pass (with `--fill` the title is the first commit's subject, so write that one the same way). Don't merge it yourself unless the operator asks; merging is their call. Keep the main checkout on `main` and only fast-forward it (`git pull --ff-only`) after a merge. Never commit on `main` itself. (No `Co-Authored-By`/generated-by trailer in commits or PR bodies; write them as a human would.)
- **Commit path-scoped, always:** `git commit -m "…" -- path/to/file ...`. A path-scoped commit records only those paths and ignores anything else staged. Bare `git commit`, `git add -u/-A/.`, `git commit -a`, and `git commit --amend` *with staged changes* are blocked — they snapshot the shared index.
- **Only touch what your task owns.** Don't stage, edit, delete, or `restore` files outside your task. Before committing, `git status` and confirm every path is yours.
- **Never whole-tree:** no `git add .`, `checkout/restore .`, `reset --hard`, `git rm .`, `git stash` (without `-- <path>`), or `git clean -f` — each clobbers across the tree.
- **HEAD moves under you.** Other sessions commit mid-task (and `origin/main` moves as PRs merge); your path-scoped commits still stack cleanly, and a PR branch that falls behind is updated by merging `origin/main` into it (not rebasing a shared branch). A PR that adds a migration re-checks its number against `origin/main` before it merges, since another PR may have taken a later one (`pnpm check:migrations`, [data-model.md § Migrations](./data-model.md#migrations)). Don't be alarmed if `git log` shows commits you didn't make, or files you didn't change show as modified — leave those alone.
- **Worktrees are the default, not only for large work:** a PR branch always gets its own worktree, so switching branches never disturbs another session's tree. Subagents doing parallel file edits should pass `isolation: "worktree"`; merge their branches into your PR branch, not into `main`. Remove a worktree once its PR is merged (`git worktree remove ../wm-<slug>`).

## Code organization

- **Group `src/lib` (and equivalents) by topic, not by type.** Loose modules piling up at the `lib/` root is a smell — once there are more than a handful, move them into topical subfolders (`auth/`, `billing/`, `<domain>/`, …). Keep only generated/shared type files (`database.types.ts`, `types.ts`) at the root. **Co-locate each module's test beside it**; cross-cutting guard tests may stay at the root.
- **No preemptive abstraction.** Don't extract a shared helper or component on the *second* use — wait for the *third* caller, then extract. Three similar lines beat a premature wrapper, and a "bug fix" PR should not smuggle in a refactor.
- **Consolidating duplicated UI is a refactor, not a feature — pin it first.** When you fold repeated markup into a shared component, add an e2e test that pins the *rendered* behaviour **before** the extraction, so before/after is provably identical, then extract.
- **Group `.claude/agents/`, `.claude/commands/`, and `docs/` into topical subfolders** once each grows past a flat handful (e.g. `agents/auditors/`, `docs/features/`).
- If the project keeps a structure guard (a test asserting "no loose modules at the lib root", "the unit-test glob recurses", etc.), keep it green — it's the thing that stops the organization eroding. Such a guard is stack-specific (test runner + paths), so write it against your own setup rather than copying one.

## Root package.json scripts — one format, estate-wide

When the repo has a root `package.json`, its `scripts` block is the single entry point for every recurring task, and it follows the format `project-running/package.json` established (that file is the canonical exemplar — read it before restructuring scripts):

- **Group scripts with comment keys**: a `"//-- <group> --": "<one-line description>"` divider entry above each cluster. The description carries the load-bearing facts a session needs (ports, prerequisites, doc pointers), not filler.
- **Namespaced, verb-first, colon-separated names**: `setup[:*]` (one-time bootstrap), `dev:*` (orchestrators like `dev:core`/`dev:full`, then `dev:db:*`, `dev:run:<app>`, per-service groups), `build:<surface>`, `check:<surface>`, `test:<surface>[:unit|:e2e]`, `gen:<what>`. Long-running services reuse the same lifecycle verbs: `up` / `down` / `status` / `logs`.
- **JSON holds one-liners only.** Anything longer delegates to a script under `bin/` or `scripts/`; workspace delegation goes through `pnpm -C apps/<x> <script>`.
- **New scripts join an existing group** (or add a new `//--` divider in the right place) — never append ungrouped entries at the bottom.
- **Keep a `test:scripts` guard** that validates the root script targets (referenced files exist, delegated workspace scripts resolve). project-running's `scripts/check_root_scripts.mjs` is the reference implementation; it's layout-specific, so write yours against your own tree rather than copying it verbatim.

Treat a root scripts block that drifts from this format like any other structure-guard violation: fix the format in the same change that touches it.

## Base-owned files

This repo started from a template branch in the `templates` repo. Its `base`
branch owns the shared scaffolding; a rule worth applying to every project is
proposed there, not forked here.

- `.github/workflows/gitleaks.yml` — secret scanning
- `.github/workflows/audit.yml` — weekly `pnpm audit` + auto-issue
- `.github/workflows/security.yml` — CodeQL static analysis + container scanning
- `.github/workflows/scorecard.yml` — OSSF Scorecard
- `.github/workflows/claude.yml` — Claude Code automation on PRs/issues
- `.github/workflows/dependabot-auto-merge.yml` — auto-merges minor/patch Dependabot PRs
- `.github/workflows/dependabot-lockfile.yml` — re-syncs pnpm lockfile on Dependabot PRs
- `.github/dependabot.yml` — dependency update PRs
- `SECURITY.md` — vulnerability reporting policy

`.claude/` and `CLAUDE.md` started there too, but the agents and commands are
adapted to this app (`.claude/README.md`).
