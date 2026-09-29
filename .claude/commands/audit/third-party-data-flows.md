---
description: Map every outbound call that carries personal information into a sub-processor list and check it against the privacy notice — via compliance-auditor
---

The recorded position is AWS only (hosting, RDS, S3, SES, CloudWatch), with
the data-feed hosts (CHIRPS, DWS) receiving no personal data
(`docs/security.md` § Personal information). Check the code still agrees.

## Procedure

1. Spawn one **`compliance-auditor`** agent with the prompt `Audit area: third-party-data-flows.`
   It checks, with `file:line` evidence:
   - every outbound call: `fetch(` in `backend/src/`, AWS SDK clients,
     `nodemailer`, the renderer's Chromium navigation;
   - what personal data each carries, the region, and why;
   - any origin the SPA contacts besides its own API (the CSP should allow none).
2. Relay its report as is: findings most severe first, then Clean.

Output a sub-processor table (provider, data, region, purpose, the security.md line it matches) and the findings where code and record disagree.

Read-only. Don't apply fixes; offer them, one path-scoped commit per finding
on a PR branch.

## When

After adding an outbound integration or a mail path, and before a release.
