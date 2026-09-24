# Network water balance (b023 port)

Everything downstream of catchment natural flow: fragmentation, irrigation
demand, transfers, farm dams, routing, EWR shortfalls and calibration
statistics. Natural flow itself comes from the selected runoff model in `../runoff/` (legacy: `../flow.ts`). Entry point:
`runModel` in `../run.ts`.

Up to engine 0.3.1 `run.test.ts` reproduced every daily value on all 13
Element sheets of the client catchment b023 workbook (1981-01-01 to 2025-03-31,
16 161 days) exactly. From 0.4.0 the engine deliberately differs where the
workbook's algorithm is unsound ([docs/engine-audit.md](../../../../docs/engine-audit.md)):
the regression test keeps an explicit, commented deviation list per column,
each entry naming the audit finding. A full `runModel` for the client catchment takes
about 160 ms.

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
| `stats.ts` | [Flow Calibration Cfg] | Calibration statistics over the calibration window: NSE, PBIAS, RMSE, KGE (r, α, β), R², log-NSE, volume error, annual volumes; `moriasiRating`. |
| `curtailment.ts` | [Shortfalls] | Per-farm target volume, reduce/gain and total change (m³/day, l/s) over the reporting window → `RunSummary.curtailment`. |
| `ewr.ts` | [EWR shortfalls Pivot Data] | Water-year × month EWR compliance grid (days not met, shortfall m³) for the outlet and each farm. |
| `round.ts` | – | Excel `ROUND` / `ROUNDDOWN`, for tests that replay workbook cells only. |

## Daily farm balance

FarmTemplate columns, per day *t*, with `Qprev` = yesterday's storage (the
initial storage on day 0). Since engine 0.11.0 every column is a run series:
the working ones (K–P, S, T, V, plus `gross_demand` and `effective_rain`
behind F) are recorded when `simulateNetwork` is called with
`{ workings: true }`, as `runModel` does and calibration doesn't. The same
letters and formulas are in `../verify/columns.ts`, which the exports and the
day trace read.

| Col | Output key | Formula |
| --- | --- | --- |
| F | `demand` | net irrigation demand (below) |
| H | `inflow_upstream` | Σ upstream nodes' U |
| I | `runoff` | natural flow × farm share |
| J | `transfer` | Σ transfers in − Σ transfers out |
| K | `upstream_to_dam` | H × `pctUpstreamToDam` — upstream inflow into the dam (engine ≥ 0.9.0, see quirk 1) |
| L | `upstream_below_dam` | H − K — upstream inflow *below* the dam |
| M | `runoff_to_dam` | I × `pctRunoffToDam` — own runoff into the dam |
| N | `runoff_below_dam` | I − M — own runoff below the dam |
| O | `diverted_to_dam` | MIN(`divertCapacityM3Day`, L + N) — diverted back into the dam |
| G | `supplied` | MIN(Qprev + M + O + K + J, F) |
| P | `interim_storage` | Qprev + M + O + K + J − G |
| Q | `dam_storage` | MIN(P, capacity) |
| R | `spill` | MAX(P − capacity, 0) |
| S | `below_dam_not_diverted` | L + N − O — passes below the dam |
| T | `return_flow` | G × `returnFlowPct` — irrigation return flow |
| U | `outflow` | R + S + T |
| V | `balance_residual` | (H + I + J) − (G − T) − (Q − Qprev) − U: float noise |
| W | `deficit` | F − G |
| Y | `ewr` | EWR × farm share |
| Z | `ewr_cumulative` | Y + Σ upstream Z |
| AA | `ewr_shortfall` | MIN(U − Z, 0) |
| AB | `ewr_shortfall_incremental` | MIN(AA − Σ upstream AA, 0) — the shortfall this farm adds |

Every MIN(…, 0) shortfall here (AA, AB, the gauge's and the outlet's) goes
through `shortfall(a, b, scale)`: a difference within 1e-12 of the volumes
involved is float noise and reported as 0, so a residue never counts as a day
the EWR was not met (engine review F8). Upstream sums run in node-id order, so
results don't depend on how the nodes are listed.

Capacity is `damCapacityM3`; initial storage is `damInitialPct × capacity`
(the workbook rounds both to whole m³).

A **gauge** passes its upstream through: `outflow` = Σ upstream U,
`ewr_cumulative` = Σ upstream Z, `ewr_shortfall` = MIN(outflow − ewr_cumulative, 0).
(The workbook's gauge sums the upstream AA, which overstates the shortfall at a
confluence where one branch has water to spare: audit G1.) The outflow
node's `outflow` is the catchment `simulated_outflow`.

## Irrigation demand

- Gross crop mm per water-year month = A-pan × crop factor.
- Farm gross m³/day = Σ(crop area × gross mm) / 1000 / days in month,
  with February = `settings.februaryDays` (28.25).
- Daily net = MAX(0, gross − cropped area × effectiveRainFraction/1000 × rain).
  (The workbook rounds these to 2 dp, 0.1 m³/day and whole m³.)
  Rain is [Flow data] R "Use rain": catchment rain if present, else CHIRPS,
  else forecast, zeroed at or below `calibration.rainThresholdMm`.

## Transfers

Settled at the start of each day, before any farm. In an active month, the
volume is `fGetTrfVolCapped`:

    MIN(MAX(source storage yesterday − capacity × minStoragePct, 0), maxRateM3s × 86400)

further capped by `dailyCapM3` when set. It is added to the destination's J
and subtracted from the source's. Transfers involving a gauge are skipped with a
warning.

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
  no demand); `avgEwrShortfallM3Day` = −mean(AB), a positive volume (the
  workbook shows it negative); `daysEwrNotMet` = days with AB < 0.
- `curtailment` ([Shortfalls]): over `settings.reportStart … reportEnd`
  (`resolveReportWindow` in `../run.ts`: null = run start/end, clipped to the
  run with a warning, a disjoint or reversed window falls back to the whole
  run). Per farm: H/I/R = mean demand / supplied / AB; equitable
  fraction = ΣI / ΣH; target M = H × that; reduce/gain N = M − I;
  total change S = N + R; volume left U = M + R; l/s = ÷ 86.4 (all unrounded;
  the sheet rounds and truncates).
  Workbook signs (negative = reduce). Full table and quirks:
  [docs/model.md §2.11](../../../../docs/model.md#211-curtailment-targets-shortfalls).
- Calibration: over days with an observation inside
  `settings.calibrationStart`…`calibrationEnd` (null = open), from
  `settings.calibrationFlowKind`, else `flow_observed_m3s`, else
  `flow_logger_m3s`. PBIAS = 100 × Σ(obs − sim) / Σ obs, so positive means the
  model under-estimates. Formulas: [docs/model.md §2.10](../../../../docs/model.md#210-calibration-statistics-flow-calibration-cfg).
- `ewrCompliance`: per water year × month, days where the outlet's
  `ewr_shortfall` (and each farm's `ewr_shortfall_incremental`) is below zero,
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
   engine does a plain membership test. It makes no difference to either
   sample workbook: the client catchment's transfer is "5,6,7,8,9,10", and lists with 11
   or 12 there already include 1 and 2.
3. **Blank template's sample transfer reads spill, not storage.** In
   `Blank_WBT_b023_v001.xlsm` [Transfers] P7 is
   `fGetTrfVolCapped(FarmB!R6, …)`: column R (spill) where every other
   From column reads Q (storage). The help text says From columns read Q.
   **Not mirrored**: the engine always draws from storage. The client catchment reads Q
   correctly, so the regression is unaffected.
4. **Transfer InOut columns are hand-written formulas** in each workbook
   (`J = O − P` …). The engine assumes the standard "add to destination,
   subtract from source". An import of a workbook with custom InOut formulas
   would not be reproduced. The client catchment's are standard.
5. **The workbook rounds almost every column** (demand to 0.01 mm / 0.1 m³/day
   / 1 m³, fragments, splits, return flow, storage, capacity, the rain flow
   `INT`, recession indices to 4 dp). **Not mirrored** from engine 0.4.0
   (audit R1): rounding a state variable stopped recessions at a floor,
   created or lost water in splits and zeroed small dams.
