# Follow-ups: open work (updated 2026-09-24, after the engine 0.19.0 / run notes round)

Everything below is known, unfinished work. Longer-term features live in
[planned-work.md](./planned-work.md); client and hydrologist questions are in
[plan.md § Questions for the client](./plan.md#questions-for-the-client).
Tick items off (or move them into an issue) as they are done.

## Blocking releases (operator)

- [ ] **Client flow volumes in git history.** Until 2026-09-24,
      `docs/plan.md` quoted the client catchment's per-water-year gauge and
      logger volumes (commit 4f931bb onward). The tree no longer has them,
      but history does. Scrub them (`git filter-repo --replace-text`, as for
      WP-1.7) before the repo is made public.

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
      model.md) have landed. The question in [plan.md](./plan.md) is now a
      confirmation (logger as target, gauge as regional index) plus the
      rating, area and short-record questions, with the client flow volumes
      it used to quote removed (2026-09-24). Still open: the hydrologist's
      yes, then record it (dated) in plan.md and close #1.
      The runoff-ratio check needs the client workbook back in
      `../project-water-management-source/Original/`.
- [ ] **Engine audit decisions to confirm** ([engine-audit.md](./engine-audit.md)).
      Implemented 2026-09-24 on simulated hydrologist and CMA-assessor
      recommendations (reports in gitignored `reviews/persona-*-audit-decisions.md`),
      **not** client sign-off. Put each to the hydrologist as "confirm or change":
      - H1: legacy kept unchanged but labelled workbook comparison only, never
        evidence (warning, badge, CSV comment); GR4J is the model of record.
      - N3 (engine 0.14.0): a 25 mm soil-water store carries effective rain
        over; 0 reproduces the workbook. Confirm the size per soil/root depth.
      - Q5 (0.16.0): `damMinPct` is the dam's minimum operating level;
        existing values were reset to 0 (they were the workbook's transfer
        minimum).
      - N1 (0.16.0): irrigation efficiency e and losses returning β replace
        return flow %; backfilled so a crop is now fully supplied (r > 0 →
        e = 1 − r, β = 1). Ask whether the client's crop factors already
        include losses (then scale them by 1 − r to keep today's numbers).
      - N2 (0.16.0): dam evaporation (lake factor 0.75 × A-pan), rain on the
        dam and seepage; unknown areas use capacity ÷ 3 m (warning W6).
        Needs each dam's area when full, and confirming the "Mantel & Hughes
        2023" 3 m median depth reference (not verified). Rain on a dam is
        partly double-counted with land runoff.
      - N4/Q3/Q18 (0.16.0): transfers capped at the receiver's room; an
        explicit priority, with equal priorities sharing pro rata.
      - Q17/Q13/Q11 (0.17.0): EWR shortfall charged to upstream farms pro
        rata to net impact at the outlet and every gauge (the rest reported
        as natural), split into irrigation and storage parts; the old AB is
        kept as "reach shortfall"; zero-demand farms get no irrigation cut;
        "Demand left %" bounded, "—" under 1 m³/day; equitable share labelled
        a fairness benchmark, not an allocation.
- [ ] **Attribution follow-ons (Q17):** add the EWR site list to run
      comparison's *What changed*; a per-gauge "is an EWR site" flag
      (WP-3.7); the per-run attribution self-check is exact only where no
      transfer crosses a site's catchment boundary, because per-rule transfer
      volumes aren't stored as run series (the full invariants run in
      `network/attribution.test.ts` and the fuzz suite).
- [ ] **Client regression suite is thinner since N1.** Nearly every client
      farm has return flow, which the new efficiency model can't reproduce,
      so the replay skips those farms' balance columns and everything
      downstream (listed under N1). It now checks the network mainly through
      runoff, EWR and crop requirement. Durable fix: replay the workbook's
      own G and T per farm into the network (as `[Shortfalls]` already is)
      so the downstream columns are tested again.
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
      fallback bias correction lands, because it uses these flags. Once
      CR-20 lands (below) a flagged zero run changes results, not just
      warnings, so a false alarm is no longer free: item 2 matters more.
- [ ] **CHIRPS bias correction (engine 0.7.0, audit B1).** CHIRPS that fills
      in for blank catchment rain is now scaled per calendar month by
      Σ catchment / Σ CHIRPS, fitted without the suspect catchment rain the
      issue #2 checks flag ([model.md §2.4b](./model.md#24b-chirps-fallback-bias-correction)).
      **Done (engine 0.18.0): the fit follows the zero-rain decisions.** A
      flagged run treated as missing is left out day by day (the rest of its
      water year stays in), kept-dry days stay in as confirmed readings, and
      a keep-dry that bias-corrected CHIRPS contradicts (more than max(50 mm,
      25 % of the usual annual rain) over its kept days) leaves its year out
      and warns. Low-vs-CHIRPS years are still left out whole. The run's
      `chirpsCorrection`, summary CSV and run comparison (`chirpsFit`) say
      what was left out. Confirm the guard's limits with the hydrologist.
      Confirm with the hydrologist:
      - linear scaling per month, versus quantile mapping (which also fixes
        the wet-day count and intensities that drive GR4J's event response);
      - the minimum sample (90 shared days and 50 mm of CHIRPS per month,
        else the pooled factor) and the 0.25–4 clamp;
      - whether a neighbouring gauge should fill gaps before CHIRPS does.

      Re-run the issue #4 phase 6 GR4J-vs-legacy comparison on the client
      catchment with the correction on (condition 1), and record the result
      in the issue.
- [ ] **Zero-rain runs treated as missing (CR-20, issue #3). Built
      (2026-09-24): engine, API and CSV export landed in engine 0.15.0
      (audit B2, model.md §2.4c), then the Settings section, the Data tab
      shading and the help entry (ui.md), then `zeroRainRuns` in a fit
      record's `forcing` (fit provenance), so a change flags "Forcing changed
      since fit". Engine 0.18.0 added the double-mass check and made the
      CHIRPS fit respect keep-dry (end of this item). Still open: the hydrologist's
      answer on the two flagged runs.** The issue #2 checks find runs of zero catchment rain
      that look like missing data, but they only warn. A 0 is a reading, so
      those days still run dry and CHIRPS never fills them. On the client
      catchment the check flags exactly two runs, one in the 1991 wet season
      and one covering all of 2000, and none of the long dry summers. Both
      runs sit in the wet season, and CHIRPS recorded substantial rain on
      each. The plan:
      1. **Engine:** when picking rain used (model.md §2.4, column R), a day
         inside a flagged zero run counts as blank. Bias-corrected CHIRPS
         (§2.4b) then fills it, then forecast rain. Stored catchment rain is
         never changed. Minor `ENGINE_VERSION` bump.
      2. **Setting** `settings.zeroRainRuns`: `mode` `'missing'` (default)
         or `'asRecorded'`, plus two date-range lists. `keepDry` holds
         flagged runs the hydrologist confirms as real dry spells. `missing`
         holds extra ranges to treat as missing, e.g. the bad days inside a
         low-vs-CHIRPS year. They're saved in project settings, so each run's
         snapshot reproduces them.
      3. **Visible:** a run warning lists the filled ranges, their days and
         mm (raw → corrected). Results carry a per-day infilled-rain flag,
         the first slice of CR-18 in the same shape as WP-1.32's `filled`
         mask. Filled days are shaded on the daily rain chart. Settings →
         Data quality edits the mode and the lists.
      4. **Audit trail:** a finding in engine-audit.md; the affected columns
         go on the client catchment regression suite's deviation list;
         model.md §2.4/§2.4b/§2.10a, ui.md, api.md and the help text are
         updated with the code.

      Why default on: a false positive costs little, because in a real
      drought CHIRPS is dry too and filling it adds little rain. A missed
      gap runs a whole wet season dry. Rejected: fixing it in the importer
      (hides the change, and CSV uploads bypass it) and filling from
      climatology (smears rain over every day and loses storm timing).
      Still ask the hydrologist to confirm the two runs
      ([plan.md § Questions, *Zero-rain runs*](./plan.md#questions-for-the-client)). Out of
      scope: low-vs-CHIRPS years are never blanked whole; the `missing`
      list covers them once the hydrologist names the bad days.
      **Double-mass check against CHIRPS: done (engine 0.18.0, audit B3,
      model.md §2.10a).** Water-year totals, up to two breaks, a data check,
      a Data-tab chart, a summary-CSV block and a run warning when CHIRPS
      fills an era whose ratio differs from the fit. It only warns; the
      response to a real break is the *CHIRPS fit period* item below. The
      same release made the CHIRPS fit leave flagged runs out day by day and
      keep kept-dry days in (the *CHIRPS bias correction* item above).

      **Simulated review (2026-09-24), a draft for the real hydrologist, not
      sign-off.** A `persona-hydrologist` review
      (`reviews/persona-hydrologist-zero-rain.md`, gitignored and local only,
      because it quotes client numbers) judged both flagged runs to be
      missing data, not real dry spells, from CHIRPS and the neighbouring
      gauge's response. It suggested listing some adjacent days as `missing`
      too: a probable accumulated reading straight after one run, shorter
      zero runs in the same year below the 60-day rule, and zero-padded
      stretches next to calendar-year blank blocks. It also suggested an
      accumulation check (a very large reading straight after a zero or
      blank run, on a day CHIRPS is dry). None of this is applied: the
      hydrologist decides what to list
      ([plan.md § Questions, *Zero-rain runs*](./plan.md#questions-for-the-client)).
- [ ] **CHIRPS fit period / per-segment factors (tracked from audit B3,
      2026-09-24).** The double-mass check (model.md §2.10a) warns when the
      catchment / CHIRPS ratio breaks part-way through the record, but the
      CHIRPS factors are still one set fitted over all eras, so a gap in the
      latest era is filled with a blend of older ratios. The simulated
      hydrologist review suggests two durable responses, never applied
      silently:
      1. a setting `chirpsFitPeriod`: `'all'` (the default), `'latestSegment'`,
         or explicit water-year ranges, each with a reason, recorded in fit
         provenance (`forcing`) and in run comparison;
      2. better, **per-segment factors**: fit the monthly factors within
         each double-mass segment and fill a gap with its own segment's
         factors, which keeps the monthly shape and removes the blend.

      Trigger: the hydrologist confirms a break on the client catchment is
      the catchment series changing (station attrition, a new averaging),
      not CHIRPS, or a project's fallback days mostly fall in a segment the
      run warning names. Needs an `ENGINE_VERSION` bump, a Settings control,
      docs (model.md §2.4b, §2.10a) and tests on synthetic broken records.
- [ ] **Help text read-through** (`frontend/src/lib/help/content.ts`),
      especially the entries built on open quirks.
- [x] **Curtailment "Demand left %"** is bounded 0–100 and shows "no
      demand" / "—" below 1 m³/day (Q13, engine 0.17.0).

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
- [x] **Fix the monthly pan coefficient (A-pan → PET) before calibrating.**
      Done 2026-09-24 (model.md §2.4a, §2.10b): it is never a calibrated
      parameter (guard test); a fit records the forcing it ran under (pan
      coefficient, A-pan, CHIRPS bias correction) and shows "Forcing changed
      since fit" when any differs; Settings offers generic / winter-rainfall /
      summer-rainfall presets (indicative, FAO-56 Table 5 classes) and a run
      warns outside 0.6–0.85. `pnpm pan-sensitivity <project.json>` runs GR4J
      at 0.60 / 0.70 / 0.85 and the winter preset, fixed and refitted. On the
      client catchment (table in gitignored
      `data/client-catchment/pan-sensitivity.md`):
      - with parameters fixed, 0.60 → 0.85 lowers MAR by roughly 10–15 % and
        raises EWR days not met by roughly a tenth;
      - refitting does **not** absorb it: EWR days not met is, if anything,
        more sensitive after refitting;
      - refits score better at flat 0.70 and the winter preset than at the
        extremes, a mild hint that the true forcing sits mid-range.
      Still open: the hydrologist picks the monthly values (plan.md Q4).
- [ ] **The stored GR4J parameters don't fit the logger.** The same
      sensitivity run found the client catchment's current GR4J parameters
      score a negative NSE against the logger at every pan coefficient;
      refitting gives positive NSE/KGE and cuts simulated MAR by roughly a
      third to a half. Refit (typical bounds + the WR2012 MAR band, the fit
      recommended above) once the pan coefficient is chosen, and before any
      client numbers are shown.

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
- [x] **Persona tooling** (2026-09-24): `tsx` is an engine dev dependency
      (same pin as the backend), so `pnpm -C packages/engine exec tsx` works.

## Calibration research (2026-09-24)

The review in [calibration-research.md](./calibration-research.md) turned into
34 recommendations (CR-1 … CR-34), with priorities and effort. Open items, in
the suggested order (the IDs carry the detail):

- [ ] **Cheap first:** CR-3 KGE(Q)+KGE(1/Q) objective, CR-34
      record-representativeness note. CR-2 multi-start DDS (engine 0.13.0,
      model.md §2.10b) and CR-6 drop Moriasi words on daily scores
      (model.md §2.10) are done.
- [ ] **Data layer:** CR-18 per-day quality flags → CR-19 flag-aware
      objective → CR-20 flagged zero-rain runs become missing so corrected
      CHIRPS fills them (closes the gap behind issue #3) → CR-22 data-quality
      panel. CR-20 went first (built 2026-09-24, engine 0.15.0; see
      "Zero-rain runs treated as missing" above). Its per-day infill flag is
      the rain slice that CR-18 then generalises.
- [ ] **Fit-settings sweep (headless).** The free / typical-bounds / band /
      both comparison (above, under "Make the logger fit identifiable") was
      built by hand, and every further "what if we fit it this way" repeats
      that. Generalise `backend/scripts/pan-sensitivity.ts` into a script
      that takes a `project.json` and a grid of fit settings (pan preset ×
      bounds × objective × named exclusion sets × WR2012 band on/off),
      runs `calibrate()` with validation for each cell, and writes one
      Markdown table: fitted parameters, in-sample and validation scores,
      MAR and EWR days not met, with seed and engine version in the header.
      It fits every cell and ranks nothing, so the choice stays the
      hydrologist's and is recorded with a reason, as exclusions are. No DB
      or UI; client output stays in the gitignored `data/`. This is not
      CR-21, which perturbs the inputs of one fit rather than comparing fits.
      CR-1 below can then reuse its batch and report code. Do it
      before CR-1, or as soon as the hydrologist asks for another
      side-by-side of fits.
- [ ] **Ensemble and reporting:** CR-1 behavioural ensemble with the EWR range
      → CR-5 bootstrap CIs and benchmarks → CR-21 sensitivity runs and
      "not determinable" → CR-28 WR2012 five-statistic table (confirm the
      thresholds in WRC TT 689/690 first) → CR-29 compliance as %time, %volume,
      FDC overlays and %nMAR.
- [ ] **Automated calibration with pre-declared rules.** Today every pass
      of the calibrate → review → adjust → refit loop needs a person, because
      the choices (exclusions, forcing, which fit to keep) are made after the
      scores are seen. Automating those choices by chasing the score would
      overfit and be easy to game. The durable fix is a **rule set** stored
      with the project and fixed before any result is seen, so the whole
      loop can run unattended:
      1. Exclusions come from the per-day quality flags (CR-18/19) by rule
         (e.g. a water year with more than 20 % flagged days), each with a
         machine reason naming the rule.
      2. Forcing comes from the rule set, or each option becomes a sweep
         case (the fit-settings sweep above).
      3. The sweep fits every case; the rule set picks one by a **validation**
         score (e.g. best dry → wet KGE′), never in-sample, among the fits
         that pass stated filters (MAR inside the WR2012 band, parameters in
         Perrin's typical range).
      4. CR-1 builds the ensemble around the kept fit and reports the EWR
         range.
      5. New observed or rain data triggers a rerun (needs the Background
         jobs item in [planned-work.md](./planned-work.md)); the fit record's
         stale checks already say when one is due.

      The rule set, seed and engine version go in the fit record, so a run
      is reproducible and an assessor can challenge the rules rather than
      the result. A rule-set change is versioned and shows in run
      comparison, like any other settings change. Facts that aren't in the
      data (which gauge is on the modelled river, the highest trusted
      gauging, known gauge breaks) stay per-catchment metadata that a
      person enters once. **Depends on:** the sweep → CR-18/19 → CR-1 →
      Background jobs. **Needs the hydrologist to sign off** the default
      rules (flag thresholds, selection score, filters) before any automated
      fit is used as evidence; add that to [plan.md](./plan.md) with the
      other hydrologist questions. Trigger: once the sweep and CR-18 have
      landed.
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
- [x] **A fourth full page load of the Settings tab fails in e2e** with
      `net::ERR_INSUFFICIENT_RESOURCES` / "Failed to fetch dynamically
      imported module" against the Vite dev server (:7801). Done 2026-09-24:
      e2e now runs against a production build of the frontend
      (`vite build` into `frontend/build-e2e/` with the e2e API URL baked in,
      served with the SPA fallback by `e2e/support/static-server.mjs`), which
      also matches production. Measured with `tests/repeated-loads.spec.ts`
      (six `page.goto(…?tab=settings)` in a row, `--workers=1
      --repeat-each`): dev server 3 of 3 failed at the fourth load; built site
      5 of 5 passed. That spec stays as the regression guard.
      `E2E_DEV_SERVER=1` still runs against `vite dev` for debugging
      ([e2e/README.md](../e2e/README.md)). Specs that already navigate between
      tabs in the app rather than with repeated `page.goto` can stay as they
      are: that is how a user moves around anyway.
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
      catchment takes under 50 ms" failed once (2026-09-24), and "runs 13
      nodes × 16k days well under a second" (`run.test.ts`, client
      catchment, < 1 000 ms) failed twice on 2026-09-24 in a full parallel
      `pnpm test`, passing alone while all three
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
      **Seed 921 fixed in engine 0.19.0** (2026-09-24): the transfer room
      cap (N4) ignored the receiving dam's own rain, evaporation and
      seepage, so a leaky dam was topped up short by a fixed volume and
      doubling demand raised its supply fraction. The room is now
      `cap − (Q[t−1] + Pd − E − Sp) + D − scheduled` (model.md §2.6),
      `checkTransferLimits` reads it the same way, and a named seed-921
      test pins it. A 2 000-case soak on 0.19.0 passed for both runoff
      models; the 20 000-case soak is still owed.
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
- [x] **Trace the runoff side** (2026-09-24): `/day` without `nodeId`
      traces the catchment (GR4J stores before/after, exchange, UH, natural
      flow, and the store balance with its residual; legacy runs list the
      [Flow data] columns). Column catalogues `GR4J_COLUMNS` /
      `LEGACY_RUNOFF_COLUMNS` in `verify/columns.ts` (ui.md, api.md).
- [ ] **Per-store starting values on a run's first day.** Only the total
      storage after the warm-up is saved, so day one's catchment trace
      shows each store's "before" as "–" and balances on the total. Saving
      each store at the end of the warm-up is an engine change (bump
      `ENGINE_VERSION`). Trigger: the hydrologist asks for day-one detail.
- [x] **Alert on a failed self-check in production** (2026-09-24):
      `executeRun` logs `{ event: "self_check_failed", projectId, runId,
      checks }` (check ids only), and `infra/alarms.tf` has a metric filter
      + alarm on the alerts SNS topic (plan-tested; not applied).
- [ ] **Hydrologist persona review of the Self-checks panel and exports.**
      Run `persona-hydrologist` on the panel, the farm daily CSV and the
      summary CSV: do they answer what a hydrologist checks first? Log gaps
      here. Cheap; decides whether the Excel audit workbook is worth a day.
- [x] **See every input series and how the model used it** (2026-09-24):
      the Data tab's Preview dialog joins every input series by day with
      rain used and its source, CHIRPS factor and corrected value, flow in
      m³/day, per-series flags and calibration exclusions (ui.md). Its e2e
      spec `e2e/tests/series-preview.spec.ts` passes (2026-09-24); the dialog
      is now near full-screen (`Dialog` `full` size).
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
- [x] **"Sign out everywhere" button** (2026-09-24): the header's account
      menu has *Sign out* and *Sign out everywhere*. The rest of WP-1.9
      (`/account` page, password change, `PATCH /auth/me`) is still open in
      the step-1 roadmap.
- [ ] **Exports carry unrounded values** now that the engine doesn't round.
      Decide on export number formatting.

## Roles and what each member sees

Today the workspace shows the same seven tabs to everyone. Owners and team
admins see and change everything, which is right. Everyone else sees every
modeller tab too: a viewer gets Network, Crops, Transfers, Data and Settings
& calibration read-only, under a "View only" note (`routes/projects/[id]/+page.svelte`).
Roles are `viewer` / `editor` / `owner` per project, and team `member`
(→ editor) / `admin` (→ owner) (data-model.md § Roles, § Teams).

Already planned, so not repeated here: the **`farmer`** role, with its own
phone view at `/farm/:id` and farm-scoped RLS, which redirects a farmer away
from the workspace entirely (roadmap step 2, WP-2.1 onward). Also planned:
read-only **share links** for regulators, viewers opening on the published
run, and help entries tagged by `audience`, all in step 2.

Open gaps:

- [ ] **No read-only team role.** Every team member becomes an editor on
      every team project, so a WUA office clerk or a client reviewer added
      to the team can change settings and run the model. Add a team role
      `viewer` (→ project `viewer`). This needs a migration adding the enum
      value, the `app_project_role()` mapping, team invites taking it, and
      the team page. Tests: DB tests that a team viewer reads but can't
      write, with a positive control that a team member can write.
- [ ] **Tabs by role.** Viewers are shown tabs they can't act on and mostly
      don't need. Build one pure function, `visibleTabs(role, prefs)`, that
      the tab strip and the Overview checklist (whose steps link to tabs) both use:
      - owner and editor: every tab, as now;
      - viewer: Overview and Runs & results, plus Data (charts and
        downloads); the model tabs (Network, Crops, Transfers, Settings &
        calibration) sit behind a "Show model inputs" toggle.

      **This is presentation, not access control.** RLS still lets a viewer
      read every input, so a deep link (`?tab=settings`) keeps working, and
      nothing gets hidden "for privacy" this way. Data a role must not see
      needs RLS, as the farmer role has.
- [ ] **Members choose their own tabs.** Let each user hide tabs they don't
      use (within what their role can see), with a "Reset to default" option.
      Store the choice in `app_user.preferences`, the jsonb column that
      WP-1.26 (unit preferences) introduces and that isn't built yet. Build
      that column first, or with this. Overview can't be hidden. A hidden tab
      still opens from a deep link, and a "Hidden tabs (2)" menu brings it
      back.

Tests for the last two: unit tests for `visibleTabs` across role ×
preference, including an owner who can't lose Overview. An e2e test that a
viewer sees the short tab set, turns on "Show model inputs", and opens a
deep link to a hidden tab. Route-auth is unchanged. Docs: ui.md (the tabs
table), data-model.md § Teams, api.md (team roles, `preferences`).

**Ask the client:** which people at the WUA and the client need which role,
and whether viewers should see model inputs by default. **Trigger:** before
the first non-modeller user is invited (WUA staff, a client reviewer), and
with WP-2.1 at the latest, so the farmer role lands alongside a team viewer
role and not before it.

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
  - [x] **A written explanation per run** (2026-09-24): migration 007
        adds `model_run.notes` (+ who/when stamp by trigger); the app may
        `UPDATE` only that column; `PATCH /projects/:id/runs/:runId`; the
        Run notes panel under WR2012, run comparison and the summary CSV
        carry it (data-model.md § Run notes).
  - [x] **Summary CSV export** carries the WR2012 block (reference, scaling,
        MAR ratios, monthly table, flag) and the run notes (2026-09-24).
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
