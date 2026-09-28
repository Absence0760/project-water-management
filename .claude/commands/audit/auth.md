---
description: Sweep every backend route for auth gating, role checks and RLS discipline (withUser, 404 not 403) — via repo-security-auditor
---

Find any route that answers without a session or the right project role, and
any query that reads project data outside `withUser`, where RLS would see no
user (CLAUDE.md rules 1 and 6). Postgres RLS is the authorization layer, so
both halves are checked together.

## Procedure

1. Spawn two **`repo-security-auditor`** agents in parallel, with the prompts `Audit area: auth.` and `Audit area: rls.`
   Together they check, with `file:line` evidence:
   - every route in `backend/src/*/routes.ts` against `requireUser` and the
     `PUBLIC` allowlist in `backend/src/routes.test.ts`;
   - role checks for owner, editor, viewer, farmer and contributor paths
     (`docs/data-model.md` § Access control), and that a hidden project
     returns `404`, never `403`;
   - `withoutUser`, `queryWithoutUser` and `actAsUser` callers
     (`backend/src/db/tx.ts`): only pre-sign-in auth and the job queue;
   - `SECURITY DEFINER` functions: pinned `search_path`, membership checks,
     `PUBLIC` revoked;
   - "cannot see" tests without a positive control (rule 5);
   - session cookie flags, login and reset enumeration, lockout and throttles.
2. Relay its report as is: findings most severe first, then Clean.

Both agents write `reviews/security-auth.md` and `reviews/security-rls.md`; merge the two into one report.

Read-only. Don't apply fixes; offer them, one path-scoped commit per finding
on a PR branch.

## When

After adding a route, a role or a policy, and before a release.
