---
description: Check that the app still sets only strictly necessary cookies and loads no third-party script, font or tracker, so no consent banner is needed — via compliance-auditor
---

The recorded position is two strictly necessary cookies (`wm_session`,
`wm_device`), no analytics and no third-party origins, so no banner
(`docs/security.md` § Personal information). A finding is anything that
changes that.

## Procedure

1. Spawn one **`compliance-auditor`** agent with the prompt `Audit area: cookie-consent.`
   It checks, with `file:line` evidence:
   - every `Set-Cookie` in `backend/src/`, and `localStorage` /
     `sessionStorage` keys in `frontend/src/` and whether they identify a person;
   - any `<script>`, font, image or `fetch` to another origin, and the CSP that
     would allow it;
   - the privacy notice's cookie section matches.
2. Relay its report as is: findings most severe first, then Clean.

List each cookie and storage key with its purpose and whether it is strictly necessary.

Read-only. Don't apply fixes; offer them, one path-scoped commit per finding
on a PR branch.

## When

After adding a cookie, a stored key or an external asset, and before a release.
