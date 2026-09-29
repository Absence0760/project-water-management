---
description: Add or land a Postgres migration with the migration-coordinator agent in the loop. Applies locally, verifies RLS, runs the catalogue guards, surfaces type-sync edits (engine project.ts, frontend lib/api/types.ts, the route shapes; there is no codegen), proposes DB tests, flags doc updates.
argument-hint: <migration slug or path>
---

Run the new-migration workflow for `$ARGUMENTS`. Either author + coordinate the migration, or coordinate one the user has already drafted.

## When to use this command

**Right fit:**

- About to add a new file under `backend/migrations/`
- Just finished drafting a migration and want to verify before committing
- Modifying an unmerged migration and want to re-run the coordination steps

**Wrong fit — refuse:**

- Editing a migration already on `origin/main`: migrations are forward-only (CLAUDE.md rule 2); write a new `NNN_*.sql` instead

## What this command does

It is **not** the per-change reviewer (`/safe-edit`). It is the per-migration workflow that catches drift the reviewer can't easily see — RLS, policies, grants and same-project triggers on new project tables, the catalogue guards, manual type-sync between SQL and TypeScript (there is no codegen), and which DB test files need to grow.

The actual work is done by the `migration-coordinator` agent. This command is the orchestrator: figure out which migration we're talking about, invoke the agent, then prompt the user for the follow-up edits.

## Procedure

### 1. Resolve the migration

If `$ARGUMENTS` is:

- A **path** under `backend/migrations/` → use that file directly.
- A **slug** without a number → find the highest-numbered migration on `origin/main` (`git ls-tree --name-only origin/main backend/migrations/ | tail -1`) and propose `NNN_<slug>.sql` for the next slot. If the file doesn't exist yet, ask the user to draft it first (or prompt them with a starter template) — do not invent SQL on their behalf.
- **Empty** → run `git status` + `ls backend/migrations/` and identify the new or modified `.sql` file. If there's no candidate, abort with "no migration to coordinate."

### 2. Spawn the migration-coordinator agent

Once you have a concrete file path, invoke the agent with the prompt:

> "Coordinate the migration at `backend/migrations/<file>`. Output the format from your spec."

### 3. Relay the agent's report

The agent's output is the deliverable — relay it verbatim to the user. Do not summarise away the file paths or the proposed field signatures; those are the actionable bits.

### 4. Offer to apply the follow-up edits

After the agent returns, ask the user one focused question:

> "Want me to apply the type-sync edits now? [The agent proposed: ...]"

If yes (or the task already asked for a PR), apply only the proposed changes (no scope creep into adjacent interfaces). If no, end the turn — the user will handle it.

Same offer for the DB tests and doc updates, in that order. Each is opt-in.

### 5. Hand off the commit

When all the follow-up edits the user accepted are applied, hand off:

> "Ready when you are. Suggested commit: `feat(db): <slug>` — want me to stage + commit?"

Commit path-scoped (`git commit -m "…" -- <paths>`) on the PR branch, matching the recent log's style (`feat(db):` new tables or columns, `fix(db):` corrective migrations, `chore(db):` index- or trigger-only). No `Co-Authored-By` or generated-by trailer. Then push the branch and open a PR.

## What this command does NOT replace

- `/audit/auth` and `repo-security-auditor` (area `rls`): broad sweeps over every policy. `/safe-migration` is per-migration.
- `/check` — pre-commit gate that runs once you're ready to commit. Use it after `/safe-migration` if you want the doc-hygiene + test-gap pass on the working diff.
- `/safe-edit` — coder ↔ reviewer loop for non-migration changes. The two are complementary; for a migration that also touches routes (e.g. new endpoint backed by the new table), run `/safe-migration` first, then `/safe-edit` on the route work.

## Tone

User-facing text:

- A one-line "Coordinating migration `<file>`…"
- The agent's verbatim report.
- The opt-in follow-up questions, one at a time.
- The commit handoff.

Don't narrate the agent fan-out or repeat the agent's findings in your own words.
