---
description: Make sure nothing can run away and produce an unexpected AWS bill — Lambda ceilings, loops, retry storms, fan-out, growth, budget and alarms — via the infra-auditor agent
---

Find every way water-management's AWS bill could grow far past the expected
monthly cost (`docs/deployment-tiers.md`: ≈ $50 us-east-1 / ≈ $58–63
af-south-1 on the minimal tier) before a human is told, and what stops it.

## Procedure

1. Spawn one **`infra-auditor`** agent with the prompt
   `Audit area: cost.` It covers, with arithmetic and `file:line`:
   - the worst-case monthly ceiling of every Lambda (reserved concurrency ×
     memory × a month of seconds), against `budget_monthly_usd`;
   - every producer → queue → consumer cycle (worker ↔ jobs queue,
     worker → fetcher → worker, worker → renderer → API) and what
     guarantees it stops;
   - queue retry storms (DLQs, `maxReceiveCount`, visibility timeouts,
     `ReportBatchItemFailures`);
   - server-side caps on fan-out (sweeps, outlooks, schedules, feeds,
     recipients, alert emails, auto-runs);
   - direct Function URL hits that bill even when rejected;
   - growth (logs, S3, ECR, RDS storage) and fixed costs that creep in;
   - the budget's notifications and the alarms that would catch each path.
2. Relay its report as is: the worst-case table first, then findings most
   severe first, then Clean. Add a one-paragraph answer to "what is the most
   this can cost in a month, and how quickly would we know?"

Read-only. No AWS calls, no `terraform plan`/`apply`, no load tests (a load
test is itself a spend event). Don't apply fixes; offer them, one
path-scoped commit per finding, with each fix's cost effect.

## When

Before the first deploy, after any change that adds a Lambda, queue,
schedule, job kind, retry or email path, and monthly once deployed (compare
the ceiling with the real bill in Cost Explorer; the operator does that
part).
