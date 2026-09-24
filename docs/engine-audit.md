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
  multiple-outlet check.
- **Method:** each finding has a failing test first, then the fix. Decisions
  that need hydrological or policy judgement are marked **Needs hydrologist**,
  with a recommendation, and the engine's behaviour for them is unchanged.
- **Policy** (CLAUDE.md rule 10, [STACK.md](./STACK.md)): engine correctness is
  judged by documented hydrology and the invariant tests. The client catchment
  regression suite records where results differ from the workbook, and why
  ([§ Regression suite](#regression-suite-deviation-list)).

## Findings

Severity is the effect on results a user would act on. File:line refers to
engine 0.4.0.

| ID | Severity | Where | Finding | Evidence | Decision |
| --- | --- | --- | --- | --- | --- |
| **E1** | Medium | `flow.ts:207-215` | **Day 1 of every run recedes at an extrapolated factor.** The workbook's reserved row fills in only the base flow and leaves its recession index blank (0). Day 1 therefore recedes at `2·f1 − f2`: 0.114 with the default curve, so 300 m³/day becomes 34 m³/day, an 89 % drop. When `f2 > 2·f1` the factor is negative, the base flow goes to −30 m³/day, and it **stays negative for the whole run**, because `rain / negative base` is never above the 1.5 reset ratio. The blank pulse index also made a first-day storm take the base index. | `flow.test.ts` › "day-1 state (audit E1)" (3 tests) | **Fixed.** The day before the run is a steady base-flow state: base = resultant = `BaseFlowInitial`, and every index is that flow's own position on the curve. A master recession curve describes recession as a function of the current flow alone ([Tallaksen 1995]; [Lamb & Beven 1997]), so the steady state is that flow's own index. |
| **E2** | Low | `flow.ts:91` | A pulse index below 1 (`ShiftPeakIndexLo` = 0.9) extrapolates below the first factor. With a steep table head this can be negative, which would make the flow negative. | `flow.test.ts` › "recede (audit E2)" | **Fixed.** The factor is clamped at 0. A recession can shrink a flow to nothing, never below. This changes nothing where the factor is ≥ 0, including the default table (0.2409 at index 0.9). |
| **R1** | Medium | throughout; decision on engine review **F5** | **Rounding does not belong in the model state.** The workbook rounds almost every column, and it matters in three ways. (a) A receding flow stops once `flow × (1 − f) < 0.5`, so every recession stops at a floor of about `0.5 / (1 − f)`: 32 m³/day for the default tail factor 0.9845, however long the drought lasts. That is exactly the low-flow regime the EWR is about. (b) Splitting a flow creates or destroys water: with 4 equal farms, a natural flow of 2 m³/day gives 4 m³/day of runoff (`ROUND(0.5)` = 1 each), and 1 m³/day gives 0. (c) Small quantities vanish: a 0.4 m³ dam became "no dam", and rounding a fractional inflow split drove supply negative (found earlier by the fuzz tests). There were also two different `excelRound` implementations (F5). | `flow.test.ts` › "no rounding in the model state (audit R1)"; `run.test.ts` › "no rounding in the balance (audit R1)" | **Fixed.** The engine keeps full float64 precision everywhere: rain flow (no `INT`), recession and indices, demand chain, fragments, dam splits, return flow, capacity, initial storage, transfer cap, the observed-flow conversion, and every `[Shortfalls]` column (no `ROUND` / `ROUNDDOWN`; closes Q14 and Q15). Presentation (UI, exports) rounds for display. One Excel `ROUND` remains in `network/round.ts` (the 15-significant-digit version), used only by tests that replay workbook cells. In curtailment, float cancellation noise below 1e-12 relative is reported as 0, so a farm already at its equitable share doesn't show a gain of 1e-16 m³/day. |
| **G1** | Medium (networks with a confluence gauge) | `network/simulate.ts:147` | **A gauge's shortfall was the sum of its branches' shortfalls.** The gauge sheet sets `I = Σ upstream AA`. When one branch is 100 m³/day short and another has 100 spare, the confluence's flow meets its EWR, but the gauge reported −100, and a farm below it read that value into its own incremental shortfall. | `run.test.ts` › "EWR at a confluence gauge (audit G1)" | **Fixed.** A gauge's shortfall is `MIN(ΣU − ΣZ, 0)`, which is the same definition as a farm's AA and as the outlet series. A gauge with one upstream element is unchanged. How farm shortfalls are *attributed* (AB) is still Q17. |
| **C1** | Medium (when calibrating to Pitman) | `run.ts:315` | **Pitman flow was scored against the impacted outflow.** Pitman flow is *naturalised*: modelled flow with no farms, dams or abstraction ([WR2012]). Comparing it with the simulated **outflow**, after irrigation and dam storage, scores the rain model against a record of a different quantity. | `run.test.ts` › "scores natural flow … against naturalised Pitman flow (audit C1)" | **Fixed.** Pitman is compared with `natural_flow`. Gauge and logger records measure the impacted river and are still compared with `simulated_outflow`. `CalibrationStats.simulatedKey` says which series was scored. **Superseded by P1 (engine 0.10.0):** Pitman is no longer a calibration record, so every record is scored against `simulated_outflow`. |
| **H1** | **High** (structural) | `flow.ts:230-231` (reset), recession curve | **The rain model does not conserve water at the event scale.** When a storm's peak is above 1.5 × the receded base flow, the base flow resets to the peak and then recedes along the *slow* part of the curve. A single 10 mm winter storm on a dry catchment then returns **4.9×** its rain volume over the following year (the blank workbook's defaults, 205.1 km²), and 7.3× on 100 km². Small storms return relatively *more* than large ones (100 mm: 0.88×), which is the opposite of how catchments behave: runoff coefficients rise with storm depth and antecedent wetness ([Beven 2012]). Calibrated annual totals can still look plausible (the example catchments' run coefficients are 0.34–0.68), but only because the parameters compensate. | `run.test.ts` › "W1" (the 10 mm storm, coefficient > 1), "H1: every legacy run carries LEGACY_NOT_EVIDENCE …"; `runoff/event-scale.test.ts` › the exemption-vs-warning consistency check; the probe numbers above | **Decided (persona recommendation, 2026-09-24; pending the hydrologist): legacy kept unchanged as workbook comparison only; GR4J is the model of record.** No numeric change and no `ENGINE_VERSION` bump — the fix below is a model-structure change that still needs recalibration and the hydrologist's own sign-off. In the meantime every legacy run carries a `LEGACY_NOT_EVIDENCE: …` warning (`run.ts`), shown in the app as an amber "Workbook comparison" badge (Runs list, run header, the runoff-model picker's "Legacy (b023 workbook, comparison only)" option, a note in run comparison, and on legacy fit records in FitProvenance) and as a leading `# runoff_model=legacy; …` comment on every CSV a legacy run exports. **Recommendation (the durable fix):** make the event volume explicit and bounded (runoff = C(R, wetness) × R × area, with C ≤ 1), route it with a unit hydrograph or linear reservoirs, and feed baseflow through a recharge fraction into a slow store. Candidates are IHACRES ([Jakeman & Hornberger 1993]), GR4J ([Perrin et al. 2003]), or the planned bucket module (model.md §5) once its water-balance leak is fixed. **Guard shipped (W1):** each run reports its runoff coefficient and warns above 1. **Proposed fix:** [issue #4](https://github.com/Absence0760/project-water-management/issues/4) (GR4J behind a model interface, with hard event-scale and per-store balance invariants). **Status (engine 0.5.0):** GR4J is selectable (`settings.runoffModel = 'gr4j'`, model.md §2.4a). It passes the event-scale invariant (`testing/runoff.ts` `checkEventScale`) and closes its balance every day. Legacy stays selectable, and stays exempt from that check by name — now exactly the models that carry `LEGACY_NOT_EVIDENCE` (`runoff/event-scale.test.ts`) — until the hydrologist's own sign-off (issue #4 phase 6). **Engine 0.11.0:** GR4J is the default; legacy stays selectable (and exempt) for comparison with the workbook. |
| **N1** | Medium | `demand.ts:55-56`, `simulate.ts:166-172` | **Irrigation efficiency and return flow don't add up.** Demand F is crop water use (A-pan × crop factor − effective rain). Supply G meets F, and `returnFlowPct × G` flows back the same day. So a fully "supplied" crop consumes only `(1 − r)·F`: with r = 10 % it is 10 % short of its requirement while the model reports 100 % supplied. In the usual formulation, abstraction = net requirement / application efficiency, and part of the losses returns ([Allen et al. 1998]; [Keller & Bliesner 1990]). | Worked example: F = 100, r = 0.1 → G = 100, T = 10, crop use = 90. `run.test.ts` › "irrigation efficiency and loss return (audit N1)" (F = 100, e = 0.9 → G ≈ 111.1, crop use 100; β share of losses; deficit and fraction against D; e = 1, β = 0 bit for bit; a legacy model runs as migrated) | **Decided (persona recommendation, 2026-09-24; pending the hydrologist) — engine 0.15.0.** Per farm `irrigationEfficiency` e (0 < e ≤ 1) and `lossReturnFraction` β (0–1). Per day: `D = F / e`; `G = MIN(available, D)`; crop use `e·G`; return `T = β(1 − e)·G` to the river the same day (replacing `returnFlowPct × G`); consumptive use `G − T`; supplied fraction `G / D`; deficit `W = D − G`; curtailment works in D and G. F and D are both run series (`crop_requirement`, `demand`). The balance V = (H + I + J) − (G − T) − ΔQ − U keeps its form. Migration 006 backfilled from r = `return_flow_pct` (r = 0 → e = 1, β = 0, bit-identical; r > 0 → e = 1 − r, β = 1: the crop is now fully supplied and abstraction rises by 1/(1 − r); r = 1 → e = 0.01) and **dropped `return_flow_pct`** (never deployed); `upgradeLegacyModel` maps older documents and run snapshots the same way. New farms default to e = 0.80, β = 0.5; the one-node form has an indicative system helper (drip 0.90, micro 0.85, pivot 0.85, sprinkler 0.75, flood 0.65). The "upstream farm helps a starved neighbour via return flow" effect is real under N1 (bounded by G ≤ D); attribution by net consumptive use handles it (Q17, separate task). |
| **N2** | High (dam-dominated farms) | `simulate.ts:165-169` | **Dam evaporation and seepage are ignored.** A farm dam loses open-water evaporation, about 0.7–0.8 × Class-A pan ([Linsley et al. 1982]; WR90 gives monthly lake factors), which is 5–8 mm/day in a Western Cape summer. A 100 000 m³ dam with about 3 ha of surface loses roughly 150–240 m³/day, several % of its capacity per month, exactly when irrigation draws on it. The model overstates summer storage and supply. | Order-of-magnitude example above. `run.test.ts` › "dam evaporation and seepage (audit N2)" (100 000 m³, 3 ha, 6 mm/day = 180 m³/day; area follows storage; rain on the dam before the threshold; seepage joins the outflow; never below empty; the capacity ÷ 3 m estimate and W6; no dam unaffected); `run.invariants.test.ts` › "catches dam evaporation, rain on the dam or seepage that does not follow the dam"; on the client catchment "N2: with the estimated dam areas every self-check passes" | **Decided (persona recommendation, 2026-09-24; pending the hydrologist) — engine 0.15.0.** Per dam per day, before irrigation (after the day's transfers): surface `A = A_full·(Q[t−1]/cap)^b`, `b` = `damAreaExponent` (default 0.7, [Liebe et al. 2005]); evaporation `E = k_lake·Apan[month]/daysInMonth/1000·A` with `settings.lakeEvapFactor` k_lake (default **0.75**, an A-pan factor; the WR90/WR2012 lake factors are S-pan based and must not be applied to A-pan directly); rain on the dam `Pd = rain·A/1000` (the day's rain before any threshold); seepage `Sp = damSeepagePerDay·Q[t−1]` (default 0), which joins the farm's outflow U the same day. Clamped so storage stays ≥ 0 (E ≤ Q[t−1] + Pd + J, Sp ≤ what is left). New node fields `dam_area_full_m2` (nullable), `dam_area_exponent` (0.7), `dam_seepage_per_day` (0) in migration 006. An unknown area is estimated as capacity ÷ 3 m ([Mantel & Hughes 2023], median mean depth of SA minor dams) and the run warns (**W6**) naming how many dams used it. New series `dam_area`, `rain_on_dam`, `dam_evaporation`, `dam_seepage`; the balance V = (H + I + J + Pd) − (G − T) − E − ΔQ − U and the water balance (rain on dams in, dam evaporation out) include them, and `checkWorkings` recomputes all four from the settings and `rain_final`. A farm with no dam (cap 0) is unaffected. The land runoff model's area includes the dam surfaces, so rain on a dam is partly counted twice (small for farm dams; flagged for the hydrologist). |
| **N3** | Medium | `demand.ts:55-56` | **Effective rain is applied day by day with no carry-over.** The daily demand is a monthly average, and rain offsets only the day it falls on: a 60 mm day cancels one day of demand and the rest is lost. There is no soil-water store, so demand in the days after heavy rain is overstated, while light rain (≤ threshold) never counts (Q6). | Code read; `demand.test.ts` › "farmDailyDemand … (N3)"; `run.test.ts` › "soil-water store (N3, engine 0.14.0)" and, on the client catchment, "N3: the soil-water store only lowers demand …"; `verify.test.ts` › "catches a soil-water store that overflows …" | **Decided (persona recommendation, 2026-09-24; pending the hydrologist), engine 0.14.0.** A simulated hydrologist recommended a root-zone soil-water balance ([Allen et al. 1998], FAO-56 ch. 8) over monthly effective rainfall ([Dastane 1974]), and the engine now carries effective rain over through one store per farm, a one-bucket form of it: Pe is added to the store, the day's gross demand is met from store + Pe first (so a big rain still covers its own day, as before), and what is left is kept up to `settings.effectiveRainStoreMm`; the excess drains or runs off, water the runoff model already counts. Default **25 mm** = 0.5 × 100 mm/m × 0.5 m, the readily available water of 0.5 m of roots in a 100 mm/m soil (FAO-56 Tables 19 and 22). **0 mm reproduces the workbook bit for bit** (tested). Demand stays precomputed, independent of supply, so `network/simulate.ts` only carries the new working column. The farm's `effective_rain` column is now the rain *used* that day and `soil_water` the store at the end of the day (mm); a new self-check, `soilWater`, holds the store within 0 … size and Σ used ≤ Σ Pe (model.md §2.3 step 4, §6). The crop factors are confirmed to multiply **A-pan** (`grossCropMm`), not ET₀ (about 0.7–0.85 × pan, [Green 1985]); the Crops tab now says "× A-pan, not FAO Kc" and flags a factor above 1.0 as a hint. **For the hydrologist:** confirm the approach and the size (per soil and root depth), or set 0. |
| **N4** | Low | `simulate.ts:114` | **Transfers ignore the receiving dam's free space, and the source's irrigation comes second** (Q3). Water pumped into a full dam spills straight away, and the transfer is decided before the source irrigates. | Code read | **Needs hydrologist** (an operating rule). **Recommendation:** cap a transfer at the receiver's free space at the start of the day, `cap − Q[t−1]`. The source rule order is Q18. |
| **M1** | Low | `scripts/wbt-import/{calibration,extract_project}.py` | **Month lists were imported with the workbook's substring bug.** `FIND(m & ",", list & ",")` makes "11" also mean January and "12" February, and the importer copied that into the project. | `scripts/wbt-import/test_months.py` | **Fixed.** The importer keeps the months a list names and prints a `note:` when the workbook would have added others. Neither sample workbook's lists are affected. |
| **W1–W5** | Low | `run.ts`, `flow.ts`, `network/shares.ts` | Inputs that are physically impossible or silently patched gave no warning. | `run.test.ts` › "soundness warnings (audit W1–W5)" | **Fixed (warnings, no numeric change):** W1 runoff coefficient > 1 (H1); W2 days with no rainfall value, treated as dry; W3 a farm area ≠ hi + lo by more than 1 % (review F7; one warning per run from `quality.ts` `areaMismatches`, also in `RunSummary.dataQuality.areaMismatches`); W4 recession factors outside 0–1, a rising curve, or tables of different length; W5 days of natural flow taken from the Pitman fallback (Q7; removed with the fallback in engine 0.10.0, P1). |
| **B1** | High (catchments with gaps in the catchment rain) | `run.ts` `prepareRun`, `rain.ts` (engine 0.7.0) | **CHIRPS fills gaps in the catchment rain without bias correction.** Rain used (column R) falls back to raw CHIRPS on every day the catchment rain is blank. At catchment scale CHIRPS can read a fraction of the catchment's gauges, by different amounts in different seasons. On the client catchment it reads well under catchment rain overall and less than half of it in the winter (wet-season) months, so a fallback year runs far too dry. GR4J, which conserves water, then makes almost no flow in those years, and they dominated the EWR-failure difference between the models in the hydrologist's review of issue #4 phase 6 (condition 1 for adopting GR4J). | `rain.test.ts` (known factors, minimum-sample fallback, flagged years excluded, catchment and forecast rain untouched, no CHIRPS → no-op, skewed TZ, GR4J balance still closes); `run.test.ts` › "B1: changes CHIRPS only on the fallback days" (client catchment) | **Fixed.** CHIRPS used as fallback is scaled by a per-calendar-month factor Σ catchment / Σ CHIRPS over the days both have a reading, leaving out the water years the issue #2 checks flag. A month with fewer than 90 shared days or 50 mm of CHIRPS takes the pooled factor; with no pooled factor CHIRPS stays raw and the run warns. Factors are clamped to 0.25–4. Catchment and forecast rain are unchanged. Linear scaling per month ([Teutschbein & Seibert 2012]). Rules and reasons: [model.md §2.4b](./model.md#24b-chirps-fallback-bias-correction). It changes both runoff models and irrigation demand, so the regression suite names B1 (below). A setting, `chirpsBiasCorrection: 'monthly' \| 'none'` (default `'monthly'`), turns it off for a CHIRPS series that is already corrected; this is not a workbook-compatibility mode (model.md §2.4b, "Why a setting"). |
| **P1** | Medium (projects with a Pitman series) | `flow.ts`, `run.ts`, `calibrate/calibrate.ts`, `project.ts` (engine 0.10.0) | **Pitman flow mixed a second model into the run.** [Flow data] AB fell back to the Pitman column whenever the rain model gave 0 (Q7), so one natural-flow series could hold two models' output; a Pitman series also set the run period on its own, and could be chosen as the calibration record (then scored against natural flow, C1). The Pitman column is monthly modelled flow repeated daily, not a measurement: it can't calibrate a daily model, and as a fallback it hides the days the rain model gives nothing. | `flow.test.ts` › "no Pitman fallback (… audit P1)"; `run.test.ts` › "P1: natural flow never falls back …", "needs a rainfall series …", "calibrates against the configured flow record" (a stored Pitman choice falls back with a warning); `settings.test.ts` | **Removed (operator decision, 2026-09-24).** `flow_pitman_m3s` is no longer a series kind or a calibration record; natural flow comes only from the runoff model, and only rainfall sets the run period. The importer skips [Flow data] column F (with a note), and a workbook whose `rUseFlow` picks Pitman gets a `WARNING` and no `calibrationFlowKind`. A stored Pitman series or choice from an older engine is ignored with a warning, never an error. The client catchment's Pitman column is empty, so none of its results change. A naturalised-flow reference, if one is wanted later, belongs with the WR2012 check (model.md §2.10c) as a comparison, not as an input. |
| T1 | Low (tests) | `run.test.ts` | The skipped client catchment suite read its absent fixtures while vitest collected tests, which crashed `pnpm test` on any clone without `data/`. | `pnpm test` on main | **Fixed** (it now reports one skipped test). |

## Workbook quirks (model.md §3): decisions

| # | Decision in 0.4.0 |
| --- | --- |
| Q1 upstream "above dam" % drives the below-dam split | **Fixed (engine 0.9.0, client decision 2026-09).** The percentage is the share of upstream inflow that enters the dam, as the label, the `[Models]` sheet and the Pitman/WRSM farm-dam convention have it; the workbook's formula was backwards. No rename needed: `pct_upstream_to_dam` now means what it says. The UI calls it "Upstream inflow to dam". |
| Q2 transfer reads spill | Not mirrored (already). |
| Q3 transfer order / spill at the receiver | **Needs hydrologist**, see N4. |
| Q4 | Doc only. |
| Q5 irrigation may empty the dam | **Decided (persona recommendation, 2026-09-24; pending the hydrologist) — engine 0.15.0.** `node.damMinPct` is the dam's minimum operating level (dead storage): `G = MIN(MAX(avail − cap·damMinPct, 0), F)` with `avail = Q[t−1] + M + O + K + J`, and a transfer keeps `cap × MAX(rule minStoragePct, damMinPct)` in its source. Migration 006 reset every stored value to 0 (the importer had filled it with the workbook's transfer minimum, which each rule already carries), so no existing result changes; the importer writes 0 and notes the workbook value. The editor flags a dam with a 0 floor as a hint ("irrigation may empty this dam"), not an error. Tests: `run.test.ts` › "irrigation stops at the minimum operating level", "keeps the source dam's minimum operating level"; `checkWorkings` checks the G formula and `checkTransferLimits` the reserve. |
| Q6 threshold on the demand offset | Defensible: small rains are mostly intercepted ([Dastane 1974]). The larger issue, no carry-over, is N3: decided on a persona recommendation (engine 0.14.0, soil-water store), pending the hydrologist. The threshold still applies before the store. |
| Q7 Pitman fallback | **Removed (P1, engine 0.10.0).** Natural flow comes only from the runoff model. Days without rain data are still warned about (W2). |
| Q8 hi/lo over listed farms | Sound (the shares are normalised); W3 catches area drift. |
| Q9, Q10 | Settings; no engine change. |
| Q11 equitable target ignores the network | **Needs hydrologist** (policy). Recommendation: present "gain" as a fairness target only, and later compute a feasible, network-aware redistribution (licences, planned-work). |
| Q12 label | UI wording only; the engine field is `fractionOfDemandLeft`. |
| Q13 EWR cut on a farm with no demand | **Needs hydrologist** (policy). |
| Q14 K_tot from rounded averages | **Fixed (R1).** |
| Q15 l/s truncated | **Fixed (R1).** |
| Q16 | Workbook-only. |
| Q17 incremental shortfalls don't add up | **Needs hydrologist.** The gauge part is fixed (G1); AB attribution is unchanged. Recommendation: attribute the shortfall at each EWR site to the farms upstream of it in proportion to their net impact `(H + I + J) − U` (consumption plus storage gain), so the parts add up to the site's shortfall and a farm that adds water isn't charged. The alternative is to assess the EWR only at gauges. Either choice changes every farm's curtailment. |
| Q18 several transfers from one dam | Overdraw fixed earlier (rule order). The priority rule (order vs pro rata) is still **Needs hydrologist**. |

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
- **Season switch (fSorW2):** an empirical wetting-up rule. Once a big storm has
  wet the catchment, it responds as in winter until the next summer month.
  Defensible as antecedent-moisture switching; its thresholds are calibration
  parameters.
- **Master recession curve and max(response, base):** flow recedes by its
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
  regression.
- **Division guards (engine review F6):** flat curve segment, amplitude 0,
  receded base 0: kept.
- **Curtailment formulas:** a correct equitable (proportional) share of the
  water actually supplied. The policy questions are Q11 and Q13.

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

E1 shows up as a day-1 difference of 261 m³/day (295 vs 34). None of the
examples trips a new warning.

**B1 (engine 0.7.0).** The example catchments have no CHIRPS series, so their
results don't change. On the client catchment the fit finds a factor for
every calendar month from its own sample, leaves out the water years the
issue #2 checks flag, and clamps none. The factors are largest in the
winter (wet-season) months and close to 1 in summer, where one month is
slightly below 1, so the correction is not a flat scaling. Every fallback day is corrected,
and the fallback rain roughly doubles. Natural flow rises in the fallback
years with both models, more with GR4J than with legacy, and the days the
EWR is not met fall with both, again more with GR4J. The calibration window
holds no fallback days, so the calibration statistics don't change. (The
client values are not recorded here: the repo is public.) **H1, N1, N2 and N3 are the findings that could
move results materially.** H1 waits for the hydrologist (legacy is kept as a
workbook comparison only); N3 (engine 0.14.0) and N1 and N2 (engine 0.15.0)
are implemented on a persona recommendation the hydrologist still has to
confirm, see below.

## Regression suite: deviation list

`packages/engine/src/run.test.ts` and `flow.test.ts` now compare with the
workbook column by column, under a rule that names the finding:

- **exact:** season flag, rain used, catchment EWR.
- **per-day bound from the dropped ROUND steps (R1):** demand (0.55 + cropped
  m² × 0.005 / 1000 / 28), runoff and EWR share (0.5), cumulative EWR (0.5 per
  farm at or above the node), and rain-added flow (INT: 0 ≤ Δ < 1).
- **whole-run mean within 1 % + 1 m³/day (R1 through the state):** supplied,
  deficit, inflow, transfer, storage, spill, outflow, farm shortfalls, and the
  catchment outflow and EWR-not-met series.
- **water-year volume within 2 % + days × (rounding floor + 1) (E1, R1):**
  natural flow, end to end.
- **G1:** a confluence gauge's shortfall, and the AB of a farm directly below
  one, are checked against the new definition instead.
- **B1 (engine ≥ 0.7.0):** on the days CHIRPS stands in for blank catchment
  rain, the engine bias-corrects it and the workbook doesn't.
  - *Demand* keeps its R1 per-day bound on every other day and is not
    compared on those days (its effective-rain offset uses the corrected
    rain).
  - *Natural flow end to end* is compared with the correction **off**
    (`chirpsBiasCorrection: 'none'`, the workbook's rain used), where every
    water year must stay within the E1/R1 bound. With it on, only water years
    that hold fallback days may leave that bound.
  - A separate test checks that, with the correction on, CHIRPS changes on
    exactly the fallback days, by exactly the month's factor, and that
    catchment rain doesn't change.
  - The mean columns fed by demand (supplied, deficit, inflow, storage,
    spill, outflow, shortfalls) stay within their R1 bound with it on.
  - `flow.test.ts` feeds `computeNaturalFlow` the workbook's own rain
    columns, so B1 (applied in `prepareRun`) doesn't reach it and rain used
    stays exact there.
- **P1 (engine ≥ 0.10.0):** no Pitman fallback, so natural flow (AB) would also
  differ on any day the workbook took its Pitman column. The client catchment's
  Pitman column is empty, so no column is affected there; a workbook with
  Pitman values would need those days listed here.
- **N3 (engine ≥ 0.14.0):** effective rain carries over through a soil-water
  store (default 25 mm), which the workbook doesn't have, so demand and
  everything fed by it (supplied, deficit, storage, spill, outflow, the EWR
  shortfalls, curtailment) differ on the days after rain. The suite replays
  the workbook with `effectiveRainStoreMm: 0`, which is bit for bit the
  workbook's rule, so every rule above still applies unchanged. A separate
  test runs the default store on the client catchment: demand is identical
  on every day the store starts empty, never higher on any other day, lower
  on some, and every self-check passes.
- **Q5 (engine ≥ 0.15.0):** the replay sets every `damMinPct` to 0, as
  migration 006 does (the workbook's column is the transfer minimum), so no
  column differs.
- **N1 (engine ≥ 0.15.0):** the workbook's return flow % r runs as
  efficiency 1 − r with every loss returning (migration 006). Workbook F is
  compared with `crop_requirement` (the daily R1 bound). On every farm with
  r > 0, every node downstream of one, and both ends of a transfer touching
  one (`n1Affected`), supplied, deficit, inflow_upstream, transfer,
  dam_storage, spill, outflow, ewr_shortfall and ewr_shortfall_incremental
  are skipped, and so are the catchment outflow and EWR-not-met series when
  the outlet is among them. On the client catchment that is nearly every farm,
  so from 0.15.0 the suite checks the network's routing mainly through the
  runoff, EWR and crop-requirement columns and the invariants.
- **N2 (engine ≥ 0.15.0):** the replay gives every dam an area of 0 m² and no
  seepage, which is the workbook's dam bit for bit, so no column is listed
  for it. A separate test runs the estimated areas on the client catchment:
  every self-check passes, the dams evaporate, W6 counts them and the total
  dam storage is lower.
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

1. **H1:** replace the base-flow reset with a volume-conserving event response
   (the recommendation above)? This needs recalibration. **Interim decision
   (persona recommendation, 2026-09-24):** legacy stays unchanged, labelled
   workbook comparison only — not evidence — with GR4J as the model of
   record; still pending the hydrologist's own sign-off.
2. **N1 (confirm the decision):** abstraction = crop requirement ÷
   application efficiency e per farm, with a share β of the losses returning
   the same day (engine 0.15.0; new farms e = 0.80, β = 0.5; old return flow r
   became e = 1 − r, β = 1). Are the defaults and the per-system values right
   for the catchment, and should e be per crop instead of per farm?
3. **N2 (confirm the decision):** engine 0.15.0 evaporates k_lake × A-pan from
   each dam's surface (A = A_full × (S/cap)^0.7, k_lake = 0.75 A-pan based),
   adds the rain on it, and seeps an optional fraction of storage into the
   outflow; an unknown area is capacity ÷ 3 m (W6). Which dams have surveyed
   areas (or area–volume curves), is 0.75 × A-pan right for the region, and
   should the land runoff area exclude the dam surfaces?
4. **N3:** engine 0.14.0 carries effective rain over through a one-bucket
   soil-water store (25 mm by default), on a simulated hydrologist's
   recommendation. Confirm the approach and the store size for the catchment's
   soils and root depths (0 turns it off). The crop factors are A-pan based in
   the code; confirm the client's factors were derived against A-pan.
5. **N4 / Q3, Q18:** transfer operating rules: cap at the receiver's free
   space? Priority between rules?
6. **Q17:** how should an EWR shortfall be attributed to farms (pro rata to
   net impact, or assessed at gauges only)?
7. **Q11, Q13:** curtailment policy, as listed. (Q1 is resolved: engine 0.9.0.)
8. **Q5 (confirm the decision):** irrigation stops at the dam's minimum
   operating level (dead storage), and transfers keep the higher of their own
   minimum and that level (engine 0.15.0). Which dams keep a reserve, and how
   much?

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
[WR2012]: #references
