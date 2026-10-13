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

For every issue the operator sends, until they say ready:

1. **Understand it.** Restate it in one line. Ask only if two readings would
   build different things; otherwise pick the reasonable one and say which.
2. **Reproduce, then fix the cause** (CLAUDE.md § Fix bugs at the source).
   A failing test first where one fits. Route by what it touches, as
   `/issue` § 3 does: `/safe-migration` for SQL, `/safe-edit` for auth, RLS,
   tokens, personal data, the queue, Lambda entry points or `infra/`,
   `ENGINE_VERSION` and the `engine-reviewer` for model behaviour, the i18n
   agents for farmer-facing strings.
3. **Tests and docs in the same commit** (CLAUDE.md § Every code change
   updates tests + docs). Run only what you touched: `pnpm test:changed`
   plus the DB and e2e files for the area (CLAUDE.md rule 12).
4. **Commit path-scoped, one commit per issue**:
   `git commit -m "fix(<area>): <what>" -- <paths>`, then `git push`.
   No `Co-Authored-By` or generated-by trailer.
5. **Update the PR body**: add one bullet under Changes naming the issue and
   the fix (`gh pr edit <pr> --body-file …`), and tick the Surface touched
   boxes it now covers.
6. **Report in two or three lines**: the cause, the fix, the commit, what
   you ran. Then wait for the next issue.

Issues can arrive while one is in progress; queue them and take them in
order. If one turns out too large or risky for this PR (a migration with a
backfill, a design question for the client), say so and offer a separate
issue or PR rather than folding it in. Don't let it drop (CLAUDE.md § Fix the
root cause).

Don't watch CI after every push. Glance at `gh pr checks <pr>` between issues
and fix a red job this PR caused before the next issue.

## Ready

Only when the operator says so:

1. Merge `origin/main` if the branch fell behind.
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
