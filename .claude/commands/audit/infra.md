---
description: Audit the Terraform under infra/ — IAM least privilege, network exposure, data protection and recovery, alarm coverage — via the infra-auditor agent
argument-hint: [iam|network|data|observability] (optional; default: all four)
---

Audit water-management's infrastructure (`infra/*.tf`, the Lambda handlers
and the docs that describe them) before anything is applied.

## Procedure

1. Pick the areas from `$ARGUMENTS`: one of `iam`, `network`, `data`,
   `observability`, or none for all four. Spend (`cost`) has its own
   command, `/audit/cost-controls`.
2. Spawn one **`infra-auditor`** agent per area, **in parallel** (one message,
   several Agent calls). Each prompt starts with `Audit area: <area>.` and
   nothing else is needed: the agent knows the stack, the files and the
   severity rubric.
3. Each agent writes `reviews/infra-<area>.md` and returns its findings.
   Merge them into one report (below). Where two areas report the same root
   cause, list it once.
4. Findings the agents hand over to `repo-security-auditor` ("for
   repo-security-auditor: …"): list them under **Handed over**, don't chase
   them.

## Report

```
# Infra audit — <date>   areas: <…>

## Critical (N) / High (N) / Medium (N) / Low (N)
- [infra/<area>] file:line — one line. Fix: … (cost effect: …)

## Handed over
## Clean
## Recommended order
```

Critical and High are "fix before the first `terraform apply`". Don't apply
fixes, run `terraform plan`/`apply` or touch AWS; `pnpm check:infra`
(mocked providers, no credentials) is the only Terraform command allowed.
Offer to fix, one path-scoped commit per finding, once the user picks which.

## When

After editing anything under `infra/`, before the first apply, and before a
backend release that adds a Lambda, queue, schedule or IAM permission.
