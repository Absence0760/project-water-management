# Engine soundness audit (2026-09, engine 0.4.0)

[engine-review.md](./engine-review.md) checked that `packages/engine` is
**faithful** to the b023 workbook. This audit asks a different question: is each
algorithm **physically and hydrologically sound**? The operator's decision is
to **replace outright** any workbook algorithm that is wrong. The engine no
longer has to reproduce the workbook, and there is no "workbook-compatible"
mode. Every run records `engineVersion`, so results from 0.3.x stay explainable.

- **Scope:** `flow.ts`, `demand.ts`, `calendar.ts`, `network/*` (shares,
  simulate, curtailment, ewr, stats, topology), `run.ts`, and the importer's
  month-list parsing. Out of scope: `quality.ts`, `compare.ts` and the
  multiple-outlet check. (`flow.ts`, the legacy runoff model, was removed in
  engine 1.0.0 with H1, issue #16; its findings E1, E2 and W4 went with it.)
- **Method:** each finding has a failing test first, then the fix. Decisions
  that need hydrological or policy judgement are marked **Needs hydrologist**,
  with a recommendation, and the engine's behaviour for them is unchanged.
- **Known limitations** (WP-3.13): every item below whose decision is still
  open (*pending*, *Needs hydrologist*, *Warned*, *Built*) is printed on
  every report's validation statement and sign-off. The list is generated
  from the two tables; after changing a decision run `pnpm gen:liability`
  (`packages/engine/src/liability/limitations.test.ts` fails until you do).
- **Policy** (CLAUDE.md rule 10, [STACK.md](./STACK.md)): engine correctness is
  judged by documented hydrology and the invariant tests. The client catchment
  regression suite records where results differ from the workbook, and why
  ([§ Regression suite](#regression-suite-deviation-list)).

## Findings

Severity is the effect on results a user would act on. File:line refers to
engine 0.4.0.

| ID | Severity | Where | Finding | Evidence | Decision |
| --- | --- | --- | --- | --- | --- |
| **E1** | Medium | `flow.ts:207-215` | **Day 1 of every run recedes at an extrapolated factor.** The workbook's reserved row fills in only the base flow and leaves its recession index blank (0). Day 1 therefore recedes at `2·f1 − f2`, far below either factor on a typical curve, so most of the initial base flow vanishes on the first day. When `f2 > 2·f1` the factor is negative, the base flow goes below zero, and it **stays negative for the whole run**, because `rain / negative base` is never above the 1.5 reset ratio. The blank pulse index also made a first-day storm take the base index. | `flow.test.ts` › "day-1 state (audit E1)" (3 tests) | **Fixed.** The day before the run is a steady base-flow state: base = resultant = `BaseFlowInitial`, and every index is that flow's own position on the curve. A master recession curve describes recession as a function of the current flow alone ([Tallaksen 1995]; [Lamb & Beven 1997]), so the steady state is that flow's own index. Removed with the legacy model in engine 1.0.0 (issue #16). |
| **E2** | Low | `flow.ts:91` | A pulse index below 1 (`ShiftPeakIndexLo` = 0.9) extrapolates below the first factor. With a steep table head this can be negative, which would make the flow negative. | `flow.test.ts` › "recede (audit E2)" | **Fixed.** The factor is clamped at 0. A recession can shrink a flow to nothing, never below. This changes nothing where the factor is ≥ 0, which covers a table whose head is not steep. Removed with the legacy model in engine 1.0.0 (issue #16). |
| **R1** | Medium | throughout; decision on engine review **F5** | **Rounding does not belong in the model state.** The workbook rounds almost every column, and it matters in three ways. (a) A receding flow stops once `flow × (1 − f) < 0.5`, so every recession stops at a floor of about `0.5 / (1 − f)` for the curve's tail factor `f`, however long the drought lasts. That is exactly the low-flow regime the EWR is about. (b) Splitting a flow creates or destroys water: with 4 equal farms, a natural flow of 2 m³/day gives 4 m³/day of runoff (`ROUND(0.5)` = 1 each), and 1 m³/day gives 0. (c) Small quantities vanish: a 0.4 m³ dam became "no dam", and rounding a fractional inflow split drove supply negative (found earlier by the fuzz tests). There were also two different `excelRound` implementations (F5). | `run.test.ts` › "no rounding in the balance (audit R1)" (`flow.test.ts` › "no rounding in the model state" went with the legacy model in engine 1.0.0) | **Fixed.** The engine keeps full float64 precision everywhere: rain flow (no `INT`), recession and indices, demand chain, fragments, dam splits, return flow, capacity, initial storage, transfer cap, the observed-flow conversion, and every `[Shortfalls]` column (no `ROUND` / `ROUNDDOWN`; closes Q14 and Q15). Presentation (UI, exports) rounds for display. One Excel `ROUND` remains in `network/round.ts` (the 15-significant-digit version), used only by tests that replay workbook cells. In curtailment, float cancellation noise below 1e-12 relative is reported as 0, so a farm already at its equitable share doesn't show a gain of 1e-16 m³/day. |
| **G1** | Medium (networks with a confluence gauge) | `network/simulate.ts:147` | **A gauge's shortfall was the sum of its branches' shortfalls.** The gauge sheet sets `I = Σ upstream AA`. When one branch is 100 m³/day short and another has 100 spare, the confluence's flow meets its EWR, but the gauge reported −100, and a farm below it read that value into its own incremental shortfall. | `run.test.ts` › "EWR at a confluence gauge (audit G1)" | **Fixed.** A gauge's shortfall is `MIN(ΣU − ΣZ, 0)`, which is the same definition as a farm's AA and as the outlet series. A gauge with one upstream element is unchanged. How farm shortfalls are *attributed* is Q17 (decided, engine 0.17.0). |
| **C1** | Medium (when calibrating to Pitman) | `run.ts:315` | **Pitman flow was scored against the impacted outflow.** Pitman flow is *naturalised*: modelled flow with no farms, dams or abstraction ([WR2012]). Comparing it with the simulated **outflow**, after irrigation and dam storage, scores the rain model against a record of a different quantity. | `run.test.ts` › "scores natural flow … against naturalised Pitman flow (audit C1)" (removed with P1) | **Fixed.** Pitman is compared with `natural_flow`. Gauge and logger records measure the impacted river and are still compared with `simulated_outflow`. `CalibrationStats.simulatedKey` says which series was scored. **Superseded by P1 (engine 0.10.0):** Pitman is no longer a calibration record, so every record is scored against `simulated_outflow`. |
| **H1** | **High** (structural) | `flow.ts:230-231` (reset), recession curve (removed in engine 1.0.0) | **The rain model does not conserve water at the event scale.** When a storm's peak is above 1.5 × the receded base flow, the base flow resets to the peak and then recedes along the *slow* part of the curve. A single 10 mm winter storm on a dry catchment can then return **several times** its rain volume over the following year with typical parameters, more on a larger catchment. Small storms return relatively *more* than large ones (a 100 mm storm returns less than its rain), which is the opposite of how catchments behave: runoff coefficients rise with storm depth and antecedent wetness ([Beven 2012]). Calibrated annual totals can still look plausible (the example catchments' run coefficients are 0.34–0.68), but only because the parameters compensate. | The probe numbers above; until engine 1.0.0 `run.test.ts` › "W1" (the 10 mm storm, coefficient > 1) and "H1: every legacy run carries LEGACY_NOT_EVIDENCE"; now `runoff/event-scale.test.ts` › every model in `RUNOFF_MODELS` passes `checkEventScale`, with no exemption | **Removed in engine 1.0.0 (issue #16, 2026-09-26): GR4J is the only runoff model.** The legacy model (`flow.ts`, `runoff/legacy.ts`), its calibration keys and its fit bounds are gone; migration 064 moved stored projects to GR4J. A stored legacy run stays readable, badged "Workbook comparison", never re-run, and can't be nominated as evidence, signed off or published. The operator waived the planned trigger (the hydrologist seeing the GR4J results with the Phase 9 bands first). History: the recommended durable fix was a bounded event volume (runoff = C(R, wetness) × R × area, C ≤ 1) routed through a unit hydrograph or linear stores, with baseflow fed by a recharge fraction; candidates were IHACRES ([Jakeman & Hornberger 1993]), GR4J ([Perrin et al. 2003]) or the bucket module (model.md §5). A W1 guard (runoff coefficient > 1) shipped first. GR4J became selectable in engine 0.5.0 ([issue #4](https://github.com/Absence0760/project-water-management/issues/4), model.md §2.4a) and passes the event-scale invariant (`testing/runoff.ts` `checkEventScale`); it became the default in 0.11.0. On 2026-09-24 (persona recommendation) legacy was kept unchanged as a workbook comparison only, every legacy run carrying `LEGACY_NOT_EVIDENCE`; on 2026-09-25 GR4J was decided as the model on record (issue #4 closed, the hydrologist's sign-off assumed by the operator). The last end-to-end comparison of legacy natural flow with the workbook (engine 0.45.0) passed and is recorded in `run.test.ts`. |
| **N1** | Medium | `demand.ts:55-56`, `simulate.ts:166-172` | **Irrigation efficiency and return flow don't add up.** Demand F is crop water use (A-pan × crop factor − effective rain). Supply G meets F, and `returnFlowPct × G` flows back the same day. So a fully "supplied" crop consumes only `(1 − r)·F`: with r = 10 % it is 10 % short of its requirement while the model reports 100 % supplied. In the usual formulation, abstraction = net requirement / application efficiency, and part of the losses returns ([Allen et al. 1998]; [Keller & Bliesner 1990]). | Worked example: F = 100, r = 0.1 → G = 100, T = 10, crop use = 90. `run.test.ts` › "irrigation efficiency and loss return (audit N1)" (F = 100, e = 0.9 → G ≈ 111.1, crop use 100; β share of losses; deficit and fraction against D; e = 1, β = 0 bit for bit; a legacy model runs as migrated) | **Decided (persona recommendation, 2026-09-24; pending the hydrologist) — engine 0.16.0.** Per farm `irrigationEfficiency` e (0 < e ≤ 1) and `lossReturnFraction` β (0–1). Per day: `D = F / e`; `G = MIN(available, D)`; crop use `e·G`; return `T = β(1 − e)·G` to the river the same day (replacing `returnFlowPct × G`); consumptive use `G − T`; supplied fraction `G / D`; deficit `W = D − G`; curtailment works in D and G. F and D are both run series (`crop_requirement`, `demand`). The balance V = (H + I + J) − (G − T) − ΔQ − U keeps its form. Migration 006 backfilled from r = `return_flow_pct` (r = 0 → e = 1, β = 0, bit-identical; r > 0 → e = 1 − r, β = 1: the crop is now fully supplied and abstraction rises by 1/(1 − r); r = 1 → e = 0.01) and **dropped `return_flow_pct`** (never deployed); `upgradeLegacyModel` maps older documents and run snapshots the same way. New farms default to e = 0.90 (drip, confirmed by the client 2026-09-28, issue #90; e = 0.80 before), β = 0.5; the one-node form's system helper and the Load crop factors dialog share one table, `IRRIGATION_SYSTEMS` (SABI 2021 Table 4: drip 0.90, micro 0.82, pivot 0.85, permanent sprinkler 0.80, movable sprinkler 0.75, surface 0.70). Only a new farm takes the default; the run never reads it, so no engine version change. The "upstream farm helps a starved neighbour via return flow" effect is real under N1 (bounded by G ≤ D); attribution by net consumptive use handles it (Q17, separate task). Engine 0.43.0 (issue #54): a crop may carry its own e, overriding the farm's for that crop; the farm runs on its crops' efficiencies combined by the requirement-weighted harmonic mean, which keeps D = Σ F_c / e_c and the losses exact, one e per farm ([model.md §2.3](./model.md#23-irrigation-demand) step 6). |
| **N2** | High (dam-dominated farms) | `simulate.ts:165-169` | **Dam evaporation and seepage are ignored.** A farm dam loses open-water evaporation, about 0.7–0.8 × Class-A pan ([Linsley et al. 1982]; WR90 gives monthly lake factors), which is 5–8 mm/day in a hot, dry summer. A 100 000 m³ dam with about 3 ha of surface loses roughly 150–240 m³/day, several % of its capacity per month, exactly when irrigation draws on it. The model overstates summer storage and supply. | Order-of-magnitude example above. `run.test.ts` › "dam evaporation and seepage (audit N2)" (100 000 m³, 3 ha, 6 mm/day = 180 m³/day; area follows storage; rain on the dam before the threshold; seepage joins the outflow; never below empty; the capacity ÷ 3 m estimate and W6; no dam unaffected); `run.invariants.test.ts` › "catches dam evaporation, rain on the dam or seepage that does not follow the dam"; on the client catchment "N2: with the estimated dam areas every self-check passes" | **Decided (persona recommendation, 2026-09-24; pending the hydrologist) — engine 0.16.0.** Per dam per day, before irrigation (after the day's transfers): surface `A = A_full·(Q[t−1]/cap)^b`, `b` = `damAreaExponent` (default 0.7, [Liebe et al. 2005]); evaporation `E = k_lake·Apan[month]/daysInMonth/1000·A` with `settings.lakeEvapFactor` k_lake (default **0.75**, an A-pan factor; the WR90/WR2012 lake factors are S-pan based and must not be applied to A-pan directly); rain on the dam `Pd = rain·A/1000` (the day's rain before any threshold); seepage `Sp = damSeepagePerDay·Q[t−1]` (default 0), which joins the farm's outflow U the same day. Clamped so storage stays ≥ 0 (E ≤ Q[t−1] + Pd + J, Sp ≤ what is left). New node fields `dam_area_full_m2` (nullable), `dam_area_exponent` (0.7), `dam_seepage_per_day` (0) in migration 006. An unknown area is estimated as capacity ÷ 3 m ([Mantel & Hughes 2023], median mean depth of SA minor dams) and the run warns (**W6**) naming how many dams used it. New series `dam_area`, `rain_on_dam`, `dam_evaporation`, `dam_seepage`; the balance V = (H + I + J + Pd) − (G − T) − E − ΔQ − U and the water balance (rain on dams in, dam evaporation out) include them, and `checkWorkings` recomputes all four from the settings and `rain_final`. A farm with no dam (cap 0) is unaffected. The land runoff model's area includes the dam surfaces, so rain on a dam is partly counted twice (small for farm dams; flagged for the hydrologist). **Engine 0.21.1, the b > 1 limiter:** for b > 1 evaporation is also capped at (1 − seepage) × Q[t−1] / b. Without it the daily step, which applies the start-of-day surface to the whole day, turned order round on very shallow dams (a day's evaporation above 1/b of the dam): a fuller dam ended the day with less water than a lower one, and doubling demand raised a farm's supply fraction (fuzz seeds 4197, 7686, 15979, 17277; up to 0.838 → 0.870). The cap is the largest loss that keeps the order, a limiter rather than physics: on an extremely shallow dam it understates the exact (shrinking-surface) evaporation, where the uncapped step overstated it. It never binds for b ≤ 1, so default dams, the replay (area 0) and the client catchment's estimated-area test are unchanged. Tests: `run.test.ts` › "engine 0.21.1: with b > 1 a fuller dam never ends the day with less water", `run.invariants.test.ts` › "engine 0.21.1: doubling crop areas …". Reviewed by the simulated hydrologist persona (2026-09-25), who also recommends narrowing the allowed range to b ≤ 1 ([followups.md](./followups.md)). |
| **N3** | Medium | `demand.ts:55-56` | **Effective rain is applied day by day with no carry-over.** The daily demand is a monthly average, and rain offsets only the day it falls on: a 60 mm day cancels one day of demand and the rest is lost. There is no soil-water store, so demand in the days after heavy rain is overstated, while light rain (≤ threshold) never counts (Q6). | Code read; `demand.test.ts` › "farmDailyDemand … (N3)"; `run.test.ts` › "soil-water store (N3, engine 0.14.0)" and, on the client catchment, "N3: the soil-water store only lowers demand …"; `verify.test.ts` › "catches a soil-water store that overflows …" | **Decided (persona recommendation, 2026-09-24; pending the hydrologist), engine 0.14.0.** A simulated hydrologist recommended a root-zone soil-water balance ([Allen et al. 1998], FAO-56 ch. 8) over monthly effective rainfall ([Dastane 1974]), and the engine now carries effective rain over through one store per farm, a one-bucket form of it: Pe is added to the store, the day's gross demand is met from store + Pe first (so a big rain still covers its own day, as before), and what is left is kept up to `settings.effectiveRainStoreMm`; the excess drains or runs off, water the runoff model already counts. Default **25 mm** = 0.5 × 100 mm/m × 0.5 m, the readily available water of 0.5 m of roots in a 100 mm/m soil (FAO-56 Tables 19 and 22). **0 mm reproduces the workbook bit for bit** (tested). Demand stays precomputed, independent of supply, so `network/simulate.ts` only carries the new working column. The farm's `effective_rain` column is now the rain *used* that day and `soil_water` the store at the end of the day (mm); a new self-check, `soilWater`, holds the store within 0 … size and Σ used ≤ Σ Pe (model.md §2.3 step 4, §6). The crop factors are confirmed to multiply **A-pan** (`grossCropMm`), not ET₀ (about 0.7–0.85 × pan, [Green 1985]); the Crops tab now says "× A-pan, not FAO Kc" and flags a factor above 1.0 as a hint. **For the hydrologist:** confirm the approach and the size (per soil and root depth), or set 0. |
| **N5** | Medium (where boreholes pump near the river) | `network/simulate.ts` (no groundwater) | **Groundwater was not modelled.** Farms that supplement from boreholes showed their full deficit, and pumping near the river, which lowers the dry-season base flow the EWR depends on, was invisible. Nothing about it appeared in the balance. | `network/boreholes.test.ts` (supplemental vs primary, the drought trigger, same-day depletion, the lag conserving volume, the clamp and its warning, less deficit, a user's boreholes); `verify/checks.ts` › `checkGroundwater`; the fuzz generator gives 30 % of networks boreholes | **Built (engine 0.23.0, roadmap WP-1.34, migration 012), off by default; pending the hydrologist.** Per farm or other user: a borehole capacity (m³/day), a rule (supplemental / primary / drought with a dam trigger), a stream-depletion share d and a lag k. Groundwater counts as supply (part of G, its losses return like any other); d × pumping is taken from the node's outflow through a linear reservoir (α = 1 − e^(−1/k)), clamped at the flow there, the unmet part reported and warned about. The method, and why not Glover/Hunt or the GR4J routing store: [model.md §2.7d](./model.md). Engine 0.36.0 (WP-3.9, migration 043) adds individual boreholes with annual caps per water year, an emergency mode and a dam target, and annual use per farm against the caps and the GN 538 ceiling (`network/boreholes.test.ts` › individual boreholes). |
| **N4** | Low | `simulate.ts:114` | **Transfers ignore the receiving dam's free space, and the source's irrigation comes second** (Q3). Water pumped into a full dam spills straight away, and the transfer is decided before the source irrigates. | Code read. `run.test.ts` › "caps a transfer at the destination's room", "still serves the demand of a destination without a dam", "shares a destination's room pro rata", "shares a dam pro rata … whatever the list order (Q18)", "lower priority first"; `run.invariants.test.ts` › "Q18: transfer rules sharing a dam give the same results in any list order" | **Decided (persona recommendation, 2026-09-24; pending the hydrologist) — engine 0.16.0.** Each rule moves `v = MAX(0, MIN(srcFree, dstRoom, maxDaily))`: `srcFree = Q_src[t−1] − drawn today − reserve` (reserve = cap × MAX(rule min, the dam's minimum operating level), Q5) and `dstRoom = cap_dst − Q_dst[t−1] + D_dst[t] − already scheduled into dst today`, so a transfer to a farm with no dam still serves its demand. New `transfer.priority` (integer, lower first; migration 006 set it to each rule's old position, id order). Within a priority, rules into one destination share its room and rules from one source share its free water, each pro rata to its own limit MIN(maxDaily, srcFree), so results never depend on list order; the order-invariance check no longer exempts shared sources. "Source irrigates first?" stays as before: transfers are settled from yesterday's storage before any farm irrigates (documented, no per-rule option). **Engine 0.19.0:** `dstRoom` counts the destination dam's own rain, evaporation and seepage that day (N2): `cap_dst − (Q_dst[t−1] + Pd − E − Sp) + D_dst[t] − scheduled`. Until then a dam that loses water was topped up short by its losses and could drop under its dead storage and supply nothing while the source had water to send; the shortfall didn't scale with demand, so doubling crop areas raised the farm's supply fraction (2 000-case soak, seed 921). `checkTransferLimits` reads the room the same way, so the old under-transfer is now a failed self-check. Tests: `run.test.ts` › "counts the destination dam's own losses today in its room", `run.invariants.test.ts` › "seed 921: …". **Engine 1.29.0 (issue #67):** `dstRoom` adds a *fixed* release's floor (the release with no inflow and nothing transferred in, model.md §2.6), so a full dam with a fixed release takes back what it releases instead of sitting one release below full, and that water passes on below it the same day; a pass-inflow release isn't counted (it is at most the inflow, which the room doesn't count). Tests: `network/dam.test.ts` › "a transfer into a full dam with a fixed release …". **Engine 1.31.0 (issue #200; for the hydrologist's N4 review with the rest):** `dstRoom` adds the most the dam can be drawn instead of `D_dst[t]`: D less its primary direct boreholes' room (within the groundwater allocation room), capped at the surface allocation room (model.md §2.6), so a transfer no longer brings water a primary borehole already supplied or a cap stops the farm using, which spilled the same day. The water-year reset of those volumes moved before the transfers. `checkTransferLimits` reads the room the same way, replaying the primary units. Still counted in full: off-take water used first and a river-first pump, known only after the transfers are settled; where they meet part of D, that part can still spill (a known limitation, model.md §2.6). Tests: `network/dam.test.ts` › "transfer room (audit N4, issue #200)". |
| **M1** | Low | `scripts/wbt-import/{calibration,extract_project}.py` | **Month lists were imported with the workbook's substring bug.** `FIND(m & ",", list & ",")` makes "11" also mean January and "12" February, and the importer copied that into the project. | `scripts/wbt-import/test_months.py` | **Fixed.** The importer keeps the months a list names and prints a `note:` when the workbook would have added others. Neither sample workbook's lists are affected. Since engine 1.0.0 only transfer months are read: the summer months belonged to the legacy runoff model, so their note went with it (issue #16). |
| **W1–W5** | Low | `run.ts`, `flow.ts`, `network/shares.ts` | Inputs that are physically impossible or silently patched gave no warning. | `run.test.ts` › "soundness warnings (audit W1–W5)" | **Fixed (warnings, no numeric change):** W1 runoff coefficient > 1 (H1; since engine 1.0.0 it names GR4J's stores, or for natural flow a caller supplies says "more runoff than rainfall"); W2 days with no rainfall value, treated as dry; W3 a farm area ≠ hi + lo by more than 1 % (review F7; one warning per run from `quality.ts` `areaMismatches`, also in `RunSummary.dataQuality.areaMismatches`); W4 recession factors outside 0–1, a rising curve, or tables of different length (gone with the legacy model in engine 1.0.0); W5 days of natural flow taken from the Pitman fallback (Q7; removed with the fallback in engine 0.10.0, P1). |
| **B1** | High (catchments with gaps in the catchment rain) | `prepare.ts` `prepareRun`, `rain.ts` (engine 0.7.0) | **CHIRPS fills gaps in the catchment rain without bias correction.** Rain used (column R) falls back to raw CHIRPS on every day the catchment rain is blank. At catchment scale CHIRPS can read a fraction of the catchment's gauges, by different amounts in different seasons, so a fallback year can run far too dry. GR4J, which conserves water, then makes too little flow in those years; the hydrologist's review of issue #4 phase 6 made this condition 1 for adopting GR4J. | `rain.test.ts` (known factors, minimum-sample fallback, low-vs-CHIRPS years excluded, flagged runs left out day by day, kept-dry days kept, the keep-dry guard, catchment and forecast rain untouched, no CHIRPS → no-op, skewed TZ, GR4J balance still closes); `run.test.ts` › "B1: changes CHIRPS only on the fallback days" (client catchment) | **Fixed.** CHIRPS used as fallback is scaled by a per-calendar-month factor Σ catchment / Σ CHIRPS over the days both have a reading, leaving out suspect catchment rain: low-vs-CHIRPS water years whole, and (engine ≥ 0.18.0) the days of flagged zero runs not kept dry and of listed missing periods one by one. Kept-dry days stay in unless bias-corrected CHIRPS over them exceeds max(50 mm, 25 % of usual annual rain), which leaves their year out and warns (up to 0.17 every year a flagged run touched was left out). A month with fewer than 90 shared days or 50 mm of CHIRPS takes the pooled factor; with no pooled factor CHIRPS stays raw and the run warns. Factors are clamped to 0.25–4. Catchment and forecast rain are unchanged. Linear scaling per month ([Teutschbein & Seibert 2012]). Rules and reasons: [model.md §2.4b](./model.md#24b-chirps-fallback-bias-correction). It changes both runoff models and irrigation demand, so the regression suite names B1 (below). A setting, `chirpsBiasCorrection: 'monthly' \| 'none'` (default `'monthly'`), turns it off for a CHIRPS series that is already corrected; this is not a workbook-compatibility mode (model.md §2.4b, "Why a setting"). |
| **B2** | High (catchments whose rain record has gaps exported as zeros) | `rain.ts` `zeroRainMask`, `prepare.ts` `prepareRun` (engine 0.15.0) | **Missing catchment rain recorded as 0 runs the catchment dry.** A zero is a reading, so it blocks the CHIRPS fallback that a blank day gets (§2.10a). The issue #2 check found these stretches but only warned. | `rain.test.ts` › "zero-rain runs treated as missing (CR-20, B2)"; `run.test.ts` › "B2: sets aside exactly the flagged zero runs …" on the client catchment | **Fixed, engine 0.15.0 (CR-20, issue #2; operator decision 2026-09-24, pending the hydrologist's confirmation of the flagged runs).** Before rain used is picked, a run blanks the catchment rain on every flagged zero run, so bias-corrected CHIRPS then forecast rain fill it. `settings.zeroRainRuns` sets the mode (`'missing'` by default, or `'asRecorded'`, the workbook's rule), keep-dry periods (flagged runs confirmed as real) and extra missing periods. The stored series never changes; the run reports every period and the rain that replaced it, and marks each day (model.md §2.4c). The regression suite replays with `'asRecorded'`. |
| **B3** | Medium (catchments whose rain network changed over the record) | `doublemass.ts`, `prepare.ts` `prepareRun` (engine 0.18.0) | **The CHIRPS factors blend eras that disagree.** One factor per calendar month is fitted over the whole record. If the catchment / CHIRPS ratio changed part-way (a station opened, closed or moved; a new way of building the catchment average; a CHIRPS change), a gap in the latest era is filled with an older era's ratio, possibly several times too wet or too dry. Nothing checked for it (CR-20's open part). | `doublemass.test.ts` (no break, one break, two breaks, a change under 20 %, the 5-year minimum segment, too-short record and short years, suspect days left out, skewed TZ, the run warning, through `runModel`); `run-tables.test.ts` › "double-mass block" | **Warned, engine 0.18.0 (CR-20).** A double-mass check on water-year totals finds up to two breaks (BIC on the annual ratios, exhaustive search, 5-year segments) and reports one at a slope change of 20 %+ confirmed by Pettitt p < 0.05 or a BIC gain ≥ 6: a `doublemass` data check, `dataQuality.doubleMass`, a Data-tab chart and a summary-CSV block, and a run warning when CHIRPS fills days in a segment whose slope differs 20 %+ from the fit's pooled ratio (model.md §2.10a). It does not change the fit: a break doesn't say which record is wrong. **Durable fix, engine 0.29.0 (issue #40 (a)):** `settings.chirpsFitPeriod` fits the factors per listed water-year range (each with a reason; the double-mass breaks only propose ranges), falling back per range to its pooled factor, then all the ranges'; `missing` and filled days stay out of every fit; the run warning names the range whose factors filled each gap (model.md §2.4b *Fit period*; `rain.fitperiod.test.ts`). The default stays `'all'`, so no result column moves and the regression suite is unchanged. **Gauge-anchored alternative, engine 0.30.0 (issue #40 (b)):** where the network change broke the catchment series itself, `settings.rainSource` replaces a period with a second gauge (`rain_catchment_alt_mm`) × monthly factors, fixed with provenance or fitted against a gauge-free reference; the replaced days stay out of every fit (model.md §2.4e; `rainSourcePeriods.test.ts`). Off by default. |
| **B4** | Medium (catchments whose gauge was not read every day) | `accumulation.ts`, `rain.ts` `zeroRainMask` / `chirpsBiasFactors`, `prepare.ts` `prepareRun` (engine 0.20.0) | **Untagged multi-day accumulations put several days' rain on one day, and the zero-run fill counted it twice.** An observer who skips the gauge enters 0 (or nothing) for the unread days and the whole total on the reading day ([Viney & Bates 2004]): the total is right, the days are wrong. The model then sees a dry spell and one huge storm, which a runoff model turns into far more quick flow than the same rain over several days. Worse, when the run ends in a flagged zero run (§2.4c), engine 0.15–0.19 filled the run from CHIRPS *and* kept the reading, so that rain was counted twice. | `accumulation.test.ts` (detector cases and negatives: small reading, short run, CHIRPS wet on the day or a day late, rain only the day before, a storm after a dry spell, missing CHIRPS, the cap, the factor; spreading keeps totals; keep-reading, as-recorded, listed windows, missing and keep-dry precedence; the double-count regression and the capped run through `runModel`); `run.test.ts` › "B4: spreads each detected accumulation …" on the client catchment | **Fixed, engine 0.20.0 (issue #2).** A reading of ≥ 20 mm after ≥ 3 days of 0 or blank, on a day bias-corrected CHIRPS (±1 day) reads < 25 % of it, with CHIRPS over the run (the day before left out) ≥ 50 % of it, is an accumulation over the run (its last 92 days at most) and the reading day. By default (`settings.zeroRainRuns.accumulationMode: 'spread'`) its recorded total is spread over those days in proportion to bias-corrected CHIRPS; the zero-run fill leaves them alone, and the CHIRPS factor fit leaves them out day by day. `keepReadings` keeps a confirmed one-day reading, `addAccumulations` lists a window by hand. The stored series never changes; the run reports every window, and marks each day (model.md §2.4d). The regression suite replays with `'asRecorded'`. |
| **P1** | Medium (projects with a Pitman series) | `flow.ts`, `run.ts`, `calibrate/calibrate.ts`, `project.ts` (engine 0.10.0) | **Pitman flow mixed a second model into the run.** [Flow data] AB fell back to the Pitman column whenever the rain model gave 0 (Q7), so one natural-flow series could hold two models' output; a Pitman series also set the run period on its own, and could be chosen as the calibration record (then scored against natural flow, C1). The Pitman column is monthly modelled flow repeated daily, not a measurement: it can't calibrate a daily model, and as a fallback it hides the days the rain model gives nothing. | `flow.test.ts` › "no Pitman fallback (… audit P1)"; `run.test.ts` › "P1: natural flow never falls back …", "needs a rainfall series …", "calibrates against the configured flow record" (a stored Pitman choice falls back with a warning); `settings.test.ts` | **Removed (operator decision, 2026-09-24).** `flow_pitman_m3s` is no longer a series kind or a calibration record; natural flow comes only from the runoff model, and only rainfall sets the run period. The importer skips [Flow data] column F (with a note), and a workbook whose `rUseFlow` picks Pitman gets a `WARNING` and no `calibrationFlowKind`. A stored Pitman series or choice from an older engine is ignored with a warning, never an error. A workbook whose Pitman column is empty gives the same results as before. A naturalised-flow reference, if one is wanted later, belongs with the WR2012 check (model.md §2.10c) as a comparison, not as an input. |
| **F1** | Medium (projects with a forecast series past the record) | `forecast.ts` (new; roadmap WP-2.12) | **Forecast rain reached every summary.** `runModel` falls back to forecast rain after the record and extends the run to the forecast's last day, and the reporting window with it, so a 14-day forecast entered the farm averages, curtailment, EWR days not met and the compliance grid: yesterday's forecast changed the figures farmers and regulators rely on. Engine 0.28.0 only warned. | `forecast.test.ts` (no forecast; overlap with the record; forecast rain filling a gap; dry days before the tail; no observed rain; simulation end before the forecast); `forecast.invariants.test.ts` and `backend/scripts/examples/catchments.test.ts` › prefix stability; `backend/src/runs/forecast.db.test.ts` | **Fixed without changing `runModel`.** Forecast mode (model.md §2.4f): `forecastFrom` is the first forecast-sourced day after the last observed rain; an ordinary saved run uses `withoutForecastTail` (the forecast cut there, and `simulationEnd` the day before), and a forecast run (`runForecastChecked`) takes every summary and every historical series from that run and only the tail days from the run with the forecast, with `summary.forecast` over them. `runModel`'s own output is unchanged, so the regression and invariant suites are untouched; the new output fields (`forecastFrom`, `summary.forecast`) appear only on forecast runs. `ENGINE_VERSION` 0.35.0 → **0.37.0** for those fields. Since engine 1.28.0 (K1) the run with the forecast is causal, so a forecast run takes every series from it (its historical days equal the ordinary run's to the bit) and only the summaries from the run without the tail. |
| **K1** | Low (short records; float noise on long ones) | `network/landcover.ts` (Q75), `reserve/assurance.ts` (rule tables on the record's flow-duration curve), `runoff/simulate.ts` (warm-up cycling a record shorter than the warm-up), `allocations/mode.ts` (a full allocation's yearly factor) | **The model is not causal.** A few figures are record-wide statistics, so adding days at the end of the record moves values at its start. A 14-day tail on 900-day random networks moved historical series by about 1e-8 relative in most of 240 cases; on records shorter than GR4J's 365-day warm-up, by more, since the warm-up then cycles the new days in. The roadmap's prefix-stability argument ("the simulation is causal") doesn't hold as stated. The Reserve's base flow (`settings.lowFlowMeasure: 'baseflow'`, engine 1.3.0–1.5.x: a three-pass filter over the whole run) was another such figure, of the monthly report rather than a series; engine ≥ 1.6.0 filters each month on a window ending on its last day, so it is causal and exact across a resume ([model.md §2.9d](./model.md)). | The causality probe behind forecast.ts's head comment (a run with a tail vs without, series compared bit for bit) | **Fixed, engine 1.28.0 (issue #67).** Every record-wide figure reads only the run's historical days, those before its forecast tail (`forecastTail.ts`; every day without a tail, so an ordinary run is unchanged): GR4J's warm-up cycles them, the land-cover Q75 is over them, a rule table's natural curves rank the complete months within them and a month the history ends inside isn't assessed (one wholly in the tail is, on the history's curves: the outlook's older path runs its analogue season that way), and a full allocation fits the year the tail starts in on its historical days. A run with a forecast tail therefore has the same series as the run without it on every shared day, to the bit (`checkForecastPrefix` compares an ordinary run of the input with the tail too, and `forecast.test.ts` › "the model is causal across a forecast tail"), and forecast mode takes every series from the run with the tail, with no splice. It still runs the history twice, for the summaries, which cover their whole run (model.md §2.4f). Adding *observed* days still refits these figures, as it should: they are statistics of the record; a snapshot pins them when that matters (model.md §2.16). |
| **S1** | Medium (dams with a sediment rate over a long record; units coming in part-way through one) | `network/development.ts`, `network/simulate.ts` (engine 1.30.0, issue #67) | **A dam's capacity and a unit's abstraction now change over a run, on judgement calls the hydrologist hasn't made.** The sediment rate runs linearly both ways from the survey date (the operator's choice), so a recent survey on a long record starts the dam larger than surveyed, up to 1 + 0.2 × years at the maximum rate, at the same full-supply area. Dead storage, the survey curve's volumes and the dam-level triggers scale with the capacity; a day with no capacity (before the in-service date, or once filled) routes everything on as spill; a full allocation asks for the volume over the days a unit abstracts on. | `network/development.test.ts`, the random networks (`testing/fuzz.ts` `addDevelopment`) | **Built, pending the hydrologist (issue #90).** Model.md §2.7g. A run warns when a dam is run back to more than 1.25 × its surveyed capacity (`DAM_SEDIMENT_WARN_FACTOR`). Questions: is linear sedimentation right for SA farm dams (or exponential, trap efficiency, Rooseboom's sediment yield map)? how far back should the rate run before the capacity is held? should dead storage fill first, and the full-supply area shrink? A literature source for the rate range is still to add (`docs/calibration-research.md`). |
| **D1** | High (projects whose rain record is shorter than a flow record it was imported beside) | `prepare.ts` `prepareRun` (engine 0.45.0, issue #54) | **The default run window ran over rain padded with blanks.** With `simulationStart` / `End` unset, the run covered the whole span of the rain series, blanks included. A b023 import writes every `[Flow data]` column over the flow record's dates, so a workbook whose flow record starts long before its rain ran those years on 0 mm, and every whole-run figure was distorted. | A hydrology check of an imported workbook; `prepare.window.test.ts` | **Fixed.** An unset end follows the first / last day with rain the model can use (catchment, a rain-source series, corrected CHIRPS or the forecast; a set-aside recorded zero counts), and a run warns whenever a default end leaves out flow or A-pan days. An explicit window still wins. A project whose rain has a value on its span's first and last days runs as before (the examples). The importers also set the window from `[Home]` (issue #54). |
| **C2** | Medium (fits on records with suspect days, or a gauged range entered) | `calibrate/dayFlags.ts`, `calibrate/calibrate.ts` `prepareCalibration`, `run.ts` `runPlausibility` (engine 1.22.0, issue #66) | **Automatic calibration scored every observed day as recorded.** Days the Data checks call suspect (a flat stretch, an outlier) and flood days read off a rating curve extended past its highest gauging (±5 % inside the gauged range on SA weirs, over 40 % beyond it: Wessels & Rooseboom 2009) weighed in the objective like any other, so a fit could chase a stuck logger or an extrapolation (calibration research CR-18/19; Beven & Westerberg 2011). The recession diagnostics (CR-13) read them too. | `calibrate/dayFlags.test.ts`; `calibrate.test.ts` › "calibrate reads the per-day quality flags" (suspect days left out, censoring invariance with a positive control, the recession mask); `provenance.test.ts`, `compare.test.ts` | **Fixed, engine 1.22.0 (pending the hydrologist, issue #66).** Each day of a calibration record is flagged (model.md §2.10h); by default the fit censors days above the highest gauging (the model only has to reach it) and leaves below-rating, suspect and infilled days out, each configurable in `settings.qualityFlags`; the report shows the fit on all days beside it and a data-quality panel, and the fit record keeps the settings. The recession segments leave flagged days out. The run's calibration statistics, and every run result column, are unchanged, so the regression suite's deviation list doesn't move. |
| **A1** | Medium (Reserve rule-table sites whose natural flow falls below the table's driest point: (100 − P_last) % of months with the percentile from the run, 1 % at the DRM's 99 % point; more with the gazette's curve when the model runs drier) | `reserve/assurance.ts` (engine 0.21.0; model.md §2.9c, §2.9d) | **Below a rule table's driest point the requirement is scaled down with the flow, not held at the drought flow.** Drier than the driest natural point, the requirement is `T_last × V / N_last` (and the low flows the same way), not the full drought flow `T_last`, so those months are easier to meet than a held requirement would make them. The alternative, holding `T_last`, asks a river with less than its driest natural flow for more than the table's ratio. | `assurance.test.ts` › "holds the first EWR above the wettest point and scales the last below the driest"; `lowHighFlows.test.ts` › "… scales the low flow below the driest point"; the evidence report counts those months per site and flags them (G16, issue #71) | **Decided (from the literature, engine 0.21.0; pending the hydrologist).** Scale with the flow, keeping the table's EWR-to-natural ratio at its driest point, so natural flow still meets its own rules (the invariant). The evidence report prints the months beyond the driest point as a page-1 caution. Holding `T_last` instead is a one-line change and an `ENGINE_VERSION` bump if the hydrologist prefers it, and relaxes the natural-meets-its-own-rules invariant below the driest point (plan.md question 17). |
| **A2** | Low | `reserve/assurance.ts` (engine 0.21.0; model.md §2.9c) | **A rule table is interpolated linearly between its % points; Sawunyama & Hughes (2010) interpolate on a log scale.** The requirement between two points, and the percentile, move with the natural flow in a straight line, so a month between widely spaced points (80 % and 90 %, say) reads a slightly different requirement than a log reading would. | `assurance.test.ts` › "interpolates the % and the EWR with the same weight"; the invariant "natural flow meets its own rules" needs the same weights | **Decided (from the literature, engine 0.21.0; pending the hydrologist).** Linear in the % and the flow with one weight, as Pollard et al. (2011) interpolate between the 80th and 90th percentiles: a gazette table has zeros (no log of 0), and the shared weight keeps the invariant exact (plan.md question 17). |
| **A3** | Medium (sites whose modelled natural flow differs from the determination's) | `reserve/assurance.ts` `naturalSource`, `EWR_NATURAL_MAR_TOLERANCE` (engines 0.21.0 and 1.11.0; model.md §2.9c) | **By default a month's natural percentile comes from the run's own natural flow, not the gazette's natural curve.** A model wetter or drier than the determination's natural flow then keeps the table's requirements but moves the months' conditions, so it passes (or fails) months the gazette's curve would judge otherwise. In `run` mode the requirement is also refitted as observed days are added (K1); `table` mode is not. The run warns when its natural MAR is more than ±15 % from a recorded determination MAR; the 15 % is a judgement, not a published standard. | `assurance.test.ts` › "ranks natural flow among the run’s own years …", "reads the requirement off the entered natural curve …", "warns beyond ±15 % only when the percentile comes from the run", "within ±15 % (15 % itself included) there is no warning" | **Decided (from the literature and the persona drafts, engines 0.21.0 and 1.11.0; pending the hydrologist).** `run` stays the default, `table` is one setting per rule table; the persona drafts prefer `table` wherever the determination publishes a natural curve. The ±15 % tolerance is a draft (model.md §2.9c; plan.md question 17). |
| **A4** | Medium (sites with a Reserve rule table) | `settings.ewrChargeSource`, `run.ts`, `network/attribution.ts` (engine 1.3.0, issue #64; model.md §2.9c) | **The daily EWR charge, curtailment and the water account follow the pragmatic EWR by default, while the Reserve compliance report follows the rule table.** A site can pass its months on the rule table and still charge farms for days below the pragmatic EWR, or the reverse; which one a licence condition should follow is not settled (the open end of quirk Q17). | `ewrMethods.test.ts` › "the EWR charge from the Reserve rule table" (charges against the month's requirement inside complete months, never more than a farm's net impact; months judged the same either way) | **Built (engine 1.3.0, issue #64), off by default; pending the hydrologist and the assessor.** `ewrChargeSource: 'ruleTable'` spreads each complete month's requirement evenly over its days (plan.md question 17). |
| **A5** | Medium (sites with a low-flow requirement and floods in dry months) | `settings.lowFlowMeasure`, `reserve/baseflow.ts` `BASEFLOW_ALPHA` (engines 1.3.0 and 1.6.0; model.md §2.9d) | **By default a low-flow requirement is judged on the month's total volume, so a flood month can pass its low flows while its base flow was short.** The base-flow option uses the Lyne–Hollick filter at α 0.995 with three passes (Nathan & McMahon 1990); the choice of measure, α and passes changes which low-flow months fail. | `ewrMethods.test.ts` › "a flood month passes a low-flow table on its total flow and fails it on its base flow", "appending days never changes a completed month’s base flow or low-flow verdict"; `baseflow.test.ts` | **Built (engines 1.3.0 and 1.6.0, issue #64), off by default; pending the hydrologist.** `lowFlowMeasure: 'baseflow'`, α 0.995 (Smakhtin & Watkins 1997), three passes, each month filtered over its own days and the 730 before them (plan.md question 17). |
| **A6** | Medium (rule tables with high-flow components) | `reserve/assurance.ts` `countHighFlowEvents`, `EWR_HIGH_FLOW_EVENT_LEVEL`, `EWR_HIGH_FLOW_NATURAL_MIN_SHARE` (engines 0.33.0, 1.9.0 and 1.11.0; model.md §2.9d) | **A high-flow event is found in daily flow by the engine's own rule: at least half the duration at or above half the peak.** Neither the gazette nor the DRM papers say how to find an event in a daily series. On a base flow above half the peak a whole spell counts as one event, a broad, flat flood can satisfy a requirement for an event up to twice its real duration, and the peak is a daily mean the hydrologist converts from the gazette's instantaneous peak (the run warns when natural flow has no event in more than half the water years, a 0.5 that is also a judgement). | `lowHighFlows.test.ts` › "counts a triangular event hydrograph of the stated peak and duration, and not one half as long", "counts a run above the level once, and two peaks with a fall below it between them twice", "warns when natural flow reaches the peak in no more than half the water years …" | **Decided (engine 1.9.0, licensing-authority persona review of issue #46; pending the hydrologist).** Half the peak for half the duration, the event in the month of its first day at the peak; whether the level should sit on the base flow instead is open (plan.md question 17). |
| **A7** | Medium (rule tables with high-flow components) | `reserve/assurance.ts` (engine 0.33.0; model.md §2.9d) | **A year is asked for no more high-flow events than its natural flow had, counted per water year, and the DRM's high-flow volumes are not checked.** `required = MIN(perYear, n_nat)` never fails a dry year for a flood it didn't have; the alternatives are to require the events outright in maintenance years only, or to count per month. The DRM's own high-flow volumes (Mm³ per month) would be a third check. | `lowHighFlows.test.ts` › "asks each year for no more events than natural flow had, and meets it when the simulated flow has them", "on random series: natural flow meets its own high flows …" | **Decided (from the literature, engine 0.33.0; pending the hydrologist).** Capped by natural events, per complete water year, events only (plan.md question 17). |
| **L1** | Medium (capped runs whose licences state months of use or a maximum rate) | `allocations/mode.ts` `dailyLimits`, `network/simulate.ts` `capRoom` (engine 1.34.0, issue #72; model.md §2.12a) | **The cap applies a licence's months of use and maximum rate to every surface draw, the farm's own dam included, and not while no licence of the source is in force.** A licence's months and rate usually name the abstraction from the river (filling a dam in winter to irrigate in summer), so a winter-only licence on a farm with a full dam now shows the summer's demand as deficit and the dam spilling, where limiting only the river-side takes (the diversion, the river pump, off-take water) would let it draw its stored water. And on a day no allocation of the source is in force (one lapsed mid-year), there is no daily limit, while the year's budget still counts the lapsed licence's share, which may then be taken in any month at any rate. | `mode.test.ts` › "takes nothing outside the months of use, and as before inside them", "takes at most the maximum rate × 86 400 a day, and the rate binds", "gives 0 in a month no in-force allocation may use, and no limit on a day none is in force" | **Decided (engine 1.34.0, issue #72; pending the hydrologist).** Every surface draw counts, as the cap already counts every dam draw as surface use (§2.12a, followups.md § Allocations); the other reading, the river-side takes only, is a change to where `sRoom` applies in `simulate.ts` and an `ENGINE_VERSION` bump if the hydrologist prefers it (issue #90). |
| T1 | Low (tests) | `run.test.ts` | The skipped client catchment suite read its absent fixtures while vitest collected tests, which crashed `pnpm test` on any clone without `data/`. | `pnpm test` on main | **Fixed** (it now reports one skipped test). |

## Workbook quirks (model.md §3): decisions

| # | Decision in 0.4.0 |
| --- | --- |
| Q1 upstream "above dam" % drives the below-dam split | **Fixed (engine 0.9.0, client decision 2026-09).** The percentage is the share of upstream inflow that enters the dam, as the label, the `[Models]` sheet and the Pitman/WRSM farm-dam convention have it; the workbook's formula was backwards. No rename needed: `pct_upstream_to_dam` now means what it says. The UI calls it "Upstream inflow to dam". |
| Q2 transfer reads spill | Not mirrored (already). |
| Q3 transfer order / spill at the receiver | **Decided (persona recommendation, 2026-09-24; pending the hydrologist) — engine 0.16.0**, see N4: capped at the receiver's room; transfers before irrigation. |
| Q4 | Doc only. |
| Q5 irrigation may empty the dam | **Decided (persona recommendation, 2026-09-24; pending the hydrologist) — engine 0.16.0.** `node.damMinPct` is the dam's minimum operating level (dead storage): `G = MIN(MAX(avail − cap·damMinPct, 0), D)` with `avail = Q[t−1] + Pd − E − Sp + M + O + K + J` (D and the dam terms from N1 and N2), and a transfer keeps `cap × MAX(rule minStoragePct, damMinPct)` in its source. Migration 006 reset every stored value to 0 (the importer had filled it with the workbook's transfer minimum, which each rule already carries), so no existing result changes; the importer writes 0 and notes the workbook value. The editor flags a dam with a 0 floor as a hint ("irrigation may empty this dam"), not an error. Tests: `run.test.ts` › "irrigation stops at the minimum operating level", "keeps the source dam's minimum operating level"; `checkWorkings` checks the G formula and `checkTransferLimits` the reserve. |
| Q6 threshold on the demand offset | Defensible: small rains are mostly intercepted ([Dastane 1974]). The larger issue, no carry-over, is N3: decided on a persona recommendation (engine 0.14.0, soil-water store), pending the hydrologist. The threshold still applies before the store. |
| Q7 Pitman fallback | **Removed (P1, engine 0.10.0).** Natural flow comes only from the runoff model. Days without rain data are still warned about (W2). |
| Q8 hi/lo over listed farms | Sound (the shares are normalised); W3 catches area drift. |
| Q9, Q10 | Settings; no engine change. |
| Q11 equitable target ignores the network | **Decided (simulated CMA-assessor recommendation, 2026-09-24; pending the real assessor and hydrologist) — engine 0.17.0, labels only.** The equitable fraction is labelled *Equitable share of supply (fairness benchmark)*, the target *Equitable share volume*, the reduce/gain column *Above (−) / below (+) equitable share* (no word "gain" anywhere); the curtailment table in the UI and the summary CSV end with the fixed footnote `EQUITABLE_SHARE_FOOTNOTE` ("… Not an allocation or licence condition."). No computation changes. Under the NWA, sharing in a shortage runs through authorisations (s43; Schedule 3 item 6 restrictions, gazetted as % of authorised use per sector), and model demand is gameable (raising crop factors or areas raises a farm's share), so a benchmark must not read as an allocation. **Future work:** a network-aware allocation based on authorised volumes (licence or WARMS), with Schedule 3 item 6 restrictions as % cuts of them and feasibility checked by re-running the network, as a new, separately labelled table. Tests: frontend `curtailment.test.ts` (no verdict says "gain"), backend `run-tables.test.ts` › "Q11: …". |
| Q12 label | UI wording only; the engine field is `fractionOfDemandLeft`. |
| Q13 EWR cut on a farm with no demand | **Decided (simulated CMA-assessor recommendation, 2026-09-24; pending the real assessor and hydrologist) — engine 0.17.0.** A licence condition must be something the user can comply with, so the farm's EWR charge (Q17) splits by channel: irrigation part `A·c/(c + MAX(o, 0))` (c = G − T consumptive irrigation, o = e − c storage gain and net export) and a *store less / pass inflow* part. Only the irrigation part is a supply cut, `ΔG = R_irr / (1 − β(1 − e))` (consumptive use = G(1 − β(1 − e)), N1), so a farm with no demand gets a supply cut of 0 and its charge reads as a release / bypass condition. Curtailment S = N − ΔG, U = `MAX(M − ΔG, 0)`, `fractionOfDemandLeft` in 0–1, and `ewrCutBeyondShareM3Day = MAX(ΔG − M, 0)` flags "EWR cut exceeds this farm's equitable share". "Demand left %" shows "no demand" (H = 0), "—" below `DEMAND_PCT_FLOOR_M3_DAY` = 1 m³/day, else a whole % with "<1%" / ">99%" at the ends; the CSV keeps the unrounded value plus `demand_pct_note`. Tests: `curtailment.test.ts` › "Q13: …", `run.test.ts` › "charges a short outlet …" (a damless farm with no irrigation: all storage), frontend `curtailment.test.ts` › "demand left % (Q13)", `run-tables.test.ts` › "Q13: …"; `checkReportTotals` asserts the identities on every run. |
| Q14 K_tot from rounded averages | **Fixed (R1).** |
| Q15 l/s truncated | **Fixed (R1).** |
| Q16 | Workbook-only. |
| Q17 incremental shortfalls don't add up | **Decided (simulated CMA-assessor recommendation, 2026-09-24; pending the real assessor and hydrologist) — engine 0.17.0.** Both options, combined: the EWR is assessed at **EWR sites** (the outlet and every gauge), and each site's shortfall `D = MAX(Z − U, 0)` is charged to the farms upstream of it **pro rata to their net impact** `e = H + I + J_int − U` (`J_int`: only transfers with both ends upstream of the site, so an export is charged to its source and an import credited). Charged `D* = MIN(D, Σ e⁺)`, natural `N = D − D*`, farm share `A = D*·e⁺/Σe⁺`; a farm under several sites carries the largest share and records the binding site. Each charge splits into an irrigation part `A·c/(c + MAX(e − c, 0))` (c = G − T) and a storage / pass-inflow part; the supply cut is `A_irr / (1 − β(1 − e))` (model.md §2.7b). New series `ewr_charge`, `ewr_charge_irrigation` (farms), `ewr_charged`, `ewr_natural` (sites); curtailment R, FarmSummary EWR means and the farm EWR grids use the charge; `CurtailmentSummary.ewrSites` is the per-site table. AB stays as the diagnostic **reach shortfall**. The G1 gauge fix stands. Tests: `network/attribution.test.ts` (hand cases and random-tree invariants: Σ A + N = D, 0 ≤ A ≤ e⁺, nothing outside a site's catchment or on a met day, max over sites, order-free), `run.test.ts` › "charges a short outlet …", the confluence case, `checkEwrAttribution` in every saved run's self-checks and the fuzz soak; on the client catchment "Q17: every EWR site splits exactly …". Engine 0.21.0 judges the same EWR sites monthly against a Reserve rule table when one is entered (model.md §2.9c, hydrologist Q6); the charge follows the daily pragmatic EWR by default; from engine 1.3.0 it can follow the rule table's requirement instead (`settings.ewrChargeSource`), and which it should follow is finding A4. |
| Q18 several transfers from one dam | Overdraw fixed earlier (engine 0.3.1: rules served in list order from what is left, engine review F1). **Decided (persona recommendation, 2026-09-24; pending the hydrologist) — engine 0.16.0:** `transfer.priority`, lower first; equal priorities share the dam pro rata to their limits (N4). |

## Verified sound (no change)

- **Units:** mm × km² × 1000 = m³; m³/s × 86 400; l/s = m³/day ÷ 86.4;
  crop mm × m² ÷ 1000 = m³.
- **Calendar:** water-year index `(m + 2) % 12`; UTC epoch days. February =
  28.25 days is *correct* for long-term-mean monthly A-pan (a mean February has
  28.25 days), and in leap years it keeps the same daily rate.
- **Farm balance closure:** inflow + opening storage = outflow + consumptive use
  + closing storage, at every node on every day, now in exact arithmetic. The
  fuzz invariants check it; this session ran `FUZZ_CASES=5000`. Transfers net to
  zero; supply stays within 0 and demand; storage stays within 0 and capacity;
  spill occurs only at capacity.
- **Routing:** same-day routing upstream-first through a tree. With no travel
  time this suits daily steps on catchments of a few hundred km² (travel time
  under a day). There are no channel transmission losses: a simplification to
  note in the help text.
- **Explicit scheme:** transfers use yesterday's storage and are settled
  before any farm, so the result doesn't depend on the order farms are
  processed in.
- **Season switch (fSorW2)** (legacy model, removed in engine 1.0.0): an empirical wetting-up rule. Once a big storm has
  wet the catchment, it responds as in winter until the next summer month.
  Defensible as antecedent-moisture switching; its thresholds are calibration
  parameters.
- **Master recession curve and max(response, base)** (legacy model, removed
  in engine 1.0.0): flow recedes by its
  position on one curve, and rain adds a pulse at a shifted index. This is a
  recognised empirical approach ([Tallaksen 1995]). H1 is about the base-flow
  *reset*, not the curve.
- **Fragmentation:** area and hi/lo shares assume uniform runoff per km² (area),
  or per MAP zone (hi/lo, the Pitman split). The EWR is split by the same
  share, so a site's requirement scales with the land that feeds it.
- **Calibration statistics:** NSE ([Nash & Sutcliffe 1970]), PBIAS, RMSE, KGE
  with population σ ([Gupta et al. 2009]), the KGE benchmark −0.41
  ([Knoben et al. 2019]), log-NSE with ε = ō/100 ([Pushpalatha et al. 2012]),
  and the Moriasi thresholds ([Moriasi et al. 2007]; note that the 2015 update
  suggests NSE > 0.50 and |PBIAS| < 15 % as "satisfactory" for daily/monthly
  flow; the app no longer shows rating words, calibration research CR-6).
  Blank observations are skipped, and a constant observation series
  gives null.
- **EWR compliance grid:** the daily count is the right definition of "% days
  not met". The workbook macro's running-total count is kept only for the
  regression. It is still a count against the pragmatic EWR; compliance with
  a Reserve determination's assurance rules is judged by month, and is a
  separate, optional report (engine 0.21.0, [model.md §2.9c](./model.md#29c-ewr-compliance-by-the-reserves-assurance-rules-engine--0210-hydrologist-q6)).
  It adds to the workbook rather than departing from it: no workbook column
  changes, and with no rule table (every imported project) the run is as
  before.
- **Division guards (engine review F6):** flat curve segment, amplitude 0,
  receded base 0: kept until the legacy model was removed (engine 1.0.0).
- **Curtailment formulas:** a correct equitable (proportional) share of the
  water actually supplied. The policy questions are Q11 and Q13; the EWR
  column changed with Q17 (engine 0.17.0).

## Effect on results

The client catchment can't be run in this environment (the `data/` fixtures are client
data). On the three invented example catchments, comparing engine 0.3.1 (which
reproduced the workbook exactly) with 0.4.0:

| | Kleinberg | Droëvlei | Sandspruit |
| --- | --- | --- | --- |
| Mean natural flow | +0.001 % | +0.005 % | +0.000 % |
| Mean simulated outflow | +0.001 % | +0.001 % | +0.001 % |
| Farm supply fractions | ±0.0002 | ±0.0002 | unchanged |
| EWR days not met | 767 → 768 | unchanged | unchanged |
| Largest single-day change | 1 481 m³/day (a spill shifting by a day) | 771 m³/day | 11 958 m³/day at the confluence gauge's shortfall (G1) |
| Largest mean change | small deficits (3–5 %, < 0.2 m³/day) | 0.1 % | confluence gauge shortfall −8 % and the farm below it (G1) |

E1 shows up as a day-1 difference only. None of the
examples trips a new warning.

**B1 (engine 0.7.0).** The example catchments have no CHIRPS series, so their
results don't change. On a catchment with CHIRPS fallback days, every
fallback day is corrected, and results change only on those days and the
water years that hold them. (Results measured on the client catchment are
not recorded here: the repo is public.) **H1, N1, N2 and N3 are the findings that could
move results materially.** H1 is closed: engine 1.0.0 removed the legacy
model (issue #16), so every run is GR4J; N3 (engine 0.14.0) and N1 and N2 (engine 0.16.0)
are implemented on a persona recommendation the hydrologist still has to
confirm, see below. Q17 and Q13 (engine 0.17.0) change every farm's EWR
charge and curtailment figures, but no flow or storage.

**F1 (forecast mode, WP-2.12).** No engine result moves: `runModel` is
unchanged. What moves is what the backend saves: an ordinary run of a
project with a forecast series past its record now stops at the record (it
used to run on through the forecast, which the summaries then covered). Of
the examples only Sandspruit has one (10 days); its seeded run now ends on
31 Dec 2024 instead of 10 Jan 2025, and its farm view was already cut there.

**D1 (default run window, engine 0.45.0).** Nothing moves where the rain
already fills its span: all three examples give the same run, bit for
bit, as their window written out (`examples.invariants.test.ts`), with no
new warning. A workbook whose rain starts well after its flow record,
extracted before its importer set `simulationStart`, now runs from its first
rain, and warns about the flow days it leaves out.

**C2 (quality flags, engine 1.22.0).** No run result column moves: the
flags change automatic calibration and, where a record has flagged days, the
recession diagnostics in the plausibility checks. With no gauged range
entered, fits change only on records with suspect days (outliers or flat
stretches). Measured on the three example catchments (2026-09-28): none has
a suspect or flagged day (Kleinberg 4 912, Droëvlei 5 281, Sandspruit 3 512
days all scored), so their fits are unchanged. A project whose parameters came from an earlier
fit keeps them until it is refitted.

## Regression suite: deviation list

`packages/engine/src/run.test.ts` compares with the workbook column by
column, under a rule that names the finding. (`flow.test.ts`, which compared
the legacy model's [Flow data] columns, went with the model in engine 1.0.0.)
Since engine 1.0.0 the network is fed the workbook's own natural flow; the
end-to-end comparison of natural flow from rain is retired (below).

- **exact:** catchment EWR (and, until engine 1.0.0, the season flag and
  rain used, in `flow.test.ts`).
- **per-day bound from the dropped ROUND steps (R1):** demand (0.55 + cropped
  m² × 0.005 / 1000 / 28), runoff and EWR share (0.5), cumulative EWR (0.5 per
  farm at or above the node), and, until engine 1.0.0, rain-added flow (INT:
  0 ≤ Δ < 1).
- **whole-run mean within 1 % + 1 m³/day (R1 through the state):** supplied,
  deficit, inflow, transfer, storage, spill, outflow, farm shortfalls, and the
  catchment outflow and EWR-not-met series.
- **Retired in engine 1.0.0 (issue #16): natural flow end to end**, water-year
  volume within 2 % + days × (rounding floor + 1) (E1, R1). It needed the
  legacy model. Its last run, on engine 0.45.0 (2026-09-26), passed: with the
  CHIRPS correction off every water year was within that bound, and with it
  on only the B1 years differed. `run.test.ts` keeps the record, and an
  end-to-end GR4J smoke test on the client catchment takes its place (it
  runs, scores its calibration record and passes every self-check; GR4J isn't expected to
  match the workbook day by day).
- **G1:** a confluence gauge's shortfall, and the AB of a farm directly below
  one, are checked against the new definition instead.
- **B1 (engine ≥ 0.7.0):** on the days CHIRPS stands in for blank catchment
  rain, the engine bias-corrects it and the workbook doesn't.
  - *Demand* keeps its R1 per-day bound on every other day and is not
    compared on those days (its effective-rain offset uses the corrected
    rain).
  - *Natural flow end to end* was compared with the correction **off**
    (`chirpsBiasCorrection: 'none'`, the workbook's rain used), where every
    water year had to stay within the E1/R1 bound; with it on, only water
    years that hold fallback days could leave it (retired in engine 1.0.0,
    above).
  - A separate test checks that, with the correction on, CHIRPS changes on
    exactly the fallback days, by exactly the month's factor, and that
    catchment rain doesn't change.
  - The mean columns fed by demand (supplied, deficit, inflow, storage,
    spill, outflow, shortfalls) stay within their R1 bound with it on.
  - Until engine 1.0.0, `flow.test.ts` fed `computeNaturalFlow` the
    workbook's own rain columns, so B1 (applied in `prepareRun`) didn't reach
    it and rain used stayed exact there.
- **P1 (engine ≥ 0.10.0):** no Pitman fallback, so natural flow (AB) would also
  differ on any day the workbook took its Pitman column. A workbook with an
  empty Pitman column has no affected column; one with Pitman values would
  need those days listed here.
- **N3 (engine ≥ 0.14.0):** effective rain carries over through a soil-water
  store (default 25 mm), which the workbook doesn't have, so demand and
  everything fed by it (supplied, deficit, storage, spill, outflow, the EWR
  shortfalls, curtailment) differ on the days after rain. The suite replays
  the workbook with `effectiveRainStoreMm: 0`, which is bit for bit the
  workbook's rule, so every rule above still applies unchanged. A separate
  test runs the default store on the client catchment: demand is identical
  on every day the store starts empty, never higher on any other day, lower
  on some, and every self-check passes.
- **B2 (engine ≥ 0.15.0):** flagged zero-rain runs in the catchment rain are
  treated as missing, so corrected CHIRPS fills them, while the workbook runs
  them dry. Rain used, natural flow, demand and everything downstream differ
  in and after those runs. The suite replays with `zeroRainRuns.mode:
  'asRecorded'`, the workbook's rule, so every rule above still applies. A
  separate test runs the default on the client catchment. It checks that exactly
  the flagged runs are set aside and that catchment rain changes on no other
  day. It also checks that CHIRPS covers every set-aside day and that every
  self-check passes.
- **B4 (engine ≥ 0.20.0):** a multi-day accumulation's recorded total is
  spread over the days it covers, while the workbook keeps it on the reading
  day. Rain used, natural flow, demand and everything downstream differ in
  and after those windows. The suite replays with
  `zeroRainRuns.accumulationMode: 'asRecorded'`, the workbook's rule, so every
  rule above still applies. The windows are also left out of the CHIRPS
  factor fit, in either mode, which moves the factors and so CHIRPS on the
  fallback days, which the B1 rule already exempts. The B2 test runs the
  zero-run default with accumulations as recorded; a separate B4 test runs
  both defaults on the client catchment. It checks that each window wholly
  inside the run adds up to its recorded total, that no window day is also
  filled as a zero run, that catchment rain changes on no other day, and that
  every self-check passes.
- **B1 / B2 fit (engine ≥ 0.18.0):** the CHIRPS factors leave a flagged zero
  run out day by day instead of its whole water year, keep kept-dry days in,
  and leave a doubted keep-dry's year out (model.md §2.4b). That moves the
  factors, so CHIRPS changes on the fallback days, which the B1 rule already
  exempts; no other column moves, so the deviation list is unchanged.
- **Q5 (engine ≥ 0.16.0):** the replay sets every `damMinPct` to 0, as
  migration 006 does (the workbook's column is the transfer minimum), so no
  column differs.
- **N1 (engine ≥ 0.16.0):** the workbook's return flow % r runs as
  efficiency 1 − r with every loss returning (migration 006). Workbook F is
  compared with `crop_requirement` (the daily R1 bound). The network columns
  N1 moves (supplied, deficit, inflow_upstream, transfer, dam_storage, spill,
  outflow, ewr_shortfall, ewr_shortfall_incremental, and the catchment
  outflow and EWR-not-met) are compared against a second run, the **N1
  replay** (issue #68): each farm with e < 1 gets a demand factor of e, so it
  abstracts e·F ÷ e = F, the workbook's demand, and returns β(1 − e)·G = r·G
  with β = 1, the workbook's return. Its supplied, return flow and everything
  downstream are then the workbook's again (the "N1 replay" test checks D = F
  and T = r·G per farm and fails on an N1 farm with β ≠ 1). Up to #68 these
  columns were skipped on every N1 farm and everything below one, which on
  the client catchment was most of the network; what is still skipped is N4
  (below).
- **N2 (engine ≥ 0.16.0):** the replay gives every dam an area of 0 m² and no
  seepage, which is the workbook's dam bit for bit, so no column is listed
  for it. A separate test runs the estimated areas on the client catchment:
  every self-check passes, the dams evaporate, W6 counts them and the total
  dam storage is lower.
- **N4 / Q18 (engine ≥ 0.16.0):** a transfer is capped at the destination's
  room, and rules run by priority. The replay runs the workbook's rules at
  priority 0. Where the room binds (on the client catchment the destination
  is near full on almost every day the engine moves less), the workbook pours
  into a full dam that spills, and the engine leaves the water in the source,
  which spills it there instead. No input sets a transfer's volume, so the
  replay can't undo it: on both ends of every enabled rule, and below only
  one end, the N1 columns are skipped (`n4Ends`, `n4OneEnd`); below the node
  where the ends' flows join (`n4Joined`), outflow and inflow_upstream are
  still compared (the volume is the same, mean rule) and only the columns
  that depend on the day (supplied, deficit, transfer, dam_storage, spill and
  the two EWR shortfalls; the catchment's EWR-not-met) are skipped. From
  0.19.0 the room also counts the destination dam's rain, evaporation and
  seepage; the replay's dams have none (N2 above), so nothing changes.
- **Q17 (engine ≥ 0.17.0):** the farm's EWR charge at the EWR sites replaces
  AB as what drives curtailment, and the workbook has no charge. AB itself
  (`ewr_shortfall_incremental`, now the diagnostic reach shortfall) is still
  compared under the rules above. Not compared with the workbook, because the
  workbook has no equivalent: the engine's own curtailment R, S, T, U and V,
  `FarmSummary.avgEwrShortfallM3Day` / `daysEwrNotMet`, and the farm grids of
  `ewrCompliance`. The `[Shortfalls]` replay below feeds the workbook's AB in
  as the charge (all of it irrigation, supply per consumptive use k = 1), which
  is the old attribution, so the sheet's formulas are still checked. A
  separate test runs the attribution on the client catchment: every site
  splits exactly into charged + natural and every self-check, including
  `checkEwrAttribution`, passes.
- **Q13 (engine ≥ 0.17.0):** the volume left U is `MAX(M − ΔG, 0)` and S is
  `N − ΔG`. With the replay's AB fed in as an all-irrigation charge and k = 1,
  ΔG = −R, so S is still the sheet's `N + R`; U and V differ only where the
  sheet's `M + R` is negative (the engine shows 0 and flags the cut beyond
  the equitable share), and the replay checks `MAX(M + R, 0)` there.
- `[Shortfalls]` and the EWR pivot are fed the workbook's own daily columns, so
  they test `curtailment.ts` and `ewr.ts` in isolation. The saved window's H,
  I, R are within the sheet's `ROUND` (±0.5), and the whole run is replayed
  against the unrounded formulas.

The suite was run locally against stand-in fixtures that engine 0.3.1
generated on the example catchments (Kleinberg and Droëvlei pass in full;
Sandspruit is fully supplied over its whole run, so it fails only the
client-catchment-specific "the whole run has deficits" check). **To confirm on
the client catchment**, re-extract (`scripts/wbt-import/README.md`) and run
`pnpm test:engine`. A failure message prints the actual difference against
the bound.

## Open questions for the hydrologist

1. **H1 (closed 2026-09-26):** the base-flow reset was never replaced; engine
   1.0.0 removed the legacy model instead, and GR4J, which conserves water at
   the event scale, is the only runoff model (issue #16). The operator
   assumed the hydrologist's agreement and waived the review session that
   was to come first; the hydrologist can still question GR4J's results.
2. **N1 (confirm the decision):** abstraction = crop requirement ÷
   application efficiency e per farm, with a share β of the losses returning
   the same day (engine 0.16.0; new farms e = 0.90, drip, the client's
   default since issue #90, β = 0.5; old return flow r
   became e = 1 − r, β = 1). Are the defaults and the per-system values right
   for the catchment, and should e be per crop instead of per farm?
3. **N2 (confirm the decision):** engine 0.16.0 evaporates k_lake × A-pan from
   each dam's surface (A = A_full × (S/cap)^0.7, k_lake = 0.75 A-pan based),
   adds the rain on it, and seeps an optional fraction of storage into the
   outflow; an unknown area is capacity ÷ 3 m (W6). Which dams have surveyed
   areas (or area–volume curves), is 0.75 × A-pan right for the region, and
   should the land runoff area exclude the dam surfaces?
4. **N3:** engine 0.14.0 carries effective rain over through a one-bucket
   soil-water store (25 mm by default), on a simulated hydrologist's
   recommendation. Confirm the approach and the store size for the catchment's
   soils and root depths (0 turns it off). The crop factors are A-pan based in
   the code; confirm the project's factors were derived against A-pan.
5. **N4 / Q3, Q18 (confirm the decision):** engine 0.16.0 caps a transfer at
   the receiver's room (free space + that day's demand; from engine 1.29.0
   + a fixed release's floor, so a full dam with a fixed release takes back
   what it releases and passes it below), runs rules by
   priority, shares equal priorities pro rata, and settles transfers before
   the source irrigates. Is that how the schemes are operated?
6. **Q17 (confirm the decision):** engine 0.17.0 assesses the EWR at the
   outlet and every gauge and charges each site's shortfall to the farms
   upstream pro rata to their net impact (at most what each took; the rest is
   natural), a farm under several sites carrying the largest charge. Are the
   gauges the right EWR sites, or should only designated sites count (WP-3.7)?
7. **Q13 (confirm the decision):** engine 0.17.0 splits the EWR charge into
   an irrigation part (a supply cut) and a *store less / pass inflow* part, so
   a farm with no demand is never asked to irrigate less; the volume left is
   never below 0 and a cut beyond the equitable share is flagged. Is the
   storage part to be written as a release or bypass condition?
8. **Q11 (confirm the decision):** engine 0.17.0 labels the equitable share
   a fairness benchmark, never a gain, with the footnote "Not an allocation or
   licence condition." Is a network-aware allocation on authorised volumes
   (NWA Schedule 3 item 6) wanted, and from which data (licences, WARMS)?
   (Q1 is resolved: engine 0.9.0.)
9. **B2:** are the flagged zero-rain runs on the client catchment missing
   data (engine 0.15.0 fills them from CHIRPS by default) or real dry spells
   (list them as keep-dry)? Are there other bad stretches to list as missing
   ([plan.md § Questions, *Zero-rain runs*](./plan.md#questions-for-the-client))?
10. **B4:** do the station's records (observer logs, "accumulated" flags in
    the source files) confirm which readings are multi-day totals? Engine
    0.20.0 spreads every reading its check flags; list a real one-day storm
    under keep-as-recorded, and a known unread stretch the check misses under
    also-spread. Where a flagged window reads far less than CHIRPS over it (a
    gauge left unread also loses water to evaporation and overflow), should
    its total be scaled up, or the days treated as missing instead?
11. **Q5 (confirm the decision):** irrigation stops at the dam's minimum
    operating level (dead storage), and transfers keep the higher of their own
    minimum and that level (engine 0.16.0). Which dams keep a reserve, and how
    much?
12. **A1–A7 (confirm the Reserve method, plan.md question 17):** built from
    the literature (model.md §2.9c, §2.9d), none signed off. Below a rule
    table's driest point, scale the requirement with the flow (as built) or
    hold it at the drought flow (A1)? Linear or log interpolation between %
    points (A2)? The natural percentile from the run (default) or the
    gazette's curve, and is ±15 % the right natural-MAR tolerance (A3)?
    Should the daily charge follow the rule table (A4)? Low flows on base
    flow, with which α and passes (A5)? How is a high-flow event found in
    daily flow (A6), and should events be capped by natural events, counted
    per water year, and checked against the DRM's high-flow volumes (A7)?

## References

- [Allen et al. 1998]: Allen, Pereira, Raes, Smith. *Crop evapotranspiration*. FAO Irrigation and Drainage Paper 56.
- [Beven 2012]: Beven. *Rainfall-Runoff Modelling: The Primer*, 2nd ed. Wiley.
- [Dastane 1974]: Dastane. *Effective rainfall in irrigated agriculture*. FAO Irrigation and Drainage Paper 25.
- [Green 1985]: Green. *Estimated irrigation requirements of crops in South Africa*. Memoirs on the Agricultural Natural Resources of South Africa 2, Soil and Irrigation Research Institute.
- [Gupta et al. 2009]: Gupta, Kling, Yilmaz, Martinez. Decomposition of the mean squared error and NSE performance criteria. *J. Hydrol.* 377.
- [Jakeman & Hornberger 1993]: How much complexity is warranted in a rainfall-runoff model? *Water Resour. Res.* 29 (IHACRES).
- [Keller & Bliesner 1990]: *Sprinkle and Trickle Irrigation*. Van Nostrand Reinhold.
- [Knoben et al. 2019]: Knoben, Freer, Woods. Inherent benchmark or not? Comparing NSE and KGE scores. *HESS* 23.
- [Lamb & Beven 1997]: Using interactive recession curve analysis to specify a general catchment storage model. *HESS* 1.
- [Liebe et al. 2005]: Liebe, van de Giesen, Andreini. Estimation of small reservoir storage capacities in a semi-arid environment. *Phys. Chem. Earth* 30.
- [Linsley et al. 1982]: Linsley, Kohler, Paulhus. *Hydrology for Engineers*, 3rd ed. McGraw-Hill.
- [Mantel & Hughes 2023]: Mantel, Hughes. Farm dams in South Africa: storage, surface area and mean depth (the median mean depth of minor dams is about 3 m). As cited in the persona hydrologist review, 2026-09-24; check the exact reference with the hydrologist.
- [Moriasi et al. 2007]: Model evaluation guidelines for systematic quantification of accuracy in watershed simulations. *Trans. ASABE* 50 (and Moriasi et al. 2015, *Trans. ASABE* 58).
- [Nash & Sutcliffe 1970]: River flow forecasting through conceptual models, part I. *J. Hydrol.* 10.
- [Perrin et al. 2003]: Perrin, Michel, Andréassian. Improvement of a parsimonious model for streamflow simulation (GR4J). *J. Hydrol.* 279.
- [Pushpalatha et al. 2012]: A review of efficiency criteria suitable for evaluating low-flow simulations. *J. Hydrol.* 420–421.
- [Tallaksen 1995]: A review of baseflow recession analysis. *J. Hydrol.* 165.
- [Teutschbein & Seibert 2012]: Bias correction of regional climate model simulations for hydrological climate-change impact studies: review and evaluation of different methods. *J. Hydrol.* 456–457.
- [Viney & Bates 2004]: Viney, Bates. It never rains on Sunday: the prevalence and implications of untagged multi-day rainfall accumulations in the Australian high quality data set. *Int. J. Climatol.* 24.
- [WR2012]: Bailey & Pitman. *Water Resources of South Africa 2012 Study*. Water Research Commission.

[Allen et al. 1998]: #references
[Beven 2012]: #references
[Dastane 1974]: #references
[Green 1985]: #references
[Gupta et al. 2009]: #references
[Jakeman & Hornberger 1993]: #references
[Keller & Bliesner 1990]: #references
[Knoben et al. 2019]: #references
[Lamb & Beven 1997]: #references
[Liebe et al. 2005]: #references
[Linsley et al. 1982]: #references
[Mantel & Hughes 2023]: #references
[Moriasi et al. 2007]: #references
[Nash & Sutcliffe 1970]: #references
[Perrin et al. 2003]: #references
[Pushpalatha et al. 2012]: #references
[Tallaksen 1995]: #references
[Teutschbein & Seibert 2012]: #references
[Viney & Bates 2004]: #references
[WR2012]: #references
