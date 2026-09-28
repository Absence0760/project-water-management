---
description: Run the full audit sweep — security (secrets, xss, auth, rls) + deps + infra + cost — in parallel
argument-hint: [security|deps|infra|cost] (optional area filter)
---

Run the project's audit sweep. By default, runs every audit; with an argument, runs the named subset.

## Areas

- **security** — `secrets`, `xss`, `auth`, `rls` (repo-security-auditor)
- **deps** — `audit/deps`
- **infra** — `iam`, `network`, `data`, `observability` (infra-auditor)
- **cost** — `cost` (infra-auditor)

## Procedure

1. Decide which audits to run from `$ARGUMENTS`: none → all of them; or one
   of `security`, `deps`, `infra`, `cost`.
2. **Spawn every agent in parallel** (one message, several Agent calls):
   - each security area: a `repo-security-auditor` whose prompt starts
     `Audit area: <area>.`;
   - each infra area and `cost`: an `infra-auditor` whose prompt starts
     `Audit area: <area>.`;
   - `deps`: one `general-purpose` agent with the body of `deps.md`.
   The two auditors know the stack and write `reviews/security-<area>.md` /
   `reviews/infra-<area>.md`.
3. **Consolidate** into one report grouped by severity, then area; list a
   root cause two agents found once. Put the cost worst-case table at the
   top. Hand-overs between the two auditors are merged into the area that
   owns them.
4. **Recommend a fix order** without applying anything: Critical/High are
   "fix before next deploy"; Medium/Low can be batched.

## Output shape

```
# Audit report — <date>

## Critical (N)
- [audit/<area>] file:line — <one-line>
- ...

## High (N)
- ...

## Medium (N)
- ...

## Low (N)
- ...

## Clean (no findings)
- [audit/<area>] no issues

## Recommended order
1. ...
2. ...
```

## Notes

- This is read-only. Each sub-audit is read-only by default.
- The report is the deliverable; do not edit code based on findings without asking the user first.
- If an audit finds no issues, list it under the `## Clean` section — easier to spot regression on the next run.
- For a change to just dependencies, just `infra/` or just spend-related code, the matching subset is enough; the full sweep is for release prep and periodic drift checks.
