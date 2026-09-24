# Follow-ups: open work (updated 2026-09-23, after the audit and hardening round)

Everything below is known, unfinished work. Longer-term features live in
[planned-work.md](./planned-work.md); client and hydrologist questions are in
[plan.md § Questions for the client](./plan.md#questions-for-the-client).
Tick items off (or move them into an issue) as they are done.

## Blocking releases (operator)

- [ ] **GitHub plan.** The repo is private on a free plan, so:
      - required reviewers and branch protection aren't available, which means
        the release preflight refuses every release;
      - CodeQL and Scorecard fail on every push.

      Make the repo public (after the scrub below) or upgrade the plan. Then
      make `CI gate` a required check.
- [x] **Client names (WP-1.7).** The tree and the history are scrubbed
      (2026-09, `git filter-repo --replace-text`). The repo was then
      recreated from the clean history, because GitHub keeps old commits
      under PR refs: the previous repo is now the private
      `project-water-management-old` (it still holds the old history and
      issues; delete it once nothing is needed from it). The calibration and
      rainfall issues are re-filed without the names as #1 and #2 (originals
      archived in `infra-secrets/water-management/`).
- [ ] **`production` environment:** run
      `templates/scripts/backfill-prod-environment.sh --apply`, with the
      operator as required reviewer.
- [ ] **AWS bootstrap:** follow `infra/README.md` steps 1–9a, then
      `export-tf-vars.sh`. Pick the region; the recommendation is af-south-1
      for everything, SES included ([deployment.md § Region
      recommendation](./deployment.md)). If that's the choice, raise
      `budget_monthly_usd` to about 70 and set `dmarc_report_email`.

## Hydrologist

- [ ] **Calibration record:** gauge G1 vs logger A1 from 2014/15, tracked in
      [#1](https://github.com/Absence0760/project-water-management/issues/1).
      The runoff-ratio check needs the client workbook back in
      `../project-water-management-source/Original/`.
- [ ] **Engine audit questions** ([engine-audit.md](./engine-audit.md)):
      - H1: a storm resets base flow, so one storm returns about 4.9× its rain.
      - N1: there's no irrigation efficiency.
      - N2: dam evaporation and seepage are ignored.
      - N3: rain only offsets demand on the day it falls.
      - N4, Q3, Q18: transfer rules.
      - Q17: how the EWR shortfall is attributed to farms.
      - Q1, Q5, Q11, Q13: field meanings and curtailment policy.
- [ ] **Return flow and curtailment:** with return flow on, a farm upstream of
      a starved neighbour can "help" it by drawing more, because part of the
      extra draw returns to the river. Keep this in mind when reading
      curtailment results (it relates to N1).
- [ ] **Data-quality limits:** outliers are 5× the 99th percentile for rain and
      10× for flow; flat-lines are 5 days for rain and 14 for flow. Are these
      right for these catchments? They're fixed in code.
- [ ] **Help text read-through** (`frontend/src/lib/help/content.ts`),
      especially the entries built on open quirks.
- [ ] **Curtailment "Demand left %"** shows extreme values for farms with tiny
      demand (Q12/Q13). Decide how to show it once answered.

## Verification

- ✅ **Engine audit** (engine 0.4.0, [engine-audit.md](./engine-audit.md)):
  - E1/E2: base flow on day 1, and negative recession.
  - R1: the model no longer rounds.
  - G1: gauge EWR shortfall.
  - C1: Pitman calibrates against natural flow.
  - M1: importer month lists.
  - W1–W5: new warnings.
  - F8: order-dependent float noise in EWR shortfalls.
- ✅ **Invariant suite** (`packages/engine/src/testing/invariants.ts`) runs on
  random networks, the three example catchments and the client catchment (when `data/`
  is present). Soaked over seeds 1–20000. Described in model.md §6
  Verification.
- ✅ The engine rejects networks with more than one outflow node.
- [ ] **Client catchment regression on real data:** the suite has a commented
      deviation list but has never run against the real workbook. Re-extract
      it and run `pnpm test:engine`; a failure prints the actual difference
      next to its bound.
- [ ] **`verify/` (Python cross-check):** it transcribes the workbook's
      formulas, which the engine no longer follows. Decide whether to delete it
      or rebuild it against the audited model. Operator call.
- [ ] Soak the fuzz tests after any engine change:
      `FUZZ_CASES=20000 pnpm -C packages/engine exec vitest run src/run.invariants.test.ts`.

## UI

- [ ] **Thousands separator style:** the app uses commas (300,000). The
      original ask was spaces (300 000). Pick one app-wide.
- [ ] **"Sign out everywhere" button.** `POST /auth/logout-everywhere` exists,
      but the header has no account menu for it yet.
- [ ] **Exports carry unrounded values** now that the engine doesn't round.
      Decide on export number formatting.

## Features left half-way

- **Run comparison:**
  - per-node series overlay;
  - copies that remember their source nodes (renamed farms in a copy don't
    match);
  - a value change is not isolated when the dates also changed.
- **Export:**
  - `.xlsx` output, which needs a spreadsheet library (operator call; not the
    npm `xlsx` package);
  - a path for exports over 5 MB (Lambda streaming or an S3 pre-signed URL,
    plus a local MinIO equivalent).
- **Accounts:**
  - Should sign-in require a verified email?
  - Should sign-up be invite-only, or email-first? Email-first closes the last
    account-squatting gap.
  - Is a 5-attempt, 1–15 min lockout acceptable, given anyone can lock another
    person's address that way?
  - Should runs be pinnable, so a baseline survives the 20-run cap?
- **Data ingestion:**
  - per-project API keys for logger feeds;
  - scheduled CHIRPS / DWS fetchers;
  - auto re-run after new data;
  - forecast days flagged (plan.md §1e).
- **Data quality:** gap filling.
- **Workbook import in the browser.** It is the Python CLI only today.

## Pipelines

- Releases are `web@X.Y.Z` / `backend@X.Y.Z` GitHub releases, run through a
  preflight → build → `production` approval → deploy pipeline
  ([deployment.md §4](./deployment.md)).
- [ ] Optional:
      - a read-only Terraform plan role, for a real `terraform plan` in CI;
      - drop the Dependabot `pip` entry, which watches nothing;
      - a CodeQL Python leg for `scripts/wbt-import`.

## Housekeeping

- During early development, work is pushed straight to `main`, without PRs, at
  the operator's request.
- Demo data: `pnpm dev:db:reset && pnpm seed:demo` rebuilds the dev database.
  It holds three invented catchments, a demo team, two demo users, and client
  catchment if the workbook is present.
- The domain personas (`/persona hydrologist,environmentalist,…`) are ready to
  run against the merged app. See `.claude/personas/README.md`.
