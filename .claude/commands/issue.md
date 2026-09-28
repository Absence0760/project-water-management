---
description: Work one GitHub issue end to end — read it, branch in a worktree, route the work to the right workflow and agents, gate it with /check, and open a PR that closes the issue. The default entry point for a session driven by an issue.
argument-hint: <issue number or URL>
---

Take issue `$ARGUMENTS` from "open" to "a PR that closes it, green and
reviewed". One issue per session and one PR per issue, unless the issue
itself splits into independent parts (then one PR per part, each naming the
issue).

## 1. Read the issue

`gh issue view <n> --comments` (or the GitHub tools). Take in the body, every
comment, the labels, and any linked issues, PRs or docs. Then, in two or three
lines, state the goal, what "done" looks like, and anything the issue leaves
open. If a fork changes what gets built (two readings of the ask, a product
decision), ask before building; if it's a detail, pick the reasonable default,
say which, and carry on.

Check it isn't already done or in flight:
`gh pr list --search "<n> in:body" --state all`.

## 2. Branch in a worktree

```
git fetch origin
git worktree add ../wm-<n>-<slug> -b <type>/<n>-<slug> origin/main
```

`<type>` is `fix`, `feat`, `docs`, `chore` or `test`. If the session was
given a branch name, use that instead. Work only in the worktree (CLAUDE.md
§ Working alongside other Claude sessions).

## 3. Route the work

Read the docs for the area first (`docs/STACK.md` § Where to look). Then pick
the workflow by what the issue touches; more than one can apply.

| The issue touches | Use |
|---|---|
| A bug | Reproduce it first (a failing test is best), fix the cause, keep the test (CLAUDE.md § Fix bugs at the source) |
| `backend/migrations/` (a table, column, policy, grant, function) | `/safe-migration` |
| Access, tokens, auth, RLS, personal data, the job queue, a Lambda entry point, `infra/` | `/safe-edit` (coder, reviewer, fix, re-review) |
| A screen's layout or design | `/polish-ui <screen>` (the `ui-designer` agent, `docs/design/ui-playbook.md`) |
| Model behaviour in `packages/engine` | bump `ENGINE_VERSION`; judge it by `docs/model.md`, `docs/engine-audit.md` and the invariant tests, not by the workbook |
| Farmer-facing strings | write the English with `t()` / `msg()`; `pnpm gen:i18n:sheet`; then the `i18n-translator` and `i18n-checker` agents and `pnpm gen:i18n:apply <lang>` for each language (`docs/ui.md` § Language) |
| A legal question (POPIA, liability, the National Water Act) | the `za-legal-researcher` agent, before building |
| A domain question (would a hydrologist, WUA manager, farmer or assessor accept this?) | the matching `persona-*` agent, read-only |
| Anything else | build it directly |

Keep the diff to what the issue asks. A real problem you find on the way is
either fixed here (small, same area) or opened as its own issue; never left
as a passing remark (CLAUDE.md § Fix the root cause).

## 4. Test while you work

`pnpm test:changed`, plus the DB test files and e2e specs for what you
touched (CLAUDE.md rule 12, `docs/testing.md`). Never the full
`test:backend:db` or `test:e2e` locally.

## 5. Gate

1. `pnpm check && pnpm test`, plus the targeted DB and e2e files.
2. `/check` on the diff. Apply the findings you agree with; for the ones you
   don't, say why in the PR description.
3. Docs and tests changed with the code, or the PR says why not.

## 6. Commit, push, PR

- Commit path-scoped, one logical unit per commit:
  `git commit -m "<type>(<area>): <what>" -- <paths>`. No `Co-Authored-By`
  or generated-by trailer.
- `git push -u origin <branch>`. Never push `main`.
- Open the PR with `.github/pull_request_template.md`. The title reads like
  the commit subject; the body's Summary ends with `Closes #<n>` (or
  `Part of #<n>` for one part of a split issue).
- Don't merge it; that's the operator's call.

## 7. Drive it to green

Watch CI (`gh pr checks <pr>`). A failure is this PR's to root-cause unless
it's red on `main` too; `/fix-ci` is the loop. Answer review comments with a
fix or a reason. When it's green, say so once, with the link and anything
the operator needs to decide.

## 8. Clean up

After the PR merges: `git worktree remove ../wm-<n>-<slug>`, and in the main
checkout `git pull --ff-only`.
