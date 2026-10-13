---
description: Open one draft PR for an ad hoc testing session, fix each issue the operator sends into it, and mark it ready when they say so. `/draft [topic]` opens, `/draft resume <pr>` picks one up again, `/draft ready` finishes.
argument-hint: "[topic] | resume <pr> | ready"
---

The operator is testing the app by hand and will send issues one at a time.
Every fix lands in **one** draft PR; it stays a draft until the operator says
it's ready. Mode is `$ARGUMENTS`:

- empty or a topic → **Open**
- `resume <pr>` → **Resume**
- `ready` → **Ready**

## Open

1. Branch in a worktree off a fresh `main` (CLAUDE.md § Working alongside
   other Claude sessions):
   ```
   git fetch origin main
   git worktree add ../wm-adhoc-<slug> -b fix/adhoc-<slug> origin/main
   ```
   `<slug>` is the topic, or today's date (`YYYY-MM-DD`) when there is none.
2. GitHub won't open a PR without a commit, so start with an empty one, then
   push:
   ```
   git -C ../wm-adhoc-<slug> commit --allow-empty -m "chore: open the ad hoc testing fixes branch"
   git -C ../wm-adhoc-<slug> push -u origin fix/adhoc-<slug>
   ```
3. Open the draft: `gh pr create --draft --base main --title "fix: ad hoc
   testing fixes (<topic or date>)"` with `.github/pull_request_template.md`
   as the body: the Summary says it collects fixes from ad hoc testing, and
   Changes starts as `_(none yet)_`.
4. Reply with the PR link and the worktree path, then wait for the first
   issue.

## Resume

`gh pr view <pr> --json headRefName,isDraft,body`. Find its worktree with
`git worktree list` (or add one for the branch), merge `origin/main` into it
if it fell behind (merge, never rebase), and carry on from **Each issue**.

## Each issue

The main session stays free to talk: it triages each issue and hands the
fix to a **background subagent** (the Agent tool, `run_in_background`), one
per issue, then goes back to the operator. It never fixes an issue inline,
except a one-line change it has already diagnosed.

For every issue the operator sends, until they say ready:

1. **Triage (main session).** Restate it in one line. Ask only if two
   readings would build different things; otherwise pick the reasonable one
   and say which. Dig only as far as you need to brief the agent: the
   screen, the likely files, what you've ruled out.
2. **Dispatch.** Start a background `general-purpose` subagent (or the
   specialist the area needs) with a self-contained brief: the issue in the
   operator's words (screenshots described, since the agent can't see them),
   what you've learned, the worktree path and branch, and these rules:
   - Work only in the PR's worktree; never touch `main` or the main checkout.
   - **Reproduce, then fix the cause** (CLAUDE.md § Fix bugs at the
     source), with a failing test first where one fits. Route by what it
     touches, as `/issue` § 3 does: `/safe-migration` for SQL, `/safe-edit`
     for auth, RLS, tokens, personal data, the queue, Lambda entry points or
     `infra/`, `ENGINE_VERSION` and the `engine-reviewer` for model
     behaviour, the i18n agents for farmer-facing strings.
   - **Tests and docs in the same commit** (CLAUDE.md § Every code change
     updates tests + docs). Run only what it touched: `pnpm test:changed`
     plus the DB and e2e files for the area (CLAUDE.md rule 12), never a
     full suite.
   - **Agents share the worktree's test database and e2e slot**
     (`water_test_w<tag>`, `water_e2e…`, testing.md § Several checkouts at
     once), so two running DB tests or e2e at once break each other (missing
     tables, deadlocks). Take the worktree's lock around any DB test, e2e
     spec or `pnpm test:changed` run (it runs DB tests when Postgres is up),
     and drop it straight after:
     `until mkdir "$(git rev-parse --git-dir)/draft-test.lock" 2>/dev/null; do sleep 5; done; <command>; rmdir "$(git rev-parse --git-dir)/draft-test.lock"`.
     Unit tests and typechecks don't need it.
   - **One path-scoped commit**:
     `git commit -m "fix(<area>): <what>" -- <paths>`, then
     `git push -u origin <branch>` (name the branch; a bare `git push` is
     refused). No `Co-Authored-By` or generated-by trailer. If git reports
     `index.lock` or the push is rejected because another agent pushed
     first, wait, `git pull --no-rebase origin <branch>`, and try again.
   - Don't edit the PR body; report back the cause, the fix, the commit
     hash, the files and the commands run, or why it stopped.
   - If the fix needs a product decision, client data or an operator
     action (a Terraform apply, a production data load), stop and report
     rather than guess.
3. **Run agents in parallel when their issues touch different areas**; when
   two would edit the same files, queue the second until the first reports.
   Tell the operator in one line what was dispatched, then take the next
   issue.
4. **When an agent reports (main session):** check its commit is on the
   branch (`git log origin/<branch>`) and its diff is what was asked. Add
   one bullet under the PR body's Changes (`gh pr edit <pr> --body-file …`;
   only the main session edits the body, so updates don't race) and tick
   the Surface touched boxes. Then tell the operator in two or three lines:
   the cause, the fix, the commit. Relay a stop or a question as it is.

If an issue turns out too large or risky for this PR (a migration with a
backfill, a design question for the client), say so and offer a separate
issue or PR rather than folding it in. Don't let it drop (CLAUDE.md § Fix the
root cause).

Don't watch CI after every push. Glance at `gh pr checks <pr>` between issues
and dispatch a fix for a red job this PR caused.

## Ready

Only when the operator says so:

1. Wait for every dispatched agent to report, then merge `origin/main` if
   the branch fell behind.
2. `pnpm check && pnpm test`, plus the targeted DB and e2e files for
   everything the PR touched.
3. `/check` over the whole branch (`git diff origin/main...HEAD`). Apply the
   findings you agree with; say why for the rest in the PR body.
4. Make the title name what the fixes are about, as a conventional commit
   (`fix(<scope>): <subject>`, lowercase, no period; CI's `pr-title-lint`).
   Use no scope when the fixes span areas.
5. `gh pr ready <pr>`, then drive it to green with the `steward` skill
   (`.claude/skills/steward/SKILL.md`), code-scanning alerts included
   (`/issue` § 7). Don't merge; that's the operator's call.
6. Report the link, the list of fixes, and anything the operator needs to
   decide.
