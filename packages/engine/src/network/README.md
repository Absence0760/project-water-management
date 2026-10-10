# Network water balance (b023 port)

Everything downstream of catchment natural flow: fragmentation, irrigation
demand, transfers, farm dams, routing, EWR shortfalls and calibration
statistics. Natural flow itself comes from the selected runoff model in `../runoff/` (legacy: `../flow.ts`). Entry point:
`runModel` in `../run.ts`.

Up to engine 0.3.1 `run.test.ts` reproduced every daily value on every
Element sheet of the client catchment b023 workbook, over its whole record,
exactly. From 0.4.0 the engine deliberately differs where the
workbook's algorithm is unsound ([docs/engine-audit.md](../../../../docs/engine-audit.md)):
the regression test keeps an explicit, commented deviation list per column,
each entry naming the audit finding.

**No rounding.** The workbook rounds fragmented flows, dam splits, return flow,
capacity, storage and demand to fixed precisions; the engine keeps full
precision everywhere (audit R1). `round.ts` only serves tests that replay
workbook cells.

## Files

| File | b023 source | What it does |
| --- | --- | --- |
| `topology.ts` | [Network] | Orders nodes upstream-first from `downstreamNodeId`. Throws on cycles, unknown links and more than one outflow node. |
| `shares.ts` | [Farm spec] "Selected fragmentation" | Each farm's share of natural flow and EWR (area / hiLo / manual). Warns if the shares don't sum to 1 ±0.0002. |
| `../demand.ts` | [Crop demand], [Farm demand], [Irrigation Demand] | Gross and net irrigation demand. |
| `simulate.ts` | Element sheets (FarmTemplate/GaugeTemplate row 17), [Transfers], [Fragmented flow], [Fragmented EWR] | The daily loop. |
| `stats.ts` | [Flow Calibration Cfg] | Calibration statistics over the calibration window: NSE, PBIAS, RMSE, KGE (r, α, β), R², log-NSE, volume error, annual volumes (no Moriasi rating words on daily scores, CR-6). |
| `curtailment.ts` | [Shortfalls] | Per-farm target volume, reduce/gain, the EWR charge and its irrigation / storage split, and total change (m³/day, l/s) over the reporting window, plus the EWR sites table → `RunSummary.curtailment`. |
| `reliability.ts` | – (an experimental node-based workbook's stress classes, model.md §4) | Assurance of supply per farm and user (time-based, volumetric, annual; resilience and vulnerability), stress classes per water-year month, and the water account per water year → `RunSummary.supplyAssurance` (engine ≥ 0.32.0, WP-3.4, docs/model.md §2.11a–b). |
| `ewr.ts` | [EWR shortfalls Pivot Data] | Water-year × month EWR compliance grid (days not met, shortfall m³) for the outlet and each farm (from engine 0.17.0 the farm's EWR charge). |
| `attribution.ts` | – (replaces the use of Element sheet AB) | Who is charged for an EWR shortfall (engine ≥ 0.17.0, audit Q17): each EWR site's (outlet, gauges) shortfall pro rata to the upstream farms' net impact, the natural remainder, each farm's largest charge and its irrigation part. docs/model.md §2.7b. |
| `users.test.ts` | – | Other water users (WP-1.33, docs/model.md §2.7c), hand-worked. |
| `boreholes.ts` | – | A node's boreholes resolved for the plan (WP-1.34, docs/model.md §2.7d); `simulate.ts` pumps and depletes. |
| `demandObjects.ts` | – (a workbook's demand-object register, issue #54 item 2b) | A unit's non-crop demands (town, domestic, livestock, piped out) resolved for the plan: each one's daily demand, return share and priority class, and the split of the unit's supply between its crops and its objects (engine ≥ 1.7.0, docs/model.md §2.7f). |
| `demandSchedule.ts` | – (issue #90 Q4, Q12) | A demand object's schedule: recurring date windows (every day, a yearly span, a one-off range, days around Easter; optionally on some weekdays) with a factor on its demand, 0 = off; the later of two overlapping windows wins (engine ≥ 1.17.0, docs/model.md §2.7f). |
| `dam.ts` | – | Dam survey curves (area linear in volume), release rules and the seepage destination, resolved for the plan and read by the self-checks (WP-3.5, docs/model.md §2.7a); `simulate.ts` applies them. |
| `landcover.ts` | – | Land-cover streamflow reductions (WP-1.35, docs/model.md §2.5a): patches per farm, the Q75 low-flow threshold, the day's reduction of the farm's runoff. |
| `round.ts` | – | Excel `ROUND` / `ROUNDDOWN`, for tests that replay workbook cells only. |

## Daily farm balance

FarmTemplate columns, per day *t*, with `Qprev` = yesterday's storage (the
initial storage on day 0). Since engine 0.12.0 every column is a run series:
the working ones (K–P, S, T, V, plus `gross_demand`, `effective_rain` and
`soil_water` behind F) are recorded when `simulateNetwork` is called with
`{ workings: true }`, as `runModel` does and calibration doesn't. The same
letters and formulas are in `../verify/columns.ts`, which the exports and the
day trace read.

| Col | Output key | Formula |
| --- | --- | --- |
| F | `crop_requirement` | crop water requirement, the workbook's net irrigation demand (below) |
| – | `demand` | abstraction demand D = F ÷ `irrigationEfficiency` (engine ≥ 0.16.0, audit N1) |
| H | `inflow_upstream` | Σ upstream nodes' U |
| I | `runoff` | natural flow × farm share |
| J | `transfer` | Σ transfers in − Σ transfers out |
| K | `upstream_to_dam` | H × `pctUpstreamToDam` — upstream inflow into the dam (engine ≥ 0.9.0, see quirk 1) |
| L | `upstream_below_dam` | H − K — upstream inflow *below* the dam |
| M | `runoff_to_dam` | I × `pctRunoffToDam` — own runoff into the dam |
| N | `runoff_below_dam` | I − M — own runoff below the dam |
| O | `diverted_to_dam` | MIN(`divertCapacityM3Day` (the month's `divertMonthlyM3Day` when set, engine ≥ 1.32.0), L + N) — diverted back into the dam; cut for the senior users (§2.7c) and the hands-off flow (§2.7h) |
| G | `supplied` | MIN(MAX(Qprev + rain on dam − evaporation − seepage + M + O + K + J − capacity × `damMinPct`, 0), D): only the storage above the minimum operating level (engine ≥ 0.16.0, audit Q5) |
| – | `dam_area`, `rain_on_dam`, `dam_evaporation`, `dam_seepage` | the dam's surface, rain on it, evaporation and seepage before irrigation (engine ≥ 0.16.0, audit N2; docs/model.md §2.7a) |
| – | `diverted_loss` | on a unit that can divert into its dam only (River to dam or a top-up off-take): the diverted share of yesterday's storage, fully mixed, × evaporation and the seepage that doesn't return; surface use in the allocation comparison and cap (engine ≥ 1.79.0, docs/model.md §2.12) |
| P | `interim_storage` | Qprev + rain on dam − evaporation − seepage + M + O + K + J − G |
| Q | `dam_storage` | MIN(P, capacity) |
| R | `spill` | MAX(P − capacity, 0) |
| S | `below_dam_not_diverted` | L + N − O — passes below the dam |
| T | `return_flow` | `lossReturnFraction` × (1 − `irrigationEfficiency`) × G — the share of the application losses that returns (audit N1) |
| U | `outflow` | R + S + T + seepage |
| V | `balance_residual` | (H + I + J + rain on dam) − (G − T) − evaporation − (Q − Qprev) − U: float noise |
| W | `deficit` | D − G |
| Y | `ewr` | EWR × farm share |
| Z | `ewr_cumulative` | Y + Σ upstream Z |
| AA | `ewr_shortfall` | MIN(U − Z, 0) |
| AB | `ewr_shortfall_incremental` | MIN(AA − Σ upstream AA, 0) — the reach shortfall; a diagnostic from engine 0.17.0, when `attribution.ts` sets the EWR charge (`ewr_charge`, `ewr_charge_irrigation`) instead |

Every MIN(…, 0) shortfall here (AA, AB, the gauge's and the outlet's) goes
through `shortfall(a, b, scale)`: a difference within 1e-12 of the volumes
involved is float noise and reported as 0, so a residue never counts as a day
the EWR was not met (engine review F8). Upstream sums run in node-id order, so
results don't depend on how the nodes are listed.

Capacity is `damCapacityM3`; initial storage is `damInitialPct × capacity`
(the workbook rounds both to whole m³).

An **other water user** (node kind `user`, engine ≥ 0.22.0, WP-1.33;
docs/model.md §2.7c) takes G = MIN(D, H) (senior) or MIN(D, MAX(0, H − Zs))
(junior) from the river, returns T = r × G, and passes U = H − G + T. A senior
user's demand is fragmented to the farms upstream by flow share (`seniorClaim`,
built in `../run.ts` `otherUsers`); each farm keeps MIN(Zs, H + I) below its
dam (O cut first, then K and M pro rata; working column `passed_for_senior`),
and Zs (`senior_requirement`) accumulates like Z and drops by D below the
senior user. Users are EWR contributors in `attribution.ts` (e = H − U) and
get their own curtailment rows (`curtailment.ts` `otherUserCurtailment`).

**Boreholes** (engine ≥ 0.23.0, WP-1.34; docs/model.md §2.7d) on a farm or
user add groundwater GW to its supply by rule (`supply` in `simulate.ts`;
parameters resolved by `boreholes.ts`), and take stream depletion from its
outflow through a linear-reservoir lag (`deplete`), clamped at the flow there.

A **gauge** passes its upstream through: `outflow` = Σ upstream U,
`ewr_cumulative` = Σ upstream Z, `ewr_shortfall` = MIN(outflow − ewr_cumulative, 0).
(The workbook's gauge sums the upstream AA, which overstates the shortfall at a
confluence where one branch has water to spare: audit G1.) The outflow
node's `outflow` is the catchment `simulated_outflow`.

## Irrigation demand

- Gross crop mm per water-year month = A-pan × crop factor.
- Farm gross m³/day = Σ(crop area × gross mm) / 1000 / days in month,
  with February = `settings.februaryDays` (28.25).
- Daily net = MAX(0, gross − cropped area × effectiveRainFraction/1000 × rain)
  in the workbook. (The workbook rounds these to 2 dp, 0.1 m³/day and whole m³.)
  Engine ≥ 0.14.0 carries effective rain over through a per-farm soil-water
  store (`../demand.ts` `farmDailyDemand`, audit N3): used = MIN(store + Pe,
  gross), net = gross − used, store = MIN(size, store + Pe − used), size =
  `settings.effectiveRainStoreMm` (25 mm; 0 is the workbook's rule bit for
  bit). Demand stays precomputed, so the simulation here only carries the
  `rainOffset` (effective rain used) and `soilWater` working columns.
  Rain is [Flow data] R "Use rain": catchment rain if present, else CHIRPS,
  else forecast, zeroed at or below `calibration.rainThresholdMm`. From engine
  0.15.0 the days of a flagged zero-rain run count as blank catchment rain
  (`../rain.ts`, CR-20), so they take CHIRPS instead.

## Transfers

Settled at the start of each day from yesterday's storage, before any farm
irrigates (the source included). The workbook's `fGetTrfVolCapped` is

    MIN(MAX(source storage yesterday − capacity × minStoragePct, 0), maxRateM3s × 86400)

per rule on its own. The engine (≥ 0.16.0, audit N4 / Q3 / Q18) moves, in an
active month,

    v = MAX(0, MIN(srcFree, dstRoom, maxDaily))      (one rule alone)
    srcFree = source storage yesterday − drawn from it today − reserve
    reserve = capacity × MAX(minStoragePct, the source dam's damMinPct)   (Q5)
    dstRoom = capacity_dst − (storage_dst yesterday + rain on the dam − evaporation − seepage)
              + D_dst today (from 1.31.0 the most its dam is drawn) + a fixed release's
              MIN(amount, outlet) (1.29.0; in full from 1.70.0) − already scheduled into it today

with `maxDaily` = `maxRateM3s` × 86 400, lowered by `dailyCapM3` when set.
Rules run by `priority`, lowest first; within a priority, rules into one
destination share its room and rules from one source share its free water,
each pro rata to its own limit, so the list order never matters. From engine
1.70.0 (issue #90 Q25) that limit is `maxDaily` alone, never capped at the
source's free water first: proportional rationing in rounds, the sources'
bands first, then each receiver's room pro rata to what the sources gave,
then room a short source couldn't fill offered again while a receiver fills
(model.md §2.6), so a rule split into several gets the same total and no
room is wasted on a dry source. From engine
1.36.0 (audit N6) each rule draws only above its own reserve: the source's
water is split into bands at its rules' reserves, and each band is shared, pro
rata to what each still wants, by the rules whose reserve is at or below it,
so a lower-reserve rule never lets a sibling take the dam below that sibling's
reserve. A rule with no rate this month is not active. Where a source's rules
all keep one reserve this is the formula above to the bit (model.md §2.6). The volume is
added to the destination's J and subtracted from the source's. Transfers
involving a gauge are skipped with a warning.

## EWR and summary

- Catchment `ewr` = `settings.ewrPragmaticM3PerDay` for the day's water-year
  month; `ewr_shortfall` = MIN(simulated outflow − EWR, 0);
  `ewrDaysNotMet` counts days where it is negative ([Flow data] AJ/AK).
- `ewrAgreement` (`ewrAgreement.ts`, engine ≥ 0.5.3): the same "below the
  EWR" test on the observed gauge/logger record vs the simulated outflow, as a
  2×2 table with hit rate, false-alarm ratio and frequency bias, overall, per
  month and per water year ([model.md §2.9b](../../../../docs/model.md)).
- `FarmSummary`: averages over the whole run of demand, supplied and deficit
  (demand − supplied); `fractionSupplied` = supplied / demand (1 when there is
  no demand); `avgCropRequirementM3Day` = mean F; `avgEwrShortfallM3Day` =
  −mean(EWR charge), a positive volume (the workbook shows −mean(AB));
  `daysEwrNotMet` = days the farm is charged (engine ≥ 0.17.0, audit Q17;
  before, days with AB < 0).
- `curtailment` ([Shortfalls]): over `settings.reportStart … reportEnd`
  (`resolveReportWindow` in `../run.ts`: null = run start/end, clipped to the
  run with a warning, a disjoint or reversed window falls back to the whole
  run). Per farm: H/I/R = mean demand D / supplied / EWR charge (the
  workbook: F / G / AB); equitable fraction = ΣI / ΣH (a fairness benchmark,
  audit Q11); target M = H × that;
  reduce/gain N = M − I; R splits into an irrigation part R_irr and a
  storage part; supply cut ΔG = R_irr / (1 − β(1 − e)); total change
  S = N − ΔG; volume left U = MAX(M − ΔG, 0) (engine ≥ 0.17.0, audit Q13;
  the sheet has S = N + R, U = M + R); l/s = ÷ 86.4 (all unrounded; the sheet
  rounds and truncates). Also the EWR sites table (`ewrSites`).
  Workbook signs (negative = reduce). Full table and quirks:
  [docs/model.md §2.11](../../../../docs/model.md#211-curtailment-targets-shortfalls).
- Calibration: over days with an observation inside
  `settings.calibrationStart`…`calibrationEnd` (null = open), from
  `settings.calibrationFlowKind`, else `flow_observed_m3s`, else
  `flow_logger_m3s`. PBIAS = 100 × Σ(obs − sim) / Σ obs, so positive means the
  model under-estimates. Formulas: [docs/model.md §2.10](../../../../docs/model.md#210-calibration-statistics-flow-calibration-cfg).
- `ewrCompliance`: per water year × month, days where the outlet's
  `ewr_shortfall` (and each farm's `ewr_charge`, engine ≥ 0.17.0; before,
  `ewr_shortfall_incremental`) is below zero,
  and the summed shortfall volume. The workbook pivot's running-total count is
  available as `countMethod: 'runningTotal'`
  ([docs/model.md §2.9](../../../../docs/model.md#29-ewr-compliance-grid-ewr-shortfalls-pivot-data--ewr-analysis)).
- Series are in the workbook's sign convention: shortfalls are ≤ 0.
  `observed_flow` holds `NaN` on missing days (serialises as `null`).

## Workbook quirks

What we mirror, and what we don't:

1. **"Upstream inflow above dam (%)" fed the below-dam split.** The [Farm
   spec] column is labelled "Upstream Inflow Above Dam (%)", but the Element
   sheet used it for L = ROUND(H × %), the upstream inflow *below* the dam, so
   100% kept all upstream water out of the dam except what the diversion
   capacity (O) brought back. The label, the [Models] help sheet (100% for a
   stand-alone dam) and the Pitman/WRSM farm-dam convention all mean the share
   *into* the dam, and the client confirmed it. **Not mirrored** from engine
   0.9.0: K = H × `pctUpstreamToDam`, L = H − K. The client catchment
   regression replays the workbook by feeding 1 − pct.
2. **Month lists are matched as substrings.** `fIsMthIn` / `fSorW2` use
   `FIND(m & ",", list & ",")`, so a list "11,12" also switches on January and
   February. **Not mirrored** (audit M1): the importer keeps the months a list
   names and prints a note when the workbook would have added others; the
   engine does a plain membership test.
3. **The blank template's sample transfer reads spill, not storage.** In
   the blank b023 template, one [Transfers] From formula passes a farm's
   column R (spill) to `fGetTrfVolCapped` where every other From column
   reads Q (storage). The help text says From columns read Q.
   **Not mirrored**: the engine always draws from storage. The client catchment
   regression is unaffected.
4. **Transfer InOut columns are hand-written formulas** in each workbook
   (`J = O − P` …). The engine assumes the standard "add to destination,
   subtract from source". An import of a workbook with custom InOut formulas
   would not be reproduced.
5. **The workbook rounds almost every column** (demand to 0.01 mm / 0.1 m³/day
   / 1 m³, fragments, splits, return flow, storage, capacity, the rain flow
   `INT`, recession indices to 4 dp). **Not mirrored** from engine 0.4.0
   (audit R1): rounding a state variable stopped recessions at a floor,
   created or lost water in splits and zeroed small dams.
