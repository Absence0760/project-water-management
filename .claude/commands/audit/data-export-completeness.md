---
description: Check that "Download my data" (GET /auth/me/export) includes every piece of personal information the app keeps about the person — via compliance-auditor
---

A POPIA access request is answered by `GET /auth/me/export`
(`backend/src/auth/export.ts`, `buildSubjectExport`). Silent drift is the
risk: a new table or column about a person that the export never learns
about.

## Procedure

1. Spawn one **`compliance-auditor`** agent with the prompt `Audit area: data-export-completeness.`
   It checks, with `file:line` evidence:
   - every table and column in `docs/security.md` § Personal information that
     refers to the person, against what `buildSubjectExport` selects;
   - migrations newer than the export's last change that add such a column;
   - the export doesn't include other people's data it shouldn't (another
     farmer's name, an assessor's notes);
   - the format stays machine-readable, and `auth/export.db.test.ts` asserts
     the new parts.
2. Relay its report as is: findings most severe first, then Clean.

Name the table and column for each gap, and the test case that would have caught it.

Read-only. Don't apply fixes; offer them, one path-scoped commit per finding
on a PR branch.

## When

After a migration that adds personal data, and before a release.
