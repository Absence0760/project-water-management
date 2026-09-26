# Follow-ups: open work (updated 2026-09-24, after the engine 0.19.0 / run notes round)

Everything below is known, unfinished work. Longer-term features live in
[planned-work.md](./planned-work.md); client and hydrologist questions are in
[plan.md § Questions for the client](./plan.md#questions-for-the-client).
Tick items off (or move them into an issue) as they are done.

## Blocking releases (operator)

- [ ] **GitHub variables for the background Lambdas (2026-09-25).** The
      backend release preflight (`deploy-backend.yml`, `REQUIRED_CONFIG`)
      refuses every `backend@` release until these repository variables
      exist: `WORKER_FUNCTION_NAME` (job queue, #10 part 1),
      `FETCHER_FUNCTION_NAME` (data feeds, #10 part 2),
      `RENDERER_FUNCTION_NAME` and `RENDERER_ECR_REPOSITORY` (server-side
      PDFs, #26). They are Terraform outputs (`infra/outputs.tf`), so after
      the AWS bootstrap below, re-run
      `~/github/templates/scripts/export-tf-vars.sh infra/` and check all four
      appear under the repo's Settings → Variables.
- [ ] **Renderer Lambda needs a two-step first deploy (#26).** Lambda can't be
      created before its image is in ECR: apply without it, cut the first
      `backend@X.Y.Z` release (which builds and pushes
      `backend/renderer.Dockerfile`), then set `renderer_image_tag` to that
      version and apply again. The image has never been built or run on
      Lambda; smoke-test one render in production and check its alarms
      (details under § Server-side reports).
- [ ] **SES production access.** Report links (#26), invites and password
      resets reach only verified addresses while SES is in the sandbox.
      Request production access in the chosen region before any client uses
      email.
- [ ] **AWS budget default is now $60** (`infra/variables.tf`
      `budget_monthly_usd`; was $50). The job queue's SQS interface endpoint
      adds ~$7.30/month per AZ; feeds and the renderer add ~$2/month idle.
      Keep it, or set your own in tfvars (about 80 for af-south-1, below).
- [ ] **Data-feed terms** (operator, roadmap D7): DWS's terms for automated
      fetching and whether the fetcher's region can reach the site (it
      answered our network with HTTP 403, so the DWS parser is untested
      against the live page); CHIRPS-GEFS's licence before client use
      (details under § Features left half-way).

- [ ] **Client flow volumes in git history.** Until 2026-09-24,
      `docs/plan.md` quoted the client catchment's per-water-year gauge and
      logger volumes (commit 4f931bb onward). The tree no longer has them,
      but history does. On 2026-09-25 a wider sweep also took out of the tree
      the calibration window and logger dates, fit scores on client data, the
      gauge and logger site labels, record lengths, farm/node/transfer counts,
      run timings and sizes, workbook cell values and the blank workbook's
      catchment area (docs, test fixtures, help text). History still has all
      of it. Scrub it (`git filter-repo --replace-text`, as for WP-1.7, with
      the value list kept in `infra-secrets/water-management/`) before the
      repo is made public. `pnpm check:terms` is a no-op until that terms
      list exists.

- [ ] **GitHub plan.** The repo is private on a free plan, so:
      - required reviewers and branch protection aren't available, which means
        the release preflight refuses every release;
      - CodeQL and Scorecard fail on every push.

      Make the repo public (after the history scrub above) or upgrade the plan. Then
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
      `budget_monthly_usd` to about 80 and set `dmarc_report_email`.

## Hydrologist

- [x] **Calibration record:** the gauge vs the logger over their overlap,
      [#1](https://github.com/Absence0760/project-water-management/issues/1)
      (closed 2026-09-25). Decided: the logger is the calibration and
      validation target, and the gauge column (a neighbouring river's gauge,
      partly area-scaled) is a regional wet/dry index only
      ([model.md §2.10](./model.md), [plan.md § Questions](./plan.md#model-and-hydrology-for-the-hydrologist)).
      The hydrologist's agreement was assumed by the operator, not given in
      writing; reopen #1 if they disagree. Plan items 1–3 (no silent default
      pick, a neutral agreement warning, the findings in model.md) landed
      earlier. Still open, and separate: the rating, area and short-record
      questions (plan.md questions 2–4), and the runoff-ratio check, which
      needs the client workbook back in
      `../project-water-management-source/Original/`.
- [ ] **Human impacts (WP-1.33–1.35) to confirm** ([model.md §2.7c](./model.md)).
      Built 2026-09-25, off by default, on the engineering decisions below,
      not client sign-off. Put each to the hydrologist as "confirm or change":
      - WP-1.33 other water users (engine 0.22.0): are there towns, industry
        or unlisted irrigators upstream of the logger, and what do they take
        (monthly m³/day) and return? Priority: a senior user's demand is
        passed down by the farms upstream (fragmented by flow share like the
        EWR; farms divert less, then pass inflow below the dam), and it is
        **not curtailed** for the EWR (its charge stands, not moved onto
        farms); a junior user takes what reaches it and is curtailed like a
        farm. Confirm both rules and which priority each user has. Known
        limit: a farm never releases stored water for a senior user, and
        development (users, their demand) can't vary within a run.
      - WP-1.34 boreholes (engine 0.23.0): do boreholes matter in the client
        catchment, and is there any data on pumping volumes, distances from
        the river or aquifer tests? Confirm the method (a lagged linear
        reservoir with capture share d and time constant k, not a Glover/Hunt
        kernel) and the values; depletion the river can't give is dropped,
        not carried over. If the calibration record was measured while they
        pumped, calibrate with them in the model (model.md §2.7d).
      - WP-1.35 land cover (engine 0.24.0): which covers matter in the client
        catchment (invasives, plantations, riparian stands) and their
        condensed areas? The class reductions are indicative mature-stand
        values (model.md §2.5a); confirm them, or supply the Scott & Smith /
        Gush curves by age and site the CMA uses. Confirm the daily split
        (low-flow share on each day's flow up to the Q75 natural flow, the
        other share above it) and whether orchards and vineyards need a class.
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
- [ ] **Multi-day rain accumulations (issue #2, audit B4). Built (engine
      0.20.0, model.md §2.4d): detection, spreading by bias-corrected CHIRPS
      (default on), keep-as-recorded and listed windows in Settings → Rain
      gaps and CHIRPS, the run warning, `summary.rainAccumulation`, the
      `rain_catchment_spread` column, the summary CSV block, Data-tab shading,
      run comparison and fit provenance.** Still open, for the hydrologist
      (engine-audit.md question 10): (1) confirm the thresholds (20 mm; 3 days;
      CHIRPS ±1 day < 25 %; CHIRPS over the run ≥ 50 %; 92-day cap) against
      the station's observer logs or "accumulated" flags, if the source files
      have them; (2) some detected windows read far less than CHIRPS over
      them. An unread gauge loses catch to evaporation and overflow, so decide
      whether such a window's total should be scaled up, or its days treated
      as missing instead of spread. The durable fix is an under-catch rule
      with its own threshold (the window's total against corrected CHIRPS),
      once the hydrologist says which; until then the gauge total is kept.
      Trigger: the hydrologist's review of issue #2.
- [ ] **Zero-rain runs treated as missing (CR-20, issue #3). Built
      (2026-09-24): engine, API and CSV export landed in engine 0.15.0
      (audit B2, model.md §2.4c), then the Settings section, the Data tab
      shading and the help entry (ui.md), then `zeroRainRuns` in a fit
      record's `forcing` (fit provenance), so a change flags "Forcing changed
      since fit". Engine 0.18.0 added the double-mass check and made the
      CHIRPS fit respect keep-dry (end of this item). Engine 0.20.0 handles
      the multi-day accumulations some of these runs end in (audit B4,
      model.md §2.4d): the reading's total is spread over the run by CHIRPS
      instead of being kept on its day while CHIRPS also fills the run, which
      counted that rain twice (the item above). Still open: the hydrologist's
      answer on the two flagged runs.** The issue #2 checks find runs of zero catchment rain
      that look like missing data, but they only warn. A 0 is a reading, so
      those days still run dry and CHIRPS never fills them. On the client
      catchment the check flags exactly two runs, one within a wet season
      and one covering a whole year, and none of the long dry summers. Both
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
        neighbouring river *upstream* of its confluence with the
        modelled river, so none of the modelled catchment drains through it.
      - **That sub-catchment is heavily developed**, with several times
        the irrigation demand upstream of the logger and large farm-dam
        storage. The source report notes that early-season flows there go
        into filling dams.
      - **The workbook column mixes two scalings:** raw for the earlier part
        of the record, and area-scaled for the later part.
      - **The close overlap agreement is one wet half-year.** The records
        agree on volume only over the first, flood-dominated half water year
        of their overlap. Their medians already differ, and the volume ratio
        falls in every later year to near zero.
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
         they differ substantially, so use the band between them, not one
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
         Checked on the client workbook: the scaled stretch starts cleanly on
         one date, and after unscaling every value is back to whole
         thousandths of m³/s, as published.
      5. **Confirm the modelled area.** The project's catchment area differs
         from the source report's area at the logger. Ask the
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
      - with parameters fixed, 0.60 → 0.85 lowers MAR noticeably and
        raises EWR days not met;
      - refitting does **not** absorb it: EWR days not met is, if anything,
        more sensitive after refitting;
      - refits score better at flat 0.70 and the winter preset than at the
        extremes, a mild hint that the true forcing sits mid-range.
      Still open: the hydrologist picks the monthly values (Q4 below).
- [x] **The stored GR4J parameters don't fit the logger.** The client
      project never had fitted GR4J parameters (it ran on the defaults).
      **Refitted 2026-09-25 on engine 0.20.0** (after the rain fixes of
      issue #2), results in the private repo's `Research/`:
      - **Pan coefficient: the winter-rainfall preset** (operator decision,
        hydrologist agreement assumed). The record can't tell it from a flat
        0.70 (the fits score the same), so it rests on physics: the
        catchment's rain is strongly winter-dominated, and FAO-56 Table 5
        gives a lower Class A pan coefficient in dry, windy summers and a
        higher one in humid winters.
      - **Wide bounds, not typical.** Under Perrin's typical bounds X1 sits
        on its upper bound and the simulated MAR leaves the WR2012 band; the
        wide-bounds fit is better, keeps MAR inside the band (so the soft
        penalty doesn't bind), and all five starts agree. X1 lands far above
        the typical range, consistent with the rain-level question in #12.
      - **Validation is weak** (split-sample and dry → wet well below the
        fitted score): any client figure needs its uncertainty (Phase 9).
      Applied to the local project only; the workbook's A-pan level is
      questioned in #13 and would change the fit if corrected.

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
  EWR assurance rules, not a raw count of days below the EWR (done, engine
  0.21.0, below). Phase 9 criteria are below.

**Open items (not yet started):**
- [x] **Phase 9: uncertainty bands.** Done 2026-09-25, engine 0.26.0,
      migration 014 ([model.md §2.10e](./model.md#210e-uncertainty-bands-engine--0260-issue-4-phase-9),
      [ui.md](./ui.md), [run-comparison.md](./run-comparison.md)). A seeded
      Latin hypercube over the free parameters (log-uniform across a
      decade or more), a ±0.1 pan-coefficient shift, station-with-infill vs
      CHIRPS-only rain and gauge vs logger; member 0 is the run itself.
      Kept by stored thresholds (KGE′ ≥ 0.5 before the split date, WR2012 up
      to *query* and inside the MAR band, low-flow bias ±50 %), diffed in the
      Runs-tab history and run comparison; coverage of the held-out half per
      record (warning below 70 %); no percentiles below 30 kept; bands on
      every output below plus the monthly Reserve compliance rate; paired
      B − A bands in run comparison; one model per ensemble. The database
      draws the seed and keeps every start; the server regenerates the
      sample and re-runs member 0 and three random members before storing
      (licensing, issue #15: bands can't be cherry-picked). The ensemble
      runs in the calibration worker: 300 members take 8–16 s on the example
      catchments. Defaults to confirm: plan.md question 18.
      Criteria it was built to (assessor):
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
- [x] **EWR compliance by the Reserve's assurance rules**, monthly, as the
      headline instead of raw days-not-met (hydrologist Q6). Done 2026-09-25,
      engine 0.21.0 ([model.md §2.9c](./model.md#29c-ewr-compliance-by-the-reserves-assurance-rules-engine--0210-hydrologist-q6)):
      an optional rule table per EWR site (Settings, paste from a
      spreadsheet), monthly compliance at the requirement the month's natural
      flow selects, the FDC check, the headline card, the Reserve compliance
      panel, a summary CSV block and run comparison. The method choices are
      plan.md question 17 for the hydrologist.
      - [ ] **Daily charge from the rule table.** The EWR charge and
            curtailment still follow the daily pragmatic EWR. If the
            hydrologist and the assessor want the rule table to drive them
            (plan.md question 17), the durable fix is a daily EWR series per
            site from the month's requirement (`ewr_rule`, already stored),
            fed to attribution in place of the pragmatic EWR, with a new
            engine version and a regression note. Trigger: their answer.
      - [x] **Uncertainty on compliance.** Phase 9's bands include the
            monthly Reserve compliance rate per site beside days not met
            (engine 0.26.0).
- [x] **Nominated evidence run** (2026-09-25, migration 010). An editor
      nominates a run as evidence with a required reason; the history is
      append-only in the database (who, when, runoff model and engine version
      stamped by a trigger), nominated runs can't be deleted or trimmed, and
      the Runs tab, run header, compare and summary CSV show it, with a
      warning when a later run uses another runoff model
      ([data-model.md](./data-model.md), [security.md](./security.md)). The
      assessor rated this Medium.
- [x] **Hydrologist plausibility checks** (as run warnings or a report).
      Done 2026-09-25, engine 0.25.0
      ([model.md §2.10d](./model.md#210d-hydrologist-plausibility-checks-engine--0250-issue-4-phase-6)):
      `RunSummary.plausibility`, run warnings, a *Plausibility checks* block
      in the summary CSV and a lazy-loaded panel on Runs & results
      ([ui.md](./ui.md)):
      - natural flow ≥ impacted observed flow + modelled abstraction in every
        water year (A = natural − simulated outflow, split into use, dams and
        land cover; 10 % of the observed volume allowed for gauging error,
        floor 1 % of the record's mean; judged with 300+ observed days);
      - EWR days reported separately for good-rain and fallback-rain years
        (a fallback year has more than half its rain, or its days, from
        CHIRPS, forecast, spread or blank days), with the Reserve months met
        split the same way; warns at a 10-point difference;
      - a double-mass curve of gauge flow against rain, to tell new upstream
        use from a failing gauge (the rain-vs-CHIRPS break detection,
        `doubleMassSegments`; each break set against the simulated outflow,
        with a seasonal hint);
      - dry-season low-flow duration curves overlaid for gauge, logger and
        each model (the latest run of each other runoff model), warning when
        the simulated Q90 is more than a factor of 2 from the observed.

      For the hydrologist: confirm the dry-season rule (six months of lowest
      mean flow), the 10 % / 1 % tolerance, the fallback-year rule and its
      10-point warning, the seasonal hint's 10-point margin and the factor of
      2 on Q90 (every value and its reasoning is in model.md §2.10d).
      Still open, each with its trigger:
      - [ ] **Checks on a gauge node inside the network.** The observed
            records are the outlet's, so the checks run there only. The
            durable fix is attaching an observed record to a gauge node
            (a series per node) and running check 1 and 4 at each. Trigger:
            a project with a second gauged site.
      - [ ] **The checks in the run comparison.** Compare shows neither the
            failing years nor the Q90 ratio side by side. Trigger: the
            hydrologist asks to compare the checks between runs (for
            example before and after a refit).
- [ ] **Phases 7 and 10 of issue #4:** Phase 7 (IHACRES) only if the
      hydrologist asks for it. Phase 10 (remove legacy) is issue #16, due by
      2026-11-30 (sign-off assumed 2026-09-25, issue #4 closed).
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
- [ ] **Ensemble and reporting:** ~~CR-1 behavioural ensemble with the EWR
      range~~ (done as Phase 9, engine 0.26.0: a few hundred Latin-hypercube
      sets in one worker, not 10–20k across several; more workers are the
      scaling step if the hydrologist wants larger samples) → CR-5 bootstrap CIs and benchmarks → CR-21 sensitivity runs and
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
      next to its bound. Then load it (`pnpm seed:demo`; the workbook has
      crashed a laptop before, so cap its memory: on Linux run it under
      `systemd-run --user --scope -p MemoryMax=4G`; macOS has no per-process
      cap, so close other heavy apps and watch Memory Pressure in Activity
      Monitor, stopping it with Ctrl-C if it turns red), make a run, and confirm in the Self-checks panel
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
      water year shows an implausibly high runoff coefficient: its catchment rain is a
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
- [x] **e2e runs from parallel worktrees share one `water_e2e` database and
      fixed ports** (:3101 and :7801). Fixed 2026-09-25: each checkout gets a
      slot (`e2e/support/env.ts`): the main checkout and CI keep :3101, :7801
      and `water_e2e`; a git worktree gets :3101+slot, :7801+slot and
      `water_e2e_<slot>` from a hash of its path; `E2E_SLOT` overrides. A
      slot clash fails on the port at start-up, before global setup touches
      the database. CI runs the suite as 14 shards on one shared build
      (e2e/README.md § CI). The flakes seen under load (`chirps-bias`,
      `data-quality`, 2026-09-24) were never reproduced alone; if either fails
      on its own, look for a missing readiness signal on reload rather than a
      longer timeout.
- [x] **Wall-clock test flakes under load** (2026-09-24): the timing
      checks moved out of the unit suite into `*.perf.test.ts` vitest
      `perf` projects (median of 7 after a warm-up, serial), run with
      `pnpm test:engine:perf` / `pnpm test:backend:perf`, not by
      `pnpm test` or CI. The backend's 50 ms example-catchment budget
      still fails when the machine is busy; run it alone.
- [x] **Frontend bundle split by tab** (2026-09-24): the catchment
      workspace loads each tab (and the Add data / series preview dialogs)
      on demand (`common/Lazy.svelte`, architecture.md § Code splitting).
      Largest chunk 130 → 37 KB (ceiling 41 KB); opening a catchment ~298
      → ~89 KB. The total was already 383 KB against a 295 KB ceiling on
      main (help centre, new tabs' code, engine code), so its ceiling went
      *up* to 411 KB (405 KB measured).
- [x] **Bring the total bundle down** (issue #9, 2026-09-25): −6 KB (419 →
      413 KB on main at merge; main had already passed the old 411 KB ceiling,
      now 419), from `build.target: 'es2022'`. Help tips
      load the help text off the critical path (−26 KB on each tab with a
      tooltip; the total doesn't move). Measured and rejected, with the numbers
      in the guard's change log: sharing the engine with the calibration
      worker (−13 KB total but +23 KB on a catchment's cold open) and
      `experimentalMinChunkSize` (1–4 KB, cold loads grow).
- [x] **The Runs tab no longer carries the whole help text** (it was 26 KB
      gzip on top of the page, through `WaterStoryPanel` → `PictureTour` →
      `lib/help/guides.ts` → `lib/help/content.ts`). Fixed by removing the
      "Where the water went" panel, which repeated figures the summary cards,
      the self-checks' water balance and the runoff model panel already show;
      no project-page component imports `lib/help` now. If PictureTour comes
      back to an app page, give it a small `id → title` map for its guide links
      first, so it stops importing `guides.ts`.
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
      models.
      **20 000-case soak on 0.19.0 (2026-09-24) failed**, stopping at the
      3-failure cap per model (legacy scanned seeds 1–8984, GR4J 1–17277),
      so later seeds are unscanned. **20 000-case soak on 0.21.1
      (2026-09-25, `FUZZ_MAX_FAILURES=100`, seeds 1–20 000):** GR4J passed;
      legacy failed on one seed, 14313 (order invariance, below). Repro any seed with
      `FUZZ_SEED=<n> FUZZ_CASES=1 pnpm -C packages/engine exec vitest run src/run.invariants.test.ts`.
- [x] **Order invariance: EWR days not met off by one (seeds 4014, 8984,
      9681).** Fixed in engine 0.19.1 (2026-09-25). The cause was not the
      summing order of E but which farms counted as having an impact at all.
      A farm's net impact e was called noise only against its own *flows*, and
      two cases slipped through: a full dam spilling its runoff (e = I − spill
      cancels at the scale of the storage, ±1e-11, seed 4014), and an empty farm
      below one whose outflow carried a 1e-13 residue (seed 8984). Either came
      out positive in one node order and 0 in the other, so the farm was charged
      for a day. `network/attribution.ts` now sizes the noise by every volume in
      the balance: the farm's flows, its dam storage (today and yesterday) and
      the flows and storage of the nodes draining into it. The threshold is
      applied before E is summed, so Σ charges = D* still holds. Two scales
      that were tried and rejected: every upstream farm's flows, and the
      site's shortfall D. Both are too coarse and zeroed real impacts on fuzz
      networks. **0.19.2 (same day):** the 20 000-case soak showed 0.19.1's
      1e-12 of dam storage was still too coarse (it zeroed real ~1e-6 m³
      impacts beside a 10⁶ m³ dam; seeds 9051, 11240, 15426 failed
      `checkEwrAttribution`), so the storage and upstream terms now use
      `RESIDUE` = 1e-14 (~45 ulp), the size of the residues actually seen. Tests: `attribution.test.ts` › "a float residue at the scale
      of a dam or an upstream flow is not an impact", `run.invariants.test.ts`
      › "engine 0.19.1: …" pins the three seeds.
- [x] **Doubling crop areas raised supply by 0.0015–1.5 pp (seeds 4197,
      7686, 15979, 17277).** Fixed in engine 0.21.1 (2026-09-25); an engine
      bug, not hydrology, so `checkDoubledCropAreas` is unchanged. The
      earlier guess (rain on the dam, dead-storage threshold days) was the
      symptom: in all four the doubled run's dam was *fuller* than the base
      run's on some days. Ablation: every seed passes with dam evaporation
      off, with no dam surface, or with every b = 0.7; each had a dam with
      b > 1 (3, 2.34, 3, 3) and a mean depth of 0.5–32 mm. The daily step
      applies the start-of-day surface to the whole day, so for b > 1
      `Q[t−1] − E − Sp` falls as `Q[t−1]` rises once a day's evaporation
      exceeds 1/b of the dam: seed 15979's base dam (149 m³, b = 3, 1.6 mm
      deep when full) evaporated entirely while the doubled run's slightly
      lower one (144 m³, 10 % less surface) kept 3 m³, and over ~20 days the
      farm got more than twice the water (0.838 → 0.870). Rain on the dam had
      the right sign throughout (a lower dam caught less, until the
      inversion made it the fuller one). The real process, a dam evaporating
      as its surface shrinks, is order-preserving for any b, so this is the
      scheme's artefact. Fix: for b > 1, E ≤ (1 − seepage) × Q[t−1] / b
      (`network/simulate.ts` `damDay`, `verify/checks.ts`, the day-trace
      formula; model.md §2.7a, engine-audit.md N2); never binds for b ≤ 1.
      `persona-hydrologist` (simulated, 2026-09-25) agreed it is an artefact,
      rejected neutralising it in the check, called the cap defensible as a
      documented limiter (it understates evaporation on extremely shallow
      dams; the uncapped step overstated it), and recommended narrowing the
      range to b ≤ 1 (next item). Tests: `run.test.ts` › "engine 0.21.1:
      with b > 1 a fuller dam never ends the day with less water",
      `run.invariants.test.ts` › "engine 0.21.1: doubling crop areas …".
      The random-cases tests' failure cap is now `FUZZ_MAX_FAILURES`
      (default 3; model.md §6).
- [x] **Order invariance: a transfer source at its reserve (legacy seed
      14313).** Found by the 20 000-case soak (2026-09-25; the earlier soak
      stopped at seed 8984). The only rule into a farm drew from a dam sitting
      exactly at its reserve, so `free = Q_src[t−1] − reserve` came out as 0
      or as one ulp depending on node order, and attribution charged that
      residue to the receiving farm. **Fixed in engine 0.21.1:**
      `network/attribution.ts` sizes the noise by the dams at both ends of the
      day's transfers too, the same `RESIDUE` rule as 0.19.2. Pinned in
      `run.invariants.test.ts` beside the 0.19.1–0.19.2 seeds.
- [x] **Order invariance: Reserve rule tables (engine 0.24.1, 2026-09-25).**
      The first 20 000-case soak with rule tables in the fuzz generator
      failed on 18 seeds per model. Two tables for one site were resolved by
      list order (now neither is used, with a warning; the API already
      refused such a list), and a site's natural flow summed in display order
      moved the percentile across a flat stretch of the table's natural
      curve (now summed in node-id order, and a flow within 1e-12 of a curve
      point counts as reaching it). Seeds 3238, 6191, 17126, 18472 pinned in
      `run.invariants.test.ts`; the flat-curve case in `assurance.test.ts`.
- [x] **Order invariance: list-order float sums tipped thresholds (engine
      0.26.1, 2026-09-25).** The first 20 000-case soak generating other
      users, boreholes and land cover (engines 0.22–0.24) failed order
      invariance on 11 legacy and 16 GR4J seeds with real differences
      (outflow 7988 vs 8469 m³/day, a dam's area 73.6 vs 0, a user's EWR days
      not met 209 vs 210). One mechanism throughout: sums over lists in
      display order (the farms' flow shares and the catchment area Σ farm
      area, a farm's crops and crop areas, the senior users' claims and
      upstream share totals, land-cover patches, transfer rules, the EWR
      attribution's impacts) differed in their last bit when the lists were
      reordered, and a threshold turned the ulp into a result: a dam sitting
      exactly at its drought-borehole trigger (seed 3899: 481.22408531730883
      vs …088 m³, 116 938 m³ pumped in one order, none in the other), a dam
      running dry in one order and keeping a residue with a surface in the
      other (5703, 15208, 17002), the catchment area and so every natural
      flow (7094). None of the new elements had an order rule of its own
      that was wrong (users are served by position, boreholes are per node,
      patches add linearly); the noise predates them, they only added the
      thresholds that amplify it (and 14313 above was the same class).
      **Fixed at the source:** every sum feeding the balance runs in id
      order (`packages/engine/src/order.ts`; model.md §6 "The ordering
      rule"), and `checkOrderInvariance` now requires every daily series to
      be **bit-identical** in any display order, so a new list-order sum is
      caught even where no threshold amplifies it (the summary keeps its
      float tolerance). No documented result changed (engine-audit.md
      unchanged): only last bits and the tied threshold days move. Tests:
      `order.test.ts` (one case per sum, on values whose sum depends on the
      order), `run.invariants.test.ts` › "engine 0.26.1: …" pins the seeds
      of both models; `runoff/legacy.test.ts` now adds the area in id order.
- [ ] **Dam area exponent above 1.** Validation allows 0 < b ≤ 3
      (migration 006's check, `backend/src/model/validate.ts`,
      `frontend/src/lib/model/validate.ts`, `run.ts` `damLosses`,
      `verify/checks.ts`), but a single area–storage power law with b > 1 is
      not a real basin: any area–stage power law A ∝ hᵐ gives b = m/(m + 1)
      < 1, and published small-reservoir fits give b ≈ 0.65–0.85 (Liebe et
      al. 2005: 0.70). b > 1 happens only locally (a flat shelf at the top),
      which a power law can't represent anyway; that needs a stage–area–volume
      table. The persona hydrologist recommends narrowing to 0 < b ≤ 1: a new
      forward-only migration adding the tighter check `NOT VALID`, reporting
      or clamping rows above 1, then `VALIDATE`; the same bound in zod, the
      frontend, `damLosses` (warning) and the fuzz generator; the 0.21.1
      limiter stays for runs saved before. Deferred because it narrows what
      users may enter, so it is the real hydrologist's call. Trigger: the
      hydrologist review of N2 (engine-audit.md), or the first real dam
      entered with b > 1.
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

## Farmer view (WP-2.6, #25)

Left out of the first build because the contract or an API doesn't carry it
yet; each lands with the work package named.

- [ ] **"Next 14 days"** (ForecastCard) on the main and dam pages: needs
      `forecast` in `FarmView` (WP-2.12, design E2).
- [ ] **Afrikaans.** No language switch yet: nothing ships in Afrikaans
      before the named translator reviews it, and `FarmView` carries one
      `notice`, not `notice_en` / `notice_af` (design §7). Trigger: the
      translator is named.
- [ ] **"Who can see my farm" by name** (design §10.2): lists the roles and
      says the WUA can name them; needs an endpoint listing the people with
      access to a farm.
- [ ] **The WUA's name** in "Contact [WUA]" lines: not in `FarmView` or
      `FarmIndex`; the pages say "your WUA".
- [ ] **"Email me when …"** links (the notice / low-dam alert and "Email me
      when it's ready"): WP-2.13.
- [ ] **"Not available: the model's data starts on …"** needs the run's
      first date; `lastSeason` is null without it, so the page says the data
      doesn't reach back.
- [ ] **Account volume unit**: the ML/m³ switch is kept in `localStorage`
      until `app_user.volume_unit` (WP-2.5).
- [ ] **e2e on the full stack**: `e2e/tests/farm-view.spec.ts` needs the
      farm API and the seeded publication (the backend half of #25); run it
      once both are merged.

## UI

- [ ] **Thousands separator style:** the app uses commas (300,000). The
      original ask was spaces (300 000). Pick one app-wide.
- [x] **"Sign out everywhere" button** (2026-09-24): the header's account
      menu has *Sign out* and *Sign out everywhere*. The rest of WP-1.9
      (`/account` page, password change, `PATCH /auth/me`) is still open in
      the step-1 roadmap.
- [ ] **Exports carry unrounded values** now that the engine doesn't round.
      Decide on export number formatting.
- [x] **FarmDay help diagram is behind the engine** (fixed 2026-09-25):
      `components/help/diagrams/FarmDay.svelte` now draws rain on the dam,
      open-water evaporation and seepage to the river below the wall, and its
      `aria-label` says so.

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

- [x] **Read-only team role** (2026-09-24): team `viewer` → project
      `viewer` (migration 008). `app_project_role()` maps each team role
      explicitly (unknown grants nothing); creating or moving a project
      into a team needs team member or admin; a viewer's copy is personal
      (data-model.md § Teams, ui.md § Teams).
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

- [ ] **The Sandspruit example fails `catchments.test.ts` on main** (seen
      2026-09-25 on origin/main at 9590fa1, before the scenario merge): engine
      0.28.0's forecast-rain warning (3ae50b9) fires on the example's last 10
      days (2025-01-01 … 2025-01-10), which the test's expected-warnings list
      doesn't include. Either the example's rain source for those days is
      wrong, or the list needs the new warning with a reason. Owner: the
      forecast-rain change.


- **Reproducible inputs and cited runs** (roadmap WP-3.1, prerequisite of
  scenarios #18, 2026-09-25; [data-model.md § Stored run inputs](./data-model.md#stored-run-inputs-021_series_blobsql)).
  Built: engine `canonicalJson` / `seriesDigest`, `021_series_blob.sql`
  (`series_blob`, `run_input_series`, the GC trigger, `model_run_cited`),
  `executeRun` storing inputs, `loadRunInput` (byte-identical round trip on
  the three examples), the run-input route for uncertainty bands using it.
  Left open:
  - [x] **Scenarios add the first "cited" clause** (WP-3.2, 024_scenarios,
        2026-09-25): `model_run_cited` is `EXISTS (SELECT 1 FROM scenario s
        WHERE s.base_run_id = p_run)`, with a `NO ACTION` key (checked at the
        end of the statement, so a project delete still cascades); the unpin
        and delete routes answer `409 this run is cited by scenario "…"`;
        cited runs don't count against `PINNED_RUNS_PER_PROJECT_MAX`.
  - [ ] **`GET …/runs/:runId/reproduce`** (`{ identical, engineVersionThen,
        engineVersionNow, differences }`), `RunMeta.reproducible`, and the
        Runs tab's "Reproducible" badge, "Cited" lock and "Check
        reproduction" action. (`RunMeta.citedBy` is built, WP-3.2.) `loadRunInput` + `runModelChecked` +
        canonical JSON is the whole server side; the route and UI are what
        remain. Trigger: WP-3.2's compare view, or an assessor asking.
  - [x] **WP-2.3's publication-history trim skips cited runs' publications**
        (024_scenarios, 2026-09-25): `run_publication_cap` keeps, beyond the
        newest 12, every publication whose run a scenario is based on, so
        the base keeps its "published" record. (A publication is itself a
        citation since 022, so "cited" here means cited by something else;
        evidence packs and assessments add their clause the same way.)

- **Scenarios** (issue #18, WP-3.2, 2026-09-25;
  [scenarios.md](./scenarios.md)). Built: the engine part,
  `packages/engine/src/scenario/` (`applyScenario`, `classifyOp`,
  `classifyScenario`, `validateScenarioOps`), with the invariant and
  no-silent-change fuzz; the backend, data model and API
  (`024_scenarios.sql`, `backend/src/scenarios/`, `executeScenarioRun`,
  rebase, the scenario per side in compare) and the frontend API client
  (`api.scenarios`). Left open:
  - [ ] **The Scenarios tab** (stage D): the list and its empty state, the
        override-mode editor that records edits as ops with undo, the
        "Based on run X" banner and the red "Baseline assumptions changed"
        callout, the compare page's Scenario overrides section (reusing the
        #8 overlay), the Runs tab's cited lock, e2e (a 20 % dam raise run and
        compared) and axe. Everything it needs is in `api.scenarios` and
        `CompareSide.scenario`.
  - [x] **One home for the model's save rules** (2026-09-25): the rules are
        the engine's `modelRuleIssues` (`packages/engine/src/modelRules.ts`);
        `scenario/structure.ts` and `modelProblems` both call it, and a fuzz
        test checks a scenario applied to a valid model always passes them.
  - [ ] **Later ops**: `ewrSite.set`, `allocation.set`, moving a node or
        inserting one mid-river, `crop.set`, `landCover.set`
        ([scenarios.md § Not yet supported](./scenarios.md#not-yet-supported)).
        Trigger: the scenario editor needing them.

- **Printable catchment report** (issue #19, WP-2.15 Phase A, 2026-09-25;
  [ui.md § Report](./ui.md#report)). Built: the print route
  `/projects/:id/report?run=`, the Runs tab's **Report** button, A4 print
  CSS, charts at 2 device pixels per CSS pixel, the `data-report-ready`
  signal, e2e (`e2e/tests/report.spec.ts`) including `page.pdf()`. Left open:
  - [ ] **Phase B, server-side PDFs** (a `report_render` job in headless
        Chromium, S3 / MinIO, a single-use render token). Trigger: decision
        D9, when someone asks for emailed or scheduled reports. The job queue
        (WP-2.8) is in place; the route and `data-report-ready` are what it
        would open and wait on.
  - [ ] **Sections waiting on other work**, added to `report/sections.ts`
        when their data exists (no placeholders until then): the cover's
        published-by line and restriction notice (WP-2.3), changes since the
        previous publication (WP-2.4), the disclaimer (D10, text still to be
        agreed), and the licensing evidence pack's sections and uncertainty
        display (#15). WP-2.3 also adds the Overview published card's Report
        entry point.
  - [ ] **Firefox print check.** The acceptance asks for a clean A4 PDF from
        Chromium and Firefox; e2e runs Chromium only, so print the largest
        example from Firefox by hand before calling Phase A accepted.
  - [ ] **Farmer access test** (a farmer gets 403): waits for WP-2.1's farmer
        role. Today the test is a non-member, with a viewer as the positive
        control.

- **Data feeds** (issue #10 part 2, WP-2.10, 2026-09-25;
  [architecture.md § Data feeds](./architecture.md#data-feeds)). Built:
  CHIRPS, CHIRPS-GEFS and DWS parsers on synthetic fixtures, `018_feeds`,
  the jobs, the routes, Settings → Data feeds, the fetcher Lambda and its
  queues (plan only). Left open:
  - [ ] **DWS is unverified against the live site.** It answers HTTP 403 to
        our (non-South-African) network, so the parser follows the request two
        open-source clients make (RivRetrieve-Python, aquascope) and the
        layout of an archived daily page (web.archive.org, 2024: the header
        is `D AVG F/R`, not the clients' `D_AVG_FR`). Trigger: the first
        deploy. From the fetcher's region, attach a DWS feed to a throwaway project and check it goes OK; if the
        page differs, the feed fails loudly (nothing is written) and
        `sources/dws.ts` plus its fixture change together. Codes that say
        the data is missing (151, 165, 170, 172, 246, 247, 255) become gaps;
        the rest are counted: agree with the hydrologist whether flagged flows
        (60 above rating, 150 extrapolated, 173 unreliable…) should be kept.
        Only H (river gauge) codes are accepted, sent as `SiteType=RIV`
        (#35). Also check a gauge that belongs to a dam: archived pages ask
        for some H stations (a dam's canals and downstream river gauge, e.g.
        those listed under a reservoir's HyDataSets page) with
        `SiteType=DC`; if RIV fails for one, derive DC from the catalogue
        rather than the code letter, which can't tell them apart.
  - [ ] **Terms of use (operator decision, roadmap D7):** DWS's terms for
        automated retrieval, and CHIRPS-GEFS's licence (CHIRPS itself is
        public domain). Decide before a DWS or GEFS feed is used for a client.
  - [ ] **CHIRPS scale factor** (hydrologist, D7): a feed writes CHIRPS as
        published into `rain_chirps_mm`; the existing CHIRPS bias correction
        (Settings → Rain gaps) applies at run time, as for an uploaded series.
  - [ ] Marking a fed series on the Data tab ("from CHIRPS feed"), and an
        audit event per merge (needs WP-2.4's `audit_event`).
  - [ ] A debounced re-run after new data (WP-2.11) and emailing owners about
        a stale or failing feed (WP-2.13): today the panel and the CloudWatch
        alarms are how anyone hears.
  - [ ] CHIRPS by bounding box (the roadmap's `{ bbox }`): cells only now.
  - [ ] **Request volume grows with feeds.** Each CHIRPS feed re-reads its
        last 50 days daily (~200 range requests). Trigger: more than ~20
        CHIRPS feeds in production. Durable fix: fetch each (day, grid row)
        once per tick and share it between feeds, or keep a per-day
        preliminary/final marker so final days aren't re-read.
  - [ ] **Ingest doesn't check a result's dates against the window asked
        for.** A result off the `ingest-results` queue is validated for shape
        and size, but its `startDate` can be any day, so a compromised
        fetcher could write days far outside the fetch (still only into the
        series that feed targets, as security.md accepts). Durable fix: put
        the window in the `feed_fetch` job's payload (jobs/handlers, owned by
        the jobs branches today) and have `ingestResult` refuse days outside
        it. Trigger: before the first production deploy of the fetcher.
        Related: "Run now" is deduped per feed but not rate-limited, and an
        hourly schedule re-reads CHIRPS (published daily) 24 times a day; cap
        both when the request volume item above is done.

- **Run comparison** (the per-node daily series overlay is built, issue #8,
  [run-comparison.md](./run-comparison.md)):
  - copies that remember their source nodes (renamed farms in a copy don't
    match);
  - a value change is not isolated when the dates also changed;
  - default side A to the newest pinned run (roadmap WP-1.11): the pickers
    already mark pinned runs (015_run_pinned), but `compare/picker.ts`
    `defaultPair` still takes the previous run.
- **Export:**
  - ~~`.xlsx` output~~ **landed (WP-1.28, 2026-09-25)**: the run workbook,
    built in the browser from the bulk series route (api.md § Export). Left
    open:
    - [x] **Opened in Excel** (2026-09-25). Three synthetic workbooks from
      `buildWorkbook` (the unit test's input with the awkward names
      `=Upper farm`, `Summary`, and a long one with `[ ] : / * ?`; a 3-year,
      2-farm run; a 20-year, 8-farm run, 19 MB) were opened in Excel 16.113
      for Mac by the operator, who saw no repair prompt. The same files pass
      Python's `zipfile.testzip()` and open in openpyxl 3.1.5 with no
      warnings; every tab keeps its unit headers, real dates, full-precision
      values and `#,##0.00` display formats. Not scripted (macOS blocks the
      terminal from driving Excel), so a real client-size run (~41 MB) and
      LibreOffice (not installed) are unchecked; worth one more look at the
      first client handover.
    - [x] **Smaller files** (2026-09-25): the workbook is zipped with the
      platform's `CompressionStream('deflate-raw')` (`zip.ts`) instead of
      SheetJS's fixed-Huffman deflate; a ~45-year, 13-node run 100.8 →
      41.2 MB, built in ~4.6 s. A unit test caps a synthetic 10-year run's
      size and reads every cell back.
    - No frozen header row or live formulas (SheetJS CE doesn't write panes;
      the formula audit workbook is the separate item in § Verification).
  - a path for exports over 5 MB (Lambda streaming or an S3 pre-signed URL,
    plus a local MinIO equivalent). **Now a real limit, not a hypothetical
    one** (measured 2026-09-25 for WP-1.28): a farm's daily CSV has ~32
    full-precision columns, ≈ 400 KB a year, so a record longer than about
    30 years gets the `413` (a ~45-year farm is ≈ 6.5 MB). The
    workaround today is a `from`/`to` window or the `.xlsx` workbook, whose
    bulk fetch pages under the cap. Durable fix: WP-1.29 option (a), Lambda
    response streaming with a 50 MB cap (roadmap step 1). Trigger: before the
    first production release that the client catchment will be exported from.
- **Accounts:**
  - Should sign-in require a verified email?
  - Should sign-up be invite-only, or email-first? Email-first closes the last
    account-squatting gap.
  - Is a 5-attempt, 1–15 min lockout acceptable, given anyone can lock another
    person's address that way?
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
- **Workbook import in the browser (WP-1.31).** Left open:
  - [x] **Peak memory on the largest workbooks** (2026-09-25).
        `readWorkbook` first unpacked only the parts it reads
        (`lib/spreadsheet/import/zip.ts`: the client workbook's peak about
        40% down, read 2.9 s → 1.1 s), then stopped using SheetJS altogether:
        a streaming OOXML reader (`xml.ts` tokenizer, `workbookParts.ts`,
        `sheet.ts`, `sharedStrings.ts`) parses each part as it inflates and
        keeps each cell as typed-array slots, so the ~40 MB [Flow data] XML is
        never held as a string or turned into an object per cell. Measured in
        Node (vitest fork, SheetJS on its browser code paths for the before;
        median of 3; the harness is a throwaway test that times
        `readWorkbook` + `extractProject` and reads `process.resourceUsage()`):
        client workbook peak RSS ~815 → ~330 MB, of which ~270 MB is the
        harness holding the 87 MB file twice, so the read's own share ~550 →
        ~60 MB; `readWorkbook` ~1.3 s → ~0.65 s. Synthetic fixture: peak
        129 → 114 MB (harness ~95 MB), read ~50 → ~25 ms. Parity: the
        fixture and local source-workbook tests give identical output, and a
        new cell-by-cell comparison with the SheetJS reader
        (`readerParity.test.ts`, and on the client workbooks in
        `sourceWorkbooks.test.ts`) finds no difference. The import worker
        101 → 25 KB gzip (the bundle guard's spreadsheet-worker ceiling
        107 → 95 KB, now the export worker's).
  - [ ] **Strings SheetJS and openpyxl decode differently** (issue #22). The reader keeps
        SheetJS's string decoding, so the import reads what it read before.
        Two cases differ from openpyxl, and so from the Python importer the
        port must match: Excel's `_xHHHH_` escapes (SheetJS turns
        `_x000D_` into a carriage return, openpyxl leaves the text as
        written) and a formula's cached text (`t="str"`, which SheetJS
        entity-decodes twice: `a&amp;amp;b` reads `a&b`, openpyxl `a&amp;b`).
        Checked with a hand-made workbook through openpyxl 3.1 in read-only
        mode. Neither occurs in a cell the importer reads in the workbooks
        seen so far (the parity tests are green). Durable fix: decode as
        openpyxl does in `sheet.ts` and `sharedStrings.ts` (one decode, no
        `_xHHHH_` handling), with a Python-parity fixture for each case.
        Trigger: a workbook whose names or labels carry either (a line break
        typed as CR+LF in a header, a formula-built farm name with an `&`).
  - [x] **The notes and unmapped report are kept** (2026-09-25). The import
        dialog sends them beside the document (`importReport` on
        `POST /projects/import`, capped by zod) and they are stored in the
        import's transaction in their own append-only table, one row per
        import, rather than a `project` jsonb column (migration 017
        `project_import`; data-model.md § Import reports). Viewers read them
        through `GET /projects/:id/import-report` and on the Overview's
        Import record, both lists collapsed at first; not dismissible, since
        it is the audit trail. Not in `export.json` (api.md § Import report).
  - [x] **Measured in a real browser** (issue #23, 2026-09-26). The client
        workbook (~87 MB `.xlsm`) imported through the real worker code in
        desktop Chrome 154, Safari 26.6, iOS Safari (iPhone 17e simulator,
        iOS 26.4) and Android Chrome 145 (Pixel 10 Pro emulator, 3 GB). A
        throwaway harness (not committed) timed `parse()` from File to result
        and sampled the tab's process memory (macOS RSS; Android RSS + swap,
        since the emulator swaps to zram) from just before the pick to the
        result; median of 3, growth over the tab's baseline:

        | Browser | Before: growth / peak | After: growth / peak | Time before → after |
        | --- | --- | --- | --- |
        | Chrome (desktop) | ~180 / ~310 MB | ~100 / ~230 MB | 0.68 → 0.68 s |
        | Safari (desktop) | ~605 / ~670 MB | ~140 / ~200 MB | 0.68 → 0.70 s |
        | iOS Safari (simulator) | ~450 / ~630 MB | ~125 / ~310 MB | 0.73 → 0.76 s |
        | Android Chrome (emulator) | ~170 / ~385 MB | ~70 / ~285 MB | 0.99 → 0.82 s |

        Two causes, both fixed at the source in `zip.ts`. (1) WebKit's
        `DecompressionStream` inflates each input chunk into one output
        chunk, so the 6 MB compressed [Flow data] handed over whole came out
        as a single 38 MB chunk; compressed bytes now go in 64 KB slices,
        pulled on demand. (2) The worker loaded the whole File as an
        `ArrayBuffer` (~87 MB) for the whole read; the zip reader now reads
        the File itself with `Blob.slice`: the end record and directory,
        then each needed entry 64 KB at a time. Safari's drop is larger than
        the ~125 MB of buffers removed; why WebKit held the rest isn't pinned
        down (it also shrank with the big buffers gone). Guarded by
        `zip.test.ts` (a spy Blob: reading one part of a 3 MB archive reads
        < 100 KB of it, and the inflater never gets a slice over 64 KB).
        Pick to review screen in the real app (Playwright, disk-backed file,
        after): Chromium ~0.83 s, WebKit ~1.34 s. The result sent back to the
        page is ~0.4 MB as JSON, so the copy between worker and page doesn't
        matter. **Not done: a real phone.** None was connected; simulators
        and emulators don't enforce a phone's per-tab memory limit. At a
        ~125 MB peak growth the import should fit comfortably, but the first
        client import from a phone, or any report of a failing import, is
        the trigger to confirm on a device (the harness notes in issue #23).

- **Publication** (roadmap WP-2.3 phase 1, 2026-09-25; [data-model.md §
  Publications](./data-model.md#publications-022_publicationsql),
  [api.md § Publication](./api.md#publication)). Built: `022_publication`,
  `farmProjection` / `catchmentView` in the engine, the publication routes,
  the farm-view API routes of WP-2.6 (index, view, CSV), publishing from the
  Runs tab, the seeded publications. Left open:
  - [x] **Share links** (WP-2.3 phase 2, 2026-09-25): `025_share_links`
        (`share_link`, `app_share_view`, `app_share_series`), the owner
        routes and the public `POST /share/view` / `/share/series`, the
        `/share` page and the Overview's Share links panel
        ([api.md § Share](./api.md#share),
        [security.md § Share links](./security.md#share-links)). The flow
        series answer only at `FARMER_K` farm holders (design §10.3), which
        is stricter than the roadmap's D2 note "always show outflow".
  - [ ] **Audit events for share links** (`share_link.created` /
        `share_link.revoked`): today the row records `created_by` /
        `created_at` and `revoked_by` / `revoked_at`, and a link is never
        deleted so that record stays. Needs WP-2.4's `audit_event` (issue
        #28); add the two writes to `backend/src/share/routes.ts` in the
        same change, and then decide whether revoked links may be purged.
  - [ ] **Audit events** for publishing and for notice changes: today only
        `published_by` and `updated_at` / `updated_by` record them. Needs
        WP-2.4's `audit_event`; add the writes in the same change.
  - [x] **Roadmap UI around it** (2026-09-25): the Overview's "Published
        baseline" card (read-only; editors link to the Runs tab's notice
        editor), viewers opening the Runs tab on the published run, "compare
        with published" (the compare page's default and offer, and the Runs
        header link), and `publishedAt` on `GET /projects` for every member
        ([ui.md § Overview](./ui.md#overview), [run-comparison.md](./run-comparison.md)).
  - [ ] **The binding EWR site is recomputed, not stored.** A run doesn't
        store which site bound a farm's charge each day, so the projection
        re-runs the engine's attribution on the stored flows. Exact, except
        when the transfer rules form a loop (per-rule volumes can't be solved
        from the farms' net transfer series; the loop is cut and
        `bindingApproximate` says so). Durable fix: store the per-rule
        transfer volumes (or the per-day binding site) as run series. Trigger:
        the next change that bumps `ENGINE_VERSION`.
  - [ ] **The chart series and per-farm history routes** of WP-2.6
        (`…/farm/:nodeId/series`, `…/history`): with the farm page.

## Pipelines

- Releases are `web@X.Y.Z` / `backend@X.Y.Z` GitHub releases, run through a
  preflight → build → `production` approval → deploy pipeline
  ([deployment.md §4](./deployment.md)).
- [x] Dependabot's `pip` entry watched the repo root, which has no Python
      manifest; since 2026-09-25 it watches `brand/` and `scripts/wbt-import/`
      (the openpyxl pin the importer CI job installs).
- [ ] Optional:
      - a read-only Terraform plan role, for a real `terraform plan` in CI;
      - a CodeQL Python leg for `scripts/wbt-import`.

## Server-side reports (WP-2.15 Phase B, issue #26)

- [ ] **The renderer image has never been built or run on Lambda.** CI and
      the gates cover the render path with the local Chromium (the worker's
      inline renderer, MinIO, Mailpit, e2e) and the renderer Lambda's
      message handling with stubs; `backend/renderer.Dockerfile` (Playwright
      image + `aws-lambda-ric`) is first built by the first
      `backend@` release. Before relying on it: build it once locally
      (`docker build -f backend/renderer.Dockerfile backend` after
      `infra/scripts/package-lambdas.sh`) and invoke it with the Lambda
      runtime interface emulator against a local stack; then after the first
      deploy, render one report in production and check its alarms.
- [x] **The DB test files ran in parallel**, although
      `backend/vitest.workspace.ts` sets `fileParallelism: false` for the
      `db` project and several tests say "a tick here sees only this file's
      jobs": Vitest 2 ignores that option inside a workspace project
      (checked 2026-09-25 with two sleeping test files). One file's tick then
      claimed another's jobs, and with the report tests' queued renders in
      the mix the job and feed tests failed intermittently. Fixed at the
      root on main (b92608e): the `db` project pins one fork
      (`poolOptions.forks.singleFork`), which does serialise the files. The
      report branch's duplicate `--no-file-parallelism` flag was dropped at
      merge. Making every tick-based test hermetic would let the files run in
      parallel again.
- [ ] **MinIO's upstream image is gone** (the `minio/minio` Docker Hub
      repository answers "pull access denied"; MinIO stopped publishing
      community images in 2025). docker-compose pins the community fork's
      build (`pgsty/minio:RELEASE.2026-08-04T00-00-00Z`, github.com/pgsty/minio,
      ~800k pulls). Re-check it on each bump; the alternative is any other
      S3-compatible local server, since the app only uses the S3 API.
- [ ] **playwright-core is pinned in two places**: `backend/package.json`
      (the worker's renderer) and `e2e/package.json` (`@playwright/test`),
      plus the image tag in `backend/renderer.Dockerfile`. They must move
      together (the Chromium build is tied to the version); Dependabot bumps
      them separately.

## Housekeeping

- `SECURITY DEFINER` grants (issue #37, 027_definer_grants): the catalogue
  guard now fails any `SECURITY DEFINER` function executable by a role other
  than the owner and `water_app`. The in-flight `025_share_links.sql` branch
  may add such functions; when it merges, run `pnpm test:backend:db` and make
  sure its functions revoke `PUBLIC` (the owner's default privileges already
  close them if 027 has applied first, but a database migrated in file order
  applies 025 before 027's default-privilege change, so 025 needs its own
  `REVOKE`).

- During early development, work is pushed straight to `main`, without PRs, at
  the operator's request.
- Demo data: `pnpm dev:db:reset && pnpm seed:demo` rebuilds the dev database.
  It holds three invented catchments, a demo team, two demo users, and client
  catchment if the workbook is present.
- The domain personas (`/persona hydrologist,environmentalist,…`) are ready to
  run against the merged app. See `.claude/personas/README.md`.
