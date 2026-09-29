---
description: Audit the privacy posture against POPIA (and GDPR if asked) — the personal-data record, lawful bases, notice, retention, transfers, breach procedure — via compliance-auditor
---

Check that the app still keeps only the personal information
`docs/security.md` § Personal information (POPIA) records, for the periods it
records, and that the open *(confirm)* items are still tracked. The
information officer and counsel own the legal calls; this is the evidence
they work from.

## Procedure

1. Spawn one **`compliance-auditor`** agent with the prompt `Audit area: popia.`
   It checks, with `file:line` evidence:
   - every table in the record exists with the retention and deletion outcome
     it claims, and every table holding personal data is in the record;
   - the purge jobs in `backend/src/jobs/` do what the retention column says;
   - `/privacy` and `/terms` match what the code keeps and shares;
   - sub-processors and the deployment region (`af-south-1`, or a cross-border
     transfer under s72);
   - `docs/legal/incident-procedure.md` and `docs/legal/operator-agreement.md`
     exist and match the system; `docs/legal-status.md` lists what's open;
   - for GDPR only if the operator names it: the Art 13 and Art 27 extras.
2. Relay its report as is: findings most severe first, then Clean.

Legal readings end with "confirm with counsel". A question that needs a reasoned legal position goes to the `za-legal-researcher` agent.

Read-only. Don't apply fixes; offer them, one path-scoped commit per finding
on a PR branch.

## When

After adding a table, column, job, mail or outbound call that touches a person, and before a release.
