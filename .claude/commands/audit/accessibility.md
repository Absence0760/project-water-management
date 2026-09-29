---
description: WCAG 2.2 AA sweep of the web app, farmer pages and phone layouts first — via compliance-auditor
---

Find where the web app misses WCAG 2.2 AA. Farmers use the farm view,
`/share`, sign-in, account and alert pages on phones, so those come first;
the workspace is a desktop tool for hydrologists and WUA staff.

## Procedure

1. Spawn one **`compliance-auditor`** agent with the prompt `Audit area: accessibility.`
   It checks, with `file:line` evidence:
   - semantic structure, names on icon buttons and inputs, table headers
     (`frontend/src/lib/a11y/`), focus order and visibility, keyboard reach,
     `prefers-reduced-motion`;
   - contrast, computed from the design tokens, not guessed;
   - 390 px layouts and zoom to 200 %;
   - charts: a text alternative for each (uPlot canvases carry none by default);
   - what `e2e/tests/a11y.spec.ts` covers and what it doesn't.
2. Relay its report as is: findings most severe first, then Clean.

Compute every contrast or size claim. For fixing what this finds, `/a11y-hunt` is the loop; the `persona-accessibility-user` agent gives the human view.

Read-only. Don't apply fixes; offer them, one path-scoped commit per finding
on a PR branch.

## When

After a screen redesign, and before a release.
