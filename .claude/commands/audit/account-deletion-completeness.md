---
description: Check that deleting an account (the operator deletes the app_user row) removes or pseudonymises every piece of personal information, including S3 objects — via compliance-auditor
---

On a POPIA deletion request the operator deletes the `app_user` row as the
schema owner, and the database does the rest: every foreign key to
`app_user` cascades, sets null or restricts (`APP_USER_ON_DELETE` in
`backend/src/db/catalogue.db.test.ts`), and `app_user_pseudonymise` clears
names from the audit log and reports.

## Procedure

1. Spawn one **`compliance-auditor`** agent with the prompt `Audit area: account-deletion-completeness.`
   It checks, with `file:line` evidence:
   - a foreign key to `app_user` missing from `APP_USER_ON_DELETE`, or classified
     differently from `docs/security.md` § Personal information;
   - a person's email, name or id stored as text or JSON that no key reaches
     (`auth/personal-data.security.db.test.ts` sweeps for survivors: is it
     still current?);
   - a trigger or guard that makes the deletion fail;
   - S3 objects (report PDFs) and SES suppression entries that outlive the
     person;
   - a restrict key that blocks deletion without the documented operator step.
2. Relay its report as is: findings most severe first, then Clean.

For each gap, the table or object, what should happen to it, and the migration or test that changes.

Read-only. Don't apply fixes; offer them, one path-scoped commit per finding
on a PR branch.

## When

After a migration that adds a foreign key to `app_user` or a column naming a person, and before a release.
