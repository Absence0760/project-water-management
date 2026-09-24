# Follow-ups: open work (updated 2026-09-24, after the Phase 6 persona review)

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
      Research done: the gauge column is a neighbouring river's gauge, and the
      logger (already the project's calibration record) is the verified
      target ([model.md §2.10](./model.md)). The code and doc items (plan 1–3:
      no silent default pick, a neutral agreement warning, the findings in
      model.md) have landed. Still open: the hydrologist's sign-off on the
      logger, then replace the question in [plan.md](./plan.md) and close #1.
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
- [ ] **Validation scores are not saved with a run** (issue #4). The Runs page
      and run comparison show only the whole-window, in-sample fit scores,
      now labelled "calibration period (in-sample)". The automatic fit's
      split-sample and wet/dry-year validation scores (`CalibrationReport`)
      live only in the Settings → Fit automatically panel and are lost on
      reload. Durable fix: persist the last fit's report (or its validation
      periods) with the applied parameters, record it in the run's input
      snapshot, and show the validation scores beside the in-sample ones.
      Calibration exclusions are not saved either, so `runModel` can't pass
      them to the EWR agreement (model.md §2.9b); persist them with the same
      change. Another task owns this.
- [ ] **Data-quality limits:** outliers are 5× the 99th percentile for rain and
      10× for flow; flat-lines are 5 days for rain and 14 for flow. The
      catchment-rain checks (issue #2) flag a zero run with 60+ days in the
      series' six wettest months (180+ days without two years of data) and a
      water year below 50 % of the record's usual catchment / CHIRPS share.
      Are these right for these catchments? They're fixed in code
      ([model.md §2.10a](./model.md#210a-data-quality-do-the-observed-flow-records-agree));
      make them settings if the hydrologist wants to tune them.
      A simulated hydrologist review (2026-09-24; see "Issue #4 Phase 6"
      below) recommends:
      1. Make two limits editable in `settings.dataQuality`: the minimum
         wet-season zero-rain days and the CHIRPS ratio cutoff. Keep the
         sample-size floors as constants.
      2. **Check zero runs against CHIRPS:** if CHIRPS recorded at least half
         its usual rain over the run, call it "probably missing data";
         otherwise, "a long dry spell that may be real". This fixes the false
         alarms that fixed day-counts would raise in the semi-arid Karoo and
         Northern Cape.
      3. Judge a zero run by the rain the climatology would have put on those
         days (flag it at 25 % or more of mean annual rain, with 60 days as a
         secondary floor), not by how many days it lasted.
      4. Compare each year with a moving median of about ±5 years instead of
         one record-wide median, because the catchment/CHIRPS ratio drifts
         over decades.
      5. Scale the CHIRPS minimum: the larger of 50 mm and 25 % of median
         annual CHIRPS.

      Test the semi-arid defaults on a Karoo gauge record with a known
      drought (e.g. 2015–19) before changing them. Do this after the CHIRPS
      fallback bias correction lands, because it uses these flags.
- [ ] **Help text read-through** (`frontend/src/lib/help/content.ts`),
      especially the entries built on open quirks.
- [ ] **Curtailment "Demand left %"** shows extreme values for farms with tiny
      demand (Q12/Q13). Decide how to show it once answered.

## Issue #4 Phase 6: simulated review findings (2026-09-24)

The `persona-hydrologist` and `persona-licensing-authority` agents answered
the six Phase 6 questions in issue #4. Their full reports are in
`reviews/persona-*-phase6.md`, gitignored and local only, because they quote
client numbers. **These are simulated reviews: a pre-filled pack for the real
hydrologist and a CMA official, not sign-off.** Nothing below is recorded as
a decision in `docs/plan.md` (D3).

**Recommendation to put to the hydrologist.** Make GR4J (with X2 = 0) the
default, and don't build the IHACRES-CMD benchmark (Phase 7) first. Three
conditions come before any client numbers:
- [ ] **CHIRPS fallback bias correction.** Raw CHIRPS reads well below the
      catchment rain, especially in winter, so fallback years produce almost
      no flow under a water-conserving model. This is in progress on its own
      branch.
- [ ] **Make the logger fit identifiable, keeping the logger as the target.**
      The logger-only fit gives X1 and X3 outside the typical GR4J ranges,
      because a short record that is mostly drought can't pin them down.

      **Resolved (2026-09-24): don't recalibrate on the gauge.** The persona
      suggested calibrating on the long gauge column and validating on the
      logger. That was checked against the source hydrology report and the
      data (full evidence in the gitignored
      `data/client-catchment/gauge-vs-logger-resolution.md`), and it doesn't
      hold:
      - **The gauge is a different sub-catchment.** The DWS weir sits on a
        neighbouring river about 10 km *upstream* of its confluence with the
        modelled river, so none of the modelled catchment drains through it.
      - **That sub-catchment is heavily developed**, with roughly six times
        the irrigation demand upstream of the logger and large farm-dam
        storage. The source report notes that early-season flows there go
        into filling dams.
      - **The workbook column mixes two scalings:** raw before 2010, and
        area-scaled from 2010.
      - **The close overlap agreement is one wet half-year.** The records
        agree on volume only over the first, flood-dominated half water year
        of their overlap. Their medians already differ, and the volume ratio
        falls in every later year to near zero by 2018.
      - **Two persona findings rested on treating the gauge as this river,
        and are withdrawn:** that there is "probably other upstream use"
        (Q3), and that natural flow below the gauge is "physically
        impossible". Against the logger, GR4J's share of days below the EWR
        is close to the observed share.

      **Plan**, in order:
      1. **Constrain the logger fit with information about *this*
         catchment.** Switch on the Phase 8 WR2012 soft penalty on MAR for
         the client catchment, and record its weight. The source report gives
         both a scaled WR2012 and a quinary natural MAR at the logger, and
         they differ by about 2×, so use the band between them, not one
         value. Also run a fit bounded to Perrin's 80 % ranges. Report both
         fits beside the free fit.
      2. **Use the gauge as a regional wet/dry index only.** Use it to rank
         water years for the dry→wet test design and the Phase 9 forcing,
         never as a calibration or validation target for this river.
      3. **The durable fix for wet-year uncertainty is a proxy-basin model.**
         Build the gauged neighbour as its own project in the app, with its
         own rain (the source report names the gauges), its farm dams and its
         irrigation, and calibrate it on the *raw* gauge record. Then compare
         its fitted X1–X4 with the logger fit: this is regionalisation by
         spatial proximity (Oudin et al. 2008).
         - If the neighbour's parameters are in the typical ranges and the
           logger fit's aren't, use the neighbour's as a prior. That brings
           30-plus years, wet years included, into the fit honestly.
         - It needs the neighbour's rain record and development data, and it
           depends on WP-1.21 (dam evaporation) and WP-1.33 (other water
           users).
      4. **Importer fix.** `scripts/wbt-import` always maps the workbook's
         gauge column to `flow_observed_m3s`, so for this client the app
         treats a neighbouring river as this catchment's observed flow (the
         default calibration record, the EWR comparison). For other clients
         that column may really be the catchment's own gauge, so don't change
         it for everyone. Add an importer option to import it as a labelled
         regional-reference series, with any known scaling undone, and use it
         for this client.
      5. **Confirm the modelled area.** The project's catchment area differs
         by about 5 % from the source report's area at the logger. Ask the
         hydrologist which is right.

      The hydrologist still signs off the logger as the target (#1). This
      plan doesn't need them to settle a conflict.
- [ ] **Fix the monthly pan coefficient (A-pan → PET) before calibrating.**
      It trades off against X1 and X3, so it must never be calibrated. The
      EWR result is sensitive to it: re-run at 0.6 and 0.85.

**Answers to put to the hydrologist and the CMA** (the full reasoning is in
the reports):
- **Q1: model on record.** GR4J is fine as the daily impact model, but every
  evidence run must carry the WR2012 comparison. Pitman is desirable, not
  mandatory. Legacy is not acceptable as evidence at all, because it
  doesn't conserve water (H1). If both models run, declare the primary one
  before seeing results.
- **Q2: WR2012.** Always report it; never make it a hard constraint. Keep
  the soft MAR penalty off by default and record its weight when it's on.
  Flag a simulated MAR that differs from WR2012 by more than 10 %, 25 % (or
  15 % wetter) or 50 %. Those bands are persona judgement for a CMA official
  to confirm. Phase 8 is being built to these criteria.
- **Q3: other upstream use.** The persona's "probably yes" was withdrawn:
  it rested on the neighbouring gauge (see above). The question stays open
  for the hydrologist, but no evidence now points to unmodelled use upstream
  of the logger. Still do WP-1.21 (dam evaporation) and WP-1.33 (other water
  users) before a final calibration, because they are real modelled
  processes.
  - [ ] **Gap:** development (dams, abstraction) can't vary over time within
        a run.
- **Q4: pan and lake factors.** These are two separate settings. PET uses a
  monthly A-pan coefficient (FAO-56 range 0.35–0.85). Dams use WR90 lake
  factors, which are **S-pan** based; the roadmap WP-1.21 spec is now
  corrected. The actual WR90 values for the evaporation zone haven't been
  read yet.
- **Q5: split-sample periods.** Split-sample, dry→wet, and an independent
  instrument. Cross-record validation has landed. Stored exclusions (whole
  water years, each with a reason) are in progress with fit provenance.
- **Q6: uncertainty.** SA Reserve practice uses confidence ratings and
  assurance rules, not a numeric band. Show monthly compliance against the
  EWR assurance rules, not a raw count of days below the EWR. Phase 9
  criteria are below.

**Open items (not yet started):**
- [ ] **Phase 9: uncertainty bands.** Build to these criteria (assessor):
      - The ensemble comes from a seeded sample across the parameter bounds
        (Latin hypercube or DDS-AU), **not** the optimiser's search path.
      - The ensemble also varies the pan coefficient, the rain source and the
        observed record (hydrologist).
      - A parameter set is kept only if it passes stored, diffed thresholds:
        a skill score, the Phase 8 WR2012 bounds, and a low-flow check.
      - Report how many held-out observations fall inside the band, with a
        warning below 70 %.
      - Show no percentiles with fewer than 30 accepted members.
      - 5–95 % bands on EWR days not met (monthly and total), shortfall
        volume, curtailment per farm, annual volumes and MAR.
      - Paired bands on the difference between a run and its baseline (the
        application's extra impact).
      - Monthly flow-duration curves against the EWR line.
      - A band per runoff model, never pooled.
      - Seed, method, thresholds, the kept parameter sets and the
        percentiles are stored and reproducible.
      - The decision rule is printed next to the band.
- [ ] **EWR compliance by the Reserve's assurance rules**, monthly, as the
      headline instead of raw days-not-met (hydrologist Q6).
- [ ] **Nominated evidence run.** Record which run and which model an
      applicant nominated as evidence, so they can't pick whichever model is
      kindest after the fact. The assessor rated this Medium.
- [ ] **Hydrologist plausibility checks** (as run warnings or a report):
      - natural flow ≥ impacted observed flow + modelled abstraction in every
        water year;
      - EWR days reported separately for good-rain and fallback-rain years;
      - a double-mass curve of gauge flow against rain, to tell new upstream
        use from a failing gauge;
      - dry-season low-flow duration curves overlaid for gauge, logger and
        each model.
- [ ] **Phases 7 and 10 of issue #4:** Phase 7 (IHACRES) only if the
      hydrologist asks for it. Phase 10 (remove legacy) after sign-off.
- [ ] **Persona tooling:** `pnpm -C packages/engine exec tsx` fails because
      the engine workspace has no `tsx`. The persona agents are told to use
      it (`.claude/agents/persona-*.md`); either add `tsx` as an engine dev
      dependency or point the agents at the backend's copy.

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
- [ ] **e2e runs from parallel worktrees share one `water_e2e` database and
      fixed ports** (:3101 and :7801). When two sessions run `pnpm test:e2e` at
      once, unrelated specs fail (seen 2026-09-24: `sharing.spec.ts` and
      `teams.spec.ts` failed, then passed on re-run). The durable fix is a
      per-checkout e2e database name and ports, derived from the worktree
      path or an env override, set up in the e2e global setup. Until then,
      don't run e2e in two worktrees at the same time.
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
- **WR2012 check (issue #4 phase 8, model.md §2.10c):**
  - [ ] **A written explanation per run.** An assessor wants the modeller's
        reason next to a *query* or *not usable* flag (e.g. "the quaternary
        includes an irrigated tributary outside the model"). Runs are
        immutable today: `model_run` has no editable field besides the label
        set at creation, and no `PATCH` route. The durable fix is a
        `model_run.notes` text column (migration with its RLS: editor may
        update only that column, via a column-level `GRANT UPDATE (notes)`),
        `PATCH /projects/:id/runs/:runId { notes }`, shown and editable under
        the WR2012 panel and carried into run comparison and the summary CSV.
        Trigger: before the first licence-application use, or when the
        licensing-assessor review asks for it.
  - [ ] **Summary CSV export** (`backend/src/export/run-tables.ts`) doesn't
        carry the WR2012 report yet; add a block (reference, scaling, MAR
        ratios, monthly table, flag) with the explanation above.
  - [ ] **SA-only help tag.** The WR2012 help entries are South African;
        tag them when `HelpEntry.countries` lands (international.md WP-I.12).
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
