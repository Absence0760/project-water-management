# Follow-ups — open work at the end of the V1 build session (2026-09-23)

Everything below is known, unfinished work. Longer-term features live in
[planned-work.md](./planned-work.md); client/hydrologist questions in
[plan.md § Questions for the client](./plan.md#questions-for-the-client).
Tick items off (or move them into an issue) as they are done.

## Before sharing more widely

- [ ] **Licence / IP.** The workbook states FRC owns the model design and
      SmartMatix owns the formulas; the engine is a port of both. Settle this
      with the client **before making the GitHub repo public** (it was pushed
      private). Docs also still name the Client Catchment catchment and some farms.
- [ ] **Hydrologist review** of the first question in plan.md (gauge G1 vs
      logger A1 from 2014/15) — it decides what Client Catchment is calibrated to.
- [ ] **Hydrologist read-through of the help text** (`frontend/src/lib/help/content.ts`),
      especially entries built on open quirks (Q1 upstream-to-dam label, Q4
      per-farm EWR share, Q5 minimum dam level).

## Verification (algorithms)

- [ ] Finish and review the three verification tracks started at the end of
      the session (see the status notes below): invariant/fuzz tests
      (`packages/engine/src/**/*.invariants.test.ts`), the independent Python
      implementation (`verify/`), and the engine review (`docs/engine-review.md`).
- [ ] Run the full Playwright suite on the final `main` (`pnpm dev:db:up && pnpm test:e2e`)
      — the last complete run predates the final merges, the "Data" tab rename
      and the shell wiring.

## UI polish

- [ ] Thousands separators in the one-node form and the view-only network table (300000 → 300 000).
- [ ] Schematic: transfer arcs can cross node labels.
- [ ] Runs & results page is long — add in-page anchors / a section menu.
- [ ] Curtailment "Demand left %" shows extreme values for farms with tiny
      demand (workbook formula, quirk Q12/Q13) — decide how to display once the
      hydrologist answers.
- [ ] Overview tab: take `model`/`series`/`runs` props from the page (already
      loaded) instead of fetching its own (not started).
- [ ] A signed-in user opening `/register?invite=…` is sent home — explain it instead.
- [ ] "Today" in the workspace freshness uses the UTC date while the project list
      uses the local date — they can disagree by a day around midnight.
- [ ] Long emails in member rows break mid-word on phones.
- [ ] Re-shoot the auth split layout after the `html { overflow-y: scroll }` change.

## Features left half-way

- **Run comparison:** store a content hash per input series with each run so
  "what changed" catches corrected values inside the same dates; per-node series
  overlay; copies remembering their source nodes (renamed farms in a copy don't
  match).
- **Export:** `.xlsx` output; a path for exports > 5 MB (Lambda response
  streaming or S3 pre-signed URL); summary CSV "fraction supplied" as %.
- **Email:** SES in Terraform (domain identity + DKIM, MAIL FROM, SPF/DMARC,
  IAM `ses:SendEmail`, VPC endpoint, sandbox exit — listed in
  deployment.md § Email); adding an *unverified* existing account currently
  makes it a member directly (should invite); verify-email links need a signed-in
  user; decide whether sign-in requires a verified email and whether sign-up is
  invite-only (client question).
- **Data ingestion:** per-project API keys for logger feeds, scheduled CHIRPS /
  DWS fetchers, auto re-run after new data, forecast days flagged (plan.md §1e).
- **Data quality:** show more checks (outliers, flat-lines, gap filling); make the
  gauge-vs-logger thresholds a project setting.
- **Workbook import in the browser** (currently the Python CLI only).

## Deploy (nothing applied yet)

- [ ] Operator steps in `infra/README.md` (account bootstrap via
      `new-project-account.sh water-management`, sops secrets in infra-secrets,
      Lambda concurrency quota, billing access, `terraform plan/apply`,
      `export-tf-vars.sh`, first deploys) → `water-management.jaredhoward.com`.
- [ ] Choose the region (af-south-1 is opt-in; check SES availability there).
- [ ] Add `terraform fmt -check` / `validate` / `test` to CI; uncomment the
      deploy workflows' release triggers when ready.
- [ ] Re-run `new-project-account.sh` after the repo exists on GitHub so the
      `CI gate` required check and the `production` environment are wired.

## Housekeeping

- The repo's CLAUDE.md says "never push"; the first push to GitHub was done at
  the owner's explicit request at the end of this session.
- Demo data: `pnpm dev:db:reset && pnpm seed:demo` rebuilds the dev database
  (three invented example catchments, a demo team, two demo users, Client Catchment
  if the workbook is present).

## Status of work in flight at the end of the session

- **Independent Python implementation (`verify/`)**: stopped at the spec stage.
  `verify/README.md` holds the formulas transcribed from the client catchment workbook
  (Flow data pipeline, fragmentation, demand, farm row-17 balance, transfer cap);
  Transfers, Fragmented EWR, EWR shortfalls and Shortfalls are not transcribed.
  No Python model, runner or `diff.py` yet — nothing is verified by it. It flagged
  workbook behaviours to test the engine against: month lists matched as text
  (a summer list `[11]` also makes January summer), the day-1 base-flow factor
  (2·f1 − f2), **dam capacity rounded to whole m³** (0.15 m³ dams become 0), and
  Farm spec shares for three farms always using the area share whatever the method.
