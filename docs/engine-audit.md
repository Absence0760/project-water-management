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
| **C1** | Medium (when calibrating to Pitman) | `run.ts:315` | **Pitman flow was scored against the impacted outflow.** Pitman flow is *naturalised*: modelled flow with no farms, dams or abstraction ([WR2012]). Comparing it with the simulated **outflow**, after irrigation and dam storage, scores the rain model against a record of a different quantity. | `run.test.ts` › "scores natural flow … against naturalised Pitman flow (audit C1)" | **Fixed.** Pitman is compared with `natural_flow`. Gauge and logger records measure the impacted river and are still compared with `simulated_outflow`. `CalibrationStats.simulatedKey` says which series was scored. |
| **H1** | **High** (structural) | `flow.ts:230-231` (reset), recession curve | **The rain model does not conserve water at the event scale.** When a storm's peak is above 1.5 × the receded base flow, the base flow resets to the peak and then recedes along the *slow* part of the curve. A single 10 mm winter storm on a dry catchment then returns **4.9×** its rain volume over the following year (the blank workbook's defaults, 205.1 km²), and 7.3× on 100 km². Small storms return relatively *more* than large ones (100 mm: 0.88×), which is the opposite of how catchments behave: runoff coefficients rise with storm depth and antecedent wetness ([Beven 2012]). Calibrated annual totals can still look plausible (the example catchments' run coefficients are 0.34–0.68), but only because the parameters compensate. | `run.test.ts` › "W1" (the 10 mm storm, coefficient > 1); the probe numbers above | **Needs hydrologist** (a model-structure change needs recalibration). **Recommendation:** make the event volume explicit and bounded (runoff = C(R, wetness) × R × area, with C ≤ 1), route it with a unit hydrograph or linear reservoirs, and feed baseflow through a recharge fraction into a slow store. Candidates are IHACRES ([Jakeman & Hornberger 1993]), GR4J ([Perrin et al. 2003]), or the planned bucket module (model.md §5) once its water-balance leak is fixed. **Guard shipped (W1):** each run reports its runoff coefficient and warns above 1. |
| **N1** | Medium | `demand.ts:55-56`, `simulate.ts:166-172` | **Irrigation efficiency and return flow don't add up.** Demand F is crop water use (A-pan × crop factor − effective rain). Supply G meets F, and `returnFlowPct × G` flows back the same day. So a fully "supplied" crop consumes only `(1 − r)·F`: with r = 10 % it is 10 % short of its requirement while the model reports 100 % supplied. In the usual formulation, abstraction = net requirement / application efficiency, and part of the losses returns ([Allen et al. 1998]; [Keller & Bliesner 1990]). | Worked example: F = 100, r = 0.1 → G = 100, T = 10, crop use = 90 | **Needs hydrologist.** **Recommendation:** add an application efficiency e per farm (or per crop). Abstraction demand = F / e, and return flow = a share of the losses `(1 − e)·G`. With e = 1 − r and all losses returning, the balance stays as it is but the crop is fully supplied. |
| **N2** | High (dam-dominated farms) | `simulate.ts:165-169` | **Dam evaporation and seepage are ignored.** A farm dam loses open-water evaporation, about 0.7–0.8 × Class-A pan ([Linsley et al. 1982]; WR90 gives monthly lake factors), which is 5–8 mm/day in a Western Cape summer. A 100 000 m³ dam with about 3 ha of surface loses roughly 150–240 m³/day, several % of its capacity per month, exactly when irrigation draws on it. The model overstates summer storage and supply. | Order-of-magnitude example above | **Needs hydrologist** and a data change (surface area). **Recommendation:** evaporation `E = k_lake × A-pan(month)/days × A(S)`, with a per-dam area–volume relation `A = c·S^b` (b ≈ 0.7 for small reservoirs, [Liebe et al. 2005]) or a full-supply area. Seepage as an optional fraction of storage per day. Both need new node fields (backend migration) and would change every dam result. |
| **N3** | Medium | `demand.ts:55-56` | **Effective rain is applied day by day with no carry-over.** The daily demand is a monthly average, and rain offsets only the day it falls on: a 60 mm day cancels one day of demand and the rest is lost. There is no soil-water store, so demand in the days after heavy rain is overstated, while light rain (≤ threshold) never counts (Q6). | Code read; `run.test.ts` › "offsets gross demand by effective rain" | **Needs hydrologist.** **Recommendation:** a root-zone soil-water balance ([Allen et al. 1998], FAO-56 ch. 8), or at least monthly effective rainfall ([Dastane 1974]) against monthly demand. Also confirm that the crop factors are **A-pan based** ([Green 1985]); FAO Kc values assume ET₀, which is about 0.7–0.85 × pan. |
| **N4** | Low | `simulate.ts:114` | **Transfers ignore the receiving dam's free space, and the source's irrigation comes second** (Q3). Water pumped into a full dam spills straight away, and the transfer is decided before the source irrigates. | Code read | **Needs hydrologist** (an operating rule). **Recommendation:** cap a transfer at the receiver's free space at the start of the day, `cap − Q[t−1]`. The source rule order is Q18. |
| **M1** | Low | `scripts/wbt-import/{calibration,extract_project}.py` | **Month lists were imported with the workbook's substring bug.** `FIND(m & ",", list & ",")` makes "11" also mean January and "12" February, and the importer copied that into the project. | `scripts/wbt-import/test_months.py` | **Fixed.** The importer keeps the months a list names and prints a `note:` when the workbook would have added others. Neither sample workbook's lists are affected. |
| **W1–W5** | Low | `run.ts`, `flow.ts`, `network/shares.ts` | Inputs that are physically impossible or silently patched gave no warning. | `run.test.ts` › "soundness warnings (audit W1–W5)" | **Fixed (warnings, no numeric change):** W1 runoff coefficient > 1 (H1); W2 days with no rainfall value, treated as dry; W3 a farm area ≠ hi + lo by more than 1 % (review F7; one warning per run from `quality.ts` `areaMismatches`, also in `RunSummary.dataQuality.areaMismatches`); W4 recession factors outside 0–1, a rising curve, or tables of different length; W5 days of natural flow taken from the Pitman fallback (Q7). |
| T1 | Low (tests) | `run.test.ts` | The skipped client catchment suite read its absent fixtures while vitest collected tests, which crashed `pnpm test` on any clone without `data/`. | `pnpm test` on main | **Fixed** (it now reports one skipped test). |

## Workbook quirks (model.md §3): decisions

| # | Decision in 0.4.0 |
| --- | --- |
| Q1 upstream "above dam" % drives the below-dam split | **Needs hydrologist.** Water is conserved either way; it is a question of what the parameter means. Worth noting: with 100 % (every client catchment farm), a farm can irrigate from upstream flow only through its divert capacity. Recommendation: rename the field after its effect, `pctUpstreamBypass` (the UI already calls it "Upstream bypass"), once confirmed. |
| Q2 transfer reads spill | Not mirrored (already). |
| Q3 transfer order / spill at the receiver | **Needs hydrologist**, see N4. |
| Q4 | Doc only. |
| Q5 irrigation may empty the dam | **Needs hydrologist** (an operating rule). Note that `node.damMinPct` isn't used by the engine; only `transfer.minStoragePct` is. |
| Q6 threshold on the demand offset | Defensible: small rains are mostly intercepted ([Dastane 1974]). See N3 for the larger issue. |
| Q7 Pitman fallback | **Warned (W5).** The trigger is "model gave 0", not "no rain data"; days without rain data are warned about separately (W2). Recommendation: fall back only on days with no rain value at all, and label the source per day. |
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
  flow). Blank observations are skipped, and a constant observation series
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
examples trips a new warning. **H1, N1, N2 and N3 are the findings that could
move results materially**, and all four wait for the hydrologist.

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
   (the recommendation above)? This needs recalibration.
2. **N1:** add irrigation application efficiency, and decide which share of
   the losses returns to the river?
3. **N2:** model dam evaporation (and seepage)? If yes, which area–volume data
   is available per dam?
4. **N3:** add soil-water carry-over for effective rainfall, or use monthly
   effective rain? Confirm the crop factors are A-pan based.
5. **N4 / Q3, Q18:** transfer operating rules: cap at the receiver's free
   space? Priority between rules?
6. **Q17:** how should an EWR shortfall be attributed to farms (pro rata to
   net impact, or assessed at gauges only)?
7. **Q1, Q5, Q11, Q13:** parameter meaning and curtailment policy, as listed.

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
- [Moriasi et al. 2007]: Model evaluation guidelines for systematic quantification of accuracy in watershed simulations. *Trans. ASABE* 50 (and Moriasi et al. 2015, *Trans. ASABE* 58).
- [Nash & Sutcliffe 1970]: River flow forecasting through conceptual models, part I. *J. Hydrol.* 10.
- [Perrin et al. 2003]: Perrin, Michel, Andréassian. Improvement of a parsimonious model for streamflow simulation (GR4J). *J. Hydrol.* 279.
- [Pushpalatha et al. 2012]: A review of efficiency criteria suitable for evaluating low-flow simulations. *J. Hydrol.* 420–421.
- [Tallaksen 1995]: A review of baseflow recession analysis. *J. Hydrol.* 165.
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
[Moriasi et al. 2007]: #references
[Nash & Sutcliffe 1970]: #references
[Perrin et al. 2003]: #references
[Pushpalatha et al. 2012]: #references
[Tallaksen 1995]: #references
[WR2012]: #references
