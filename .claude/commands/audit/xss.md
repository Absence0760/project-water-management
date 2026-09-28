---
description: Audit every place user or imported text reaches the DOM, a report PDF or an email as HTML — {@html}, dynamic href/src, SVG, CSP, mail templates — via repo-security-auditor
---

Find every path where text a user controls (project, node and farm names,
notes, imported workbook cells, CSV headers, share-link views, alert
subjects) is rendered as HTML rather than text, in the SPA, the report page
the renderer prints to PDF, or an email.

## Procedure

1. Spawn one **`repo-security-auditor`** agent with the prompt `Audit area: xss.`
   It checks, with `file:line` evidence:
   - `{@html}` and `innerHTML` in `frontend/src/` (the allowed uses are pinned
     by `frontend/src/lib/rawHtml.test.ts`);
   - dynamic `href` / `src` from user data (`javascript:`, `data:`), guarded by
     `frontend/src/lib/urlAttributes.security.test.ts`;
   - SVG or chart labels built from user strings;
   - the CSP layers (`infra/security_headers.tf`, SvelteKit's hashed meta CSP,
     `infra/scripts/check-csp.mjs`) and anything that would weaken them;
   - the report route the headless renderer prints (`backend/src/reports/`);
   - HTML escaping and header (CRLF) injection in every mail template
     (`backend/src/mail/`, `backend/src/auth/accountMail.ts`).
2. Relay its report as is: findings most severe first, then Clean.

For each finding, give a payload that proves it and the place the escaping belongs.

Read-only. Don't apply fixes; offer them, one path-scoped commit per finding
on a PR branch.

## When

After adding a page that renders user text, a report section, or a mail template, and before a release.
