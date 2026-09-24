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
      - Q5, Q11, Q13: curtailment policy. (Q1 is resolved: the share goes
        into the dam, engine 0.9.0.)
- [ ] **Return flow and curtailment:** with return flow on, a farm upstream of
      a starved neighbour can "help" it by drawing more, because part of the
      extra draw returns to the river. Keep this in mind when reading
      curtailment results (it relates to N1).
- [x] **Validation scores are saved with a run** (issue #4). Apply stores the
      fit record (seed, objective, window, exclusions, the in-sample and
      validation scores) with the parameters, each run snapshots it, and the
      Runs page and run comparison show the validation scores beside the
      in-sample ones (model.md §2.10b). Calibration exclusions are stored too,
      and `runModel` passes them to the EWR agreement (model.md §2.9b).
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
- [ ] **CHIRPS bias correction (engine 0.7.0, audit B1).** CHIRPS that fills
      in for blank catchment rain is now scaled per calendar month by
      Σ catchment / Σ CHIRPS, fitted without the years the issue #2 checks
      flag ([model.md §2.4b](./model.md#24b-chirps-fallback-bias-correction)).
      Confirm with the hydrologist:
      - linear scaling per month, versus quantile mapping (which also fixes
        the wet-day count and intensities that drive GR4J's event response);
      - the minimum sample (90 shared days and 50 mm of CHIRPS per month,
        else the pooled factor) and the 0.25–4 clamp;
      - whether a neighbouring gauge should fill gaps before CHIRPS does.

      Re-run the issue #4 phase 6 GR4J-vs-legacy comparison on the client
      catchment with the correction on (condition 1), and record the result
      in the issue.
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
- [x] **CHIRPS fallback bias correction.** Raw CHIRPS reads well below the
      catchment rain, especially in winter, so fallback years produce almost
      no flow under a water-conserving model. **Landed in engine 0.7.0**
      (audit B1, [model.md §2.4b](./model.md#24b-chirps-fallback-bias-correction)):
      monthly factors, on by default. The re-run of the comparison and the
      hydrologist's confirmation are the open item under Hydrologist above.
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

         **Landed in code (2026-09-24):** the WR2012 calibration penalty
         (`settings.wr2012.calibrationPenalty`, model.md §2.10c) takes an
         optional MAR band (`marLowMm3` / `marHighMm3`) instead of one
         target — zero inside it, a soft pull towards the nearer bound
         outside it — for exactly this "two disagreeing published estimates"
         case, validated (both bounds or neither, low ≤ high) by a shared
         engine function the backend and the Settings form both use, and
         recorded in the fit record and run comparison's *What changed*.
         Automatic calibration also takes a `bounds: 'wide' | 'typical'`
         option (a "Bounds" select in Fit automatically), the second
         restricting the search to Perrin et al.'s 80 % ranges; it's recorded
         on the fit record too. Free / typical-bounds / band / both fits
         against the client logger record, with calibration and validation
         scores: `data/client-catchment/logger-fit-constrained.md`
         (gitignored, local only — the repo is public).

         **What the fits show (qualitatively):**
         - The logger record alone can't pin down X1 and X3: the in-sample
           score barely moves across a wide range of both.
         - The band alone changes little, because the free fit's MAR already
           sits near the band's edge.
         - Typical bounds give plausible parameters but hurt the dry→wet
           validation. Typical bounds plus the band recover it, so they are
           the best-balanced fit to put to the hydrologist.
         - EWR days not met barely changes between the four fits.
         - None of them validates well out of sample. The durable fix is
           still item 3, the proxy-basin prior. Item 2 is still open; item 4
           has landed.
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
      4. ~~**Importer fix.**~~ **Done (2026-09-24).** `scripts/wbt-import`
         always mapped the workbook's gauge column to `flow_observed_m3s`, so
         for this client the app treated a neighbouring river as this
         catchment's observed flow. The default is unchanged (for other
         clients the column may really be the catchment's own gauge), but
         `extract_project.py --gauge-as-reference [--gauge-scaling-from
         YYYY-MM-DD --gauge-scale-factor F]` now imports it as a new
         `flow_reference_m3s` series ("Reference gauge (other catchment)")
         with the scaling undone. The engine never reads that kind
         ([model.md §2.10](./model.md#210-calibration-statistics-flow-calibration-cfg)).
         `pnpm seed:demo` uses it for this client, taking the scaling from
         `WBT_GAUGE_SCALING_FROM` / `WBT_GAUGE_SCALE_FACTOR` outside the repo.
         Checked on the client workbook: the scaled stretch starts on 1 January
         2010, and after unscaling every value is back to whole thousandths
         of m³/s, as published.
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
  evidence run must carry the WR2012 comparison. (The persona called Pitman
  desirable, not mandatory; the app removed it as an input in engine 0.10.0,
  audit P1.) Legacy is not acceptable as evidence at all, because it
  doesn't conserve water (H1). If both models run, declare the primary one
  before seeing results.
- **Q2: WR2012.** Always report it; never make it a hard constraint. Keep
  the soft MAR penalty off by default and record its weight when it's on
  (an applied fit's record keeps the weight and the MAR ratio with and without it).
  Flag a simulated MAR that differs from WR2012 by more than 10 %, 25 % (or
  15 % wetter) or 50 %. Those bands are persona judgement for a CMA official
  to confirm. Phase 8 has landed to these criteria (engine 0.6.0; the MAR
  band followed in 0.8.0, model.md §2.10c). Three pieces are deferred: a
  written explanation stored with each run, the WR2012 block in the CSV
  export, and tagging the help entries as South Africa-only.
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
  instrument. Cross-record validation has landed, and so have stored
  exclusions (whole water years or date ranges, each with a required reason;
  model.md §2.10) and fit provenance: an applied fit is saved with its seed,
  objective, window, exclusions and validation scores, each run snapshots
  it, and a hand edit after Apply marks it "parameters edited since fit"
  (model.md §2.10b). The Runs page shows the in-sample score next to those
  validation scores.
  - [ ] Shade excluded periods on the Runs hydrograph (WP-1.3 planned it;
        the calibration panel lists them instead for now).
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

## Calibration research (2026-09-24)

The review in [calibration-research.md](./calibration-research.md) turned into
34 recommendations (CR-1 … CR-34), with priorities and effort. Open items, in
the suggested order (the IDs carry the detail):

- [ ] **Cheap first:** CR-2 multi-start DDS, CR-3 KGE(Q)+KGE(1/Q) objective,
      CR-6 drop Moriasi words on daily scores, CR-34 record-representativeness
      note.
- [ ] **Data layer:** CR-18 per-day quality flags → CR-19 flag-aware
      objective → CR-20 flagged zero-rain runs become missing so corrected
      CHIRPS fills them (closes the gap behind issue #3) → CR-22 data-quality
      panel.
- [ ] **Ensemble and reporting:** CR-1 behavioural ensemble with the EWR range
      → CR-5 bootstrap CIs and benchmarks → CR-21 sensitivity runs and
      "not determinable" → CR-28 WR2012 five-statistic table (confirm the
      thresholds in WRC TT 689/690 first) → CR-29 compliance as %time, %volume,
      FDC overlays and %nMAR.
- [ ] **Recession:** CR-13 diagnostics (−dQ/dt vs Q against the imported
      table), then CR-14 mass-conserving store once the hydrologist decides
      (question 1 below).
- [ ] **Hydrologist questions** from the review: recession fix vs GR4J (CR-14),
      the EWR form the CMA expects (CR-30), the logger's highest gauging and
      rating (CR-18), the defensible abstraction estimate and range (CR-21,
      CR-32), and which of the two MAR estimates to trust (CR-7). Add them to
      [plan.md](./plan.md) when the review session is booked.
- [ ] **Later (P2/P3):** CR-7 regional filters, CR-8 trade-off view, CR-9
      proxy basin (issue #4 item 3), CR-10 GR6J, CR-15/16 fitted recession with
      uncertainty and BFI, CR-23 CHIRPS quantile mapping, CR-24 alternative
      ratings, CR-25 human-use flag, CR-30 assurance-table EWR, CR-31 licence
      scenario report, CR-32 dam and abstraction assumptions, CR-33 seasonal
      reporting.

## Verification

- ✅ **Engine audit** (engine 0.4.0, [engine-audit.md](./engine-audit.md)):
  - E1/E2: base flow on day 1, and negative recession.
  - R1: the model no longer rounds.
  - G1: gauge EWR shortfall.
  - C1: Pitman calibrates against natural flow (superseded: P1 removed Pitman
    in engine 0.10.0).
  - M1: importer month lists.
  - W1–W5: new warnings.
  - F8: order-dependent float noise in EWR shortfalls.
- ✅ **Invariant suite** (per-run checks in `packages/engine/src/verify/checks.ts`,
  re-run checks in `packages/engine/src/testing/invariants.ts`) runs on
  random networks, the three example catchments and the client catchment (when `data/`
  is present). Soaked over seeds 1–20000 before engine 0.12.0 (see the soak item
  below). Described in model.md §6 Verification.
- ✅ **Self-checks on every saved run** (engine 0.12.0): `runModelChecked`
  stores `summary.verification` and `summary.waterBalance`; farms record the
  working columns K–P, S, T and the balance check V; the farm daily CSV is in
  FarmTemplate letter order; the results have a Self-checks panel with a
  water balance per water year and "Trace a day" (model.md § Verification,
  ui.md § Self-checks).
- ✅ The engine rejects networks with more than one outflow node.
- [ ] **Client catchment regression on real data:** the suite has a commented
      deviation list but has never run against the real workbook. Re-extract
      it and run `pnpm test:engine`; a failure prints the actual difference
      next to its bound. Then load it (`pnpm seed:demo`, under
      `systemd-run --user --scope -p MemoryMax=4G`: the workbook has crashed
      the laptop before), make a run, and confirm in the Self-checks panel
      that every check passes, every residual is float noise, and the yearly
      water balance is physically sensible (runoff coefficient, consumptive
      use against demand, storage change). This is the first time the
      self-checks would see real data; nothing else tells us as much for as
      little. Record findings here without client numbers (public repo).
      **Partly done 2026-09-24** (engine 0.13.0, local dev DB): a fresh run of
      the client catchment passed all five self-checks, every yearly residual
      was float noise, and 2 000 sampled farm-days plus a wet, spill, deficit,
      transfer and diversion day recomputed independently from the Network,
      Crops and Settings inputs agreed with the model to float precision. One
      water year shows a runoff coefficient near 0.9: its catchment rain is a
      long run of zeros (missing data recorded as 0, issue #2), which the
      run's data checks already flag, while flow comes from the stores
      draining. That is an input question for the hydrologist, not a
      calculation error. Still open: the regression suite against the
      re-extracted workbook.
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
      Seen again 2026-09-24 in a full 2-worker run at load average ~6 while
      another session was debugging e2e: `chirps-bias.spec.ts` (the Settings
      select missing after `page.reload()`) and `data-quality.spec.ts` (the
      gauge-vs-logger table missing after navigating to the Time series tab)
      failed, then passed when rerun alone. Neither touches the runs page;
      if either fails alone, look for a missing readiness signal on reload
      rather than a longer timeout.
- [ ] **Wall-clock test flakes under load.** "a GR4J run of an example
      catchment takes under 50 ms" failed once (2026-09-24) while all three
      workspaces' tests ran at once; it normally takes about 21 ms. The
      durable fix: move the timing check to a separate `bench` / soak target,
      or take the median of several runs against a budget measured on the
      machine running it, so the unit suite asserts nothing about wall-clock
      time.
- [ ] **Frontend bundle ceilings were raised** to 295 KB total and 105 KB
      for the project page (2026-09-24, fit provenance). Look for code to
      split, such as lazy-loading the calibration and WR2012 panels, before
      the next raise.
- [ ] Soak the fuzz tests after any engine change:
      `FUZZ_CASES=20000 pnpm -C packages/engine exec vitest run src/run.invariants.test.ts`.
      **Owed for engine 0.12.0** (working columns + `checkWorkings`) and
      0.13.0: only the default 400 cases ran. Machine time only (15–20 min);
      run it on its own, not beside e2e or another session's tests.
- [ ] **Excel audit workbook export** (the strongest independent check). The
      farm daily CSV has every column but the hydrologist still types the
      formulas. An `.xlsx` for one farm: inputs as values, each working column
      (F … AB) as a live Excel formula taken from `verify/columns.ts`, and a
      column comparing Excel's value with the model's. Excel then recomputes
      the model independently, which a hydrologist or licensing authority will
      trust. SheetJS from its CDN tarball only (STACK.md: not the npm `xlsx`
      package); mind the 5 MB export limit (one farm, or a date window).
      About a day. Also settles the `verify/` Python cross-check question
      above: this would replace it. Trigger: after the client catchment run
      (first item) and the hydrologist persona review (below) confirm it's wanted.
- [ ] **Trace the runoff side.** "Trace a day" covers farms and gauges only.
      With GR4J the default, most surprises are upstream: how rain becomes
      natural flow. Add a catchment trace: rain used, PET, AET, production
      and routing stores before and after, exchange, unit-hydrograph water in
      transit, natural flow out, and the day's store balance. The series are
      already stored (`production_store`, `routing_store`, `uh_store`, `aet`,
      `pet`, `exchange`), so it's the `/day` endpoint accepting the catchment
      (no `nodeId`) plus a GR4J column catalogue beside `verify/columns.ts`.
- [ ] **Alert on a failed self-check in production.** A failed check is a
      model bug, but today it is only a warning on that run. Log a
      structured line from `executeRun` (`{ event: "self_check_failed",
      projectId, runId, checks }`, no user data) and add a CloudWatch metric
      filter + alarm to the budget/alarms stack in `infra/`. `terraform plan`
      only; apply is the operator's call.
- [ ] **Hydrologist persona review of the Self-checks panel and exports.**
      Run `persona-hydrologist` on the panel, the farm daily CSV and the
      summary CSV: do they answer what a hydrologist checks first? Log gaps
      here. Cheap; decides whether the Excel audit workbook is worth a day.
- [ ] **More columns in the Data tab downloads** (the original request that
      led to the self-checks). `GET /series/:id/export.csv` still writes only
      `date` + the uploaded value. Add how the model used each series: for
      rainfall, the rain used that day after gap-filling, which source filled
      it (catchment / corrected CHIRPS / forecast) and the rain after the
      threshold; for CHIRPS, the day's bias factor and the corrected value;
      for flow, m³/day, the data-quality flags (negative, outlier, flat),
      whether the day is excluded from calibration, and the latest run's
      simulated outflow. Model-derived columns name the run they came from;
      without a run, raw values plus quality flags only. Waiting on the
      operator to confirm this is what they want (2026-09-24).

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
