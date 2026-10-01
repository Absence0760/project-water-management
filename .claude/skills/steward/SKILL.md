---
name: steward
description: How to drive a pull request in this repo to green and mergeable — reading CI, reproducing each job locally, what counts as a flake, updating a branch that fell behind, answering reviews, and when to ask the operator. Use when watching, fixing or babysitting a PR here.
---

# Steward: driving a PR to green in water-management

Repo-specific conventions for a session that owns or watches a PR. The root
`CLAUDE.md` rules still apply; this adds how CI here behaves and what to do
about it.

## Read the PR first

On every wake, look at the whole PR on its current head: merge state, the
`CI gate` check, every open review thread. `CI gate` (the `ci-gate` job in
`.github/workflows/ci.yml`) is the one required check: it fans in on every
job and is green only when none failed. A red `CI gate` names the upstream
job that failed; that job is the thing to fix.

`pr-mergeable` failing means GitHub couldn't build a merge ref (a conflict),
so **ci.yml didn't run at all**: green-looking PR checks from the other
workflows prove nothing. Resolve the conflict first.

## Docs-only PRs

The `changes` job decides whether anything besides `docs/`, `.claude/` and
`*.md` changed. If not, most jobs are skipped (skipped counts as passing).
Jobs that still run on a docs-only PR: `claude-tooling`, `gitleaks`, and the
`pull_request_target` workflows (`pr-title-lint`, `labeler`, `pr-mergeable`).
So a `.claude/` change is checked by `pnpm check:claude`; run it before
pushing.

## Reproduce a failed job locally

Run the same command the job runs, scoped to what failed. Never the whole
`test:backend:db` or e2e suite (CLAUDE.md rule 12).

| Job | Locally |
|---|---|
| Typecheck and unit tests (`test`) | `pnpm test:scripts`, `pnpm check`, `pnpm test`, then for build failures `pnpm build`, `pnpm check:bundle`, `pnpm check:i18n`, `infra/scripts/package-lambdas.sh` |
| Backend DB tests (`db-test`) | `pnpm dev:db:up`, then the failing file: `pnpm -C backend exec vitest run --project db <file>` |
| E2E shards (`e2e`, 14 of them) | the failing spec only: `pnpm -C e2e e2e tests/<spec>.spec.ts > e2e.log 2>&1` (never piped into `grep`/`head`: it hangs). `server-report.spec.ts` needs `pnpm dev:s3:up` and `pnpm dev:mail:up` |
| Workflow lint + guards (`workflow-lint`) | `pnpm check:workflows`, `pnpm check:pins`, `pnpm test:guards` |
| Claude tooling (`claude-tooling`) | `pnpm check:claude` |
| Env isolation | `pnpm check:env` |
| Workbook importer (Python) | `python -m unittest discover -s scripts/wbt-import` |
| Terraform | `pnpm check:infra` |
| Renderer image | `pnpm check:renderer-image` (docker, ~3.5 GB; only when the renderer or its pins changed) |
| gitleaks | the finding names the file and rule; remove the secret and treat it as leaked (rotate), never allowlist a real one |
| `pr-title-lint` | the title is `type(scope): lowercase subject` with no trailing period (`.github/workflows/pr-title-lint.yml`) |

Read the failure first: `gh run view <run> --log-failed`, or the job log
through the GitHub tools. An e2e failure has the merged HTML report from
the `e2e-report` job as the `playwright-report` artifact.

## Flakes

"Flake" is not a root cause. A test that fails once and passes on a re-run
is still a bug in the test or the app: find the race (CLAUDE.md § Fix bugs at
the source). What's never allowed: a bigger timeout, a `waitForTimeout`, a
retry, `test.skip`/`fixme`, a loosened assertion, `networkidle`.

A re-run is fine once, and only to confirm a failure that isn't this PR's:
the job died before any test ran (checkout, install, runner loss), or the
same check is red on `main` too. Tests that need a service locally skip with
a warning but fail under CI on purpose (`docs/testing.md` § Tests that need a
service or a browser): a CI failure there is real.

## A branch that fell behind

Merge `origin/main` into the PR branch, never rebase a branch someone else
may have checked out, never force-push:

```
git fetch origin
git merge origin/main
```

A conflict in `pnpm-lock.yaml`: take `main`'s, then `pnpm install` to
regenerate. A conflict in a generated file (`ids.generated.ts`,
`limitations.generated.ts`, a translation sheet): regenerate it with its
`gen:*` script, never merge it by hand. Two migrations with the same number:
renumber yours after the latest on `main` (the runner refuses a pending file
that sorts before the latest applied one). A conflict on `BUDGET.totalCodeKb`
or the old change log in `scripts/guards/check_web_bundle_budget.mjs`: the
branch predates bundle-budget entry files. Take `main`'s copy of the guard
and turn the branch's raise into an entry file (`pnpm gen:bundle-budget`),
as `scripts/guards/bundle-budget/README.md` § Converting says; no rebuild
needed, CI measures the merged build.

## Reviews

- A small, local ask (a rename, a nit, an added test): do it, push, reply in
  the thread naming the commit, resolve it.
- A larger or design-level ask: reply with a proposal and ask the operator
  before building it.
- Review agents (`code-reviewer`, `engine-reviewer`, `ui-designer` review)
  can be run locally on the branch to pre-empt the same findings: `/check`.

## Ask the operator before

- Anything irreversible or outside the PR: a Terraform `apply`, a release,
  touching the `production` environment, deleting a branch that isn't yours.
- Merging. Merging is the operator's call even when everything is green.
- A fix that needs a decision marked **Needs hydrologist** in
  `docs/engine-audit.md`, or a legal reading (`docs/legal-status.md`).

## Done

A PR is done when `CI gate` is green on the current head, it merges cleanly,
and no review thread is waiting on you. Then say so once, with the link, and
stop; nothing else is yours until the base, CI or a review changes.
