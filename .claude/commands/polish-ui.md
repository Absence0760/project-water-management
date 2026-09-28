---
description: Design, build or review one screen to the app's UI standard (docs/design/ui-playbook.md). Delegates to the `ui-designer` agent. `/polish-ui <target>` builds; `/polish-ui review <target>` reports only.
argument-hint: [review] <section, route or component>, or "review diff"
---

Run the `ui-designer` agent on `$ARGUMENTS`.

## When to use it

**Right fit:**

- A workspace section or page that should follow option A (issue #17's
  "Remaining work" comment lists them: the Project page, Runs & results,
  Data, Transfers, Settings, Scenarios, Allocations, Applications, History).
- A screen that wastes the first viewport, scrolls when it's a dashboard,
  crowds out its results as data grows, runs out of colours, or doesn't stack
  on a phone.
- Before landing any UI change: `/polish-ui review diff` checks it against
  the playbook.

**Wrong fit (say so and stop):**

- A one-line CSS tweak: just edit it.
- A new feature with no design yet: plan the content first (a design spec in
  `docs/design/`, like the farmer view's).
- "Polish everything": pick one target; run the command again for the next.

## Resolving the target

- A **section name** ("Data", "Runs & results") → the tab in
  `frontend/src/lib/workspace/tabs.ts` and its component.
- A **route** (`/teams`, `/account`) → `frontend/src/routes/<route>/+page.svelte`.
- A **file path** → used as-is.
- `review diff` (or `review` with no target) → the working diff; `review
  <branch>` → that branch against `main`.
- Empty → list the open screens from #17's "Remaining work" comment with one
  line each on why it matters, and ask which.

## The flow

1. **Pre-flight:** the target exists; `pnpm check` passes on the tree (if it
   already fails, fix that first).
2. **Spawn `ui-designer`** with the mode and target on the first line:
   - build: `build: <target>. The operator's intent: <original argument>.`
     Pass `isolation: "worktree"` when other sessions or agents are working
     in this checkout.
   - review: `review: <target>.` (read-only; no worktree needed.)
3. **Relay the report:** files changed (`git diff --stat` or the branch's
   commits), screenshot paths, the "nothing lost" inventory check, the tests
   that ran, bundle numbers, and anything deferred. For a review, the
   findings ranked by impact.
4. **Land it** as the operator prefers (merge the worktree branch, run the
   gate, push per the memory rule); a review's findings are fixed in a build
   run or by hand.

## Cost

A build run redesigns a screen end to end (screenshots, specs, docs); it
earns its cost on layout-level changes, not padding tweaks.

## Not a replacement for

- `/check` (code review, test gaps, doc hygiene on a diff).
- `/a11y-hunt` and `/ux-hunt` (interaction and accessibility defects found
  by driving the app); `/persona` (domain users' point of view).
- `/safe-edit` for security-sensitive changes.
