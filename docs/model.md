# Model reference

This document explains the water-balance model the web app reimplements. It
covers what the model does, the formulas step by step, where each step lives in
the source Excel workbooks, and which workbook behaviours look like bugs that we
need the hydrologist to confirm.

The engine (`packages/engine`) is a TypeScript port of this model. It is pure
code with no I/O, and it runs both in the browser and in the Lambda. Anything
here that differs from the engine code is a documentation bug. Fix whichever one
is wrong.

- [1. Background](#1-background)
- [2. The b023 model (what V1 ports)](#2-the-b023-model-what-v1-ports)
- [3. Workbook quirks and suspected bugs](#3-workbook-quirks-and-suspected-bugs)
- [4. The AI node-based model (v004 DEV)](#4-the-ai-node-based-model-v004-dev)
- [5. The AI runoff module (DEV 003)](#5-the-ai-runoff-module-dev-003)
- [6. Porting strategy and regression testing](#6-porting-strategy-and-regression-testing)
- [7. Glossary](#7-glossary)

---

## 1. Background

**Water Balance Tool (WBT) b023** is an Excel/VBA workbook. SmartMatix wrote it
for the Freshwater Research Centre (FRC, Scarborough, South Africa). It runs a
**daily** water balance for one river catchment, which is a network of farms
(each with an optional composite dam) that drain into one outflow gauge. It
answers three questions:

1. How much natural flow does the catchment produce each day? Rain is turned
   into flow by a calibrated recession model.
2. How much of each farm's irrigation demand can be met from its runoff,
   upstream inflow, dam storage and transfers?
3. After irrigation, is the **Environmental Water Requirement (EWR)** still met
   at each farm and at the outflow gauge? If not, by how much is it short?

**One workbook holds one catchment.** In the web app, one workbook becomes one
**project**. The user can keep several projects side by side (place A, B, C…)
and create or copy more.

Source workbooks (kept locally outside the repo in `../project-water-management-source/Original/` and `…/AI/`, never committed):

| Workbook | What it is | Status |
| --- | --- | --- |
| `Blank_WBT_b023_v001.xlsm` | The b023 template with sample data | Reference for formulas |
| `Client_WBT_b023_v001_…WORKING 007.xlsm` | Real catchment: 1981-01-01 … 2025-03-31 (16 161 days), 12 farms + 1 outflow gauge, 9 crops, 1 transfer | **Regression target** for V1 |
| `AI/WBT_NodeBased_v004_DEV.xlsm` | An experimental 16-node daily ledger with pump scenarios and stress classes | Unfinished; later phase |
| `AI/WBT_Runoff_Module_DEV_003.xlsm` | An experimental bucket rainfall-runoff model with 12 hydrological units | Unfinished; later, as an alternative flow generator |

---

## 2. The b023 model (what V1 ports)

### 2.1 Pipeline

```mermaid
flowchart LR
  R[Daily rain<br/>catchment / CHIRPS / forecast] --> NF[Natural flow<br/>Flow data sheet]
  O[Observed / Pitman flow] -.fallback.-> NF
  NF --> FR[Fragmentation<br/>share per farm]
  R --> ID[Net irrigation demand<br/>per farm]
  C[Crops × A-pan × areas] --> ID
  FR --> FB[Farm balance<br/>per farm, calc order]
  ID --> FB
  T[Transfers] --> FB
  FB --> G[Outflow gauge]
  E[Pragmatic EWR] --> FE[Fragmented EWR] --> FB
  G --> OUT[Outputs: shortfalls,<br/>EWR not met, calibration]
  E --> OUT
```

Units: flows and volumes are **m³/day** internally. The workbook converts m³/s
with `86 400 s/day` (`rAppSet_ConvertSecToDay`). Months are laid out in
**water-year order** (Oct … Sep) wherever the workbook shows a monthly table.

**Rounding.** The workbook rounds at nearly every step (`ROUND(…, 0)` on
fragmented flows, dam splits, return flow, storage and capacity; `INT` on the
rain-added flow; 4 dp on recession indices; 2 dp / 1 dp / 0 dp in the demand
chain; 0, 1 and 3 dp and `ROUNDDOWN` in `[Shortfalls]`). **The engine (≥ 0.4.0)
rounds nothing**: rounding a model state is not neutral. It stopped every
recession at a floor of about `0.5 / (1 − f)` m³/day (32 m³/day for the
default tail factor), created or lost water whenever a flow was split (four
equal farms and 2 m³/day of natural flow gave 4 m³/day of runoff), and turned a
0.4 m³ dam into no dam ([audit R1](./engine-audit.md)). The formulas below show
the workbook's rounding for reference, marked *(workbook only)*; the UI and the
exports round for display.

### 2.2 Configuration (the "Cfg" sheets)

| Sheet | Holds | App equivalent |
| --- | --- | --- |
| `[Network]` | Elements (Farm or Gauge), upstream elements (up to 7), "Has transfer?", the one **outflow gauge**. The rows must be in calculation order (upstream first). Bifurcation is not allowed. | `node` rows; `downstream_node_id` gives the tree, and the engine works out the calculation order |
| `[Farm spec]` | Areas (total, high-MAP, low-MAP), the fragmentation method (Area / Hi-Lo / Specific), % upstream inflow "above dam", % farm runoff into dam, dam capacity, initial %, min % for transfers, downstream diversion back to dam (m³/s → m³/day), irrigation return flow % | `node` farm columns + `project.settings.flowShareMethod`, `hiLoSplit` |
| `[Crop demand]` | WR90 A-pan evaporation by month, effective-rainfall %, crop factors by month | `settings.apanMm`, `settings.effectiveRainFraction`, `crop` |
| `[Farm demand]` | Crop area (m²) per farm per crop, days per month (Feb = 28.25 by default) | `crop_area`, `settings.februaryDays` |
| `[Transfers]` | Hand-written transfer formulas, plus per-transfer parameters (from, to, months, max m³/s, min dam %) | `transfer` rows (structured rules) |
| `[Flow Calibration Cfg]` | The rain→flow parameters and the recession curve | `settings.calibration` |
| `[EWR Cfg]` | Desktop Reserve Model tables, and the percentile pick with overrides that produce the **pragmatic EWR** (m³/day per month) | `settings.ewrPragmaticM3PerDay` (V1 stores the final table) |
| `[Flow data]` (left block) | Daily inputs: Pitman natural flow, observed gauge flow, logger flow (all m³/s), catchment-average rain, CHIRPS rain, forecast rain (mm) | `time_series` rows by `kind` |

Element types: a **Farm** element can also stand for a stand-alone dam or a
natural (unused) area, depending on its parameters (see the `[Models]` sheet). A
**Gauge** only passes flow through and reports it.

### 2.3 Irrigation demand

Sheets `[Crop demand]` → `[Farm demand]` → `[Irrigation Demand]`.

1. **Gross crop requirement (mm/month)** for crop *c* in water-year month *m*:

   `grossMm[c][m] = apanMm[m] × cropFactor[c][m]` (workbook: `ROUND(…, 2)`)

2. **Gross farm demand (m³/day)** for farm *f*:

   `grossFarm[f][m] = Σc area[f][c] × grossMm[c][m] / 1000 / daysInMonth[m]` (workbook: `ROUND(…, 1)`)

   Here `daysInMonth` is 31, 30, 31, 31, **28.25**, 31, 30, 31, 30, 31, 31, 30 for
   Oct…Sep. February is configurable. 28.25 gives a 365.25-day year.

3. **Net daily demand (m³/day)** on day *t*:

   `netDemand[f][t] = MAX(0, grossFarm[f][month(t)] − croppedArea[f] × effRain / 1000 × rainUsed[t])` (workbook: `ROUND(…, 0)`)

   - `croppedArea[f]` = Σ crop areas of the farm (m²).
   - `effRain` = effective-rainfall fraction (0.65).
   - `rainUsed[t]` is the *thresholded* rain from the Flow data sheet (§2.4).
     Rain at or below the threshold counts as 0, so light rain does not reduce
     demand.

### 2.4 Natural flow from rain (`[Flow data]`)

This is the calibrated rain→runoff routine. One row runs per day, and each row
reads the previous row. Parameters come from `[Flow Calibration Cfg]`. The
defaults from the blank workbook are shown.

| Parameter | Blank default | Meaning |
| --- | --- | --- |
| `RainThreshold` | 2 mm | Rain at or below this produces no flow and does not offset demand |
| `a`, `b` | 0.09, 1.2 | Peak flow = `a · rain^b` |
| `RainToM3` | total farm area km² × 1000 | Converts mm over the catchment to m³ |
| `SummerMths` | 1,2,3,4,5,11,12 (blank); 10–3 in the engine defaults | Calendar months that are always "summer" |
| `FactorSummer` / `FactorWinter` | 0.1 / 1 | Seasonal response factor |
| `WinterTodayThresh` / `WinterNextDayThresh` | 35 mm / 9 mm | Rain that flips a non-summer month into winter response |
| `MinFlowRatioToResetBase` | 1.5 | Rain pulse / base flow ratio above which base flow resets |
| `ShiftPeakIndexLo` / `Hi` | 0.9 / 3.5 | Range of the recession index given to a new rain pulse |
| `Amplitude` | derived | Rain→flow amplitude used to scale the pulse index |
| `DaysMax` | rows in the curve − 1 (79) | Upper bound of the recession index |
| `RecessionCurve` / `RecessionFactors` | 80-row table | Flow (m³/day, descending) → daily recession factor |
| `BaseFlowInitial` | 300 m³/day | Base flow on the first day |

Per day *t*, with the workbook column letters:

| Col | Quantity | Formula |
| --- | --- | --- |
| R | **Rain used** | The first non-blank of catchment rain, CHIRPS or forecast, set to 0 if it is ≤ threshold |
| N | **Season** (1 = summer, 0 = winter) | Summer month → 1. Otherwise: if yesterday was winter → 0. Otherwise → 0 if `rain[t] ≥ 35` or `rain[t−1] ≥ 9`, else 1. In non-summer months "summer" response carries on until a big enough rain opens the winter. |
| V | **Rain-added flow** | `a · R^b · RainToM3 · seasonFactor` if R > 0, else 0 (workbook: `INT(…)`) |
| S | **Base flow** | `FB` = yesterday's base receded by yesterday's base index. The day before the run is a steady base-flow state: base = resultant = `BaseFlowInitial`, at that flow's own recession index (engine ≥ 0.4.0, [audit E1](./engine-audit.md); the workbook left the index blank, so day 1 receded at the extrapolated factor `2·f1 − f2`). If `V / FB > 1.5` the base resets to `V`, else it stays `FB`. (Workbook: rounded to 0 dp.) |
| T | **Base recession index** | Where S sits on the recession curve, interpolated linearly and clamped to `[1, DaysMax]` (workbook: 4 dp) |
| U | **Response flow (start)** | Yesterday's resultant response receded by yesterday's resultant index |
| W | **Pulse index** | For a new pulse (V > 0): `Lo + (Hi − Lo)(1 − V/Amplitude)`, not below `Lo`. If that is above the base index, use `max(1, baseIndex − 0.2)`. With no pulse: yesterday's index + 1 (or the base index if yesterday's was 0). Capped at `DaysMax` (workbook: 4 dp). |
| X | **Response + added** | If V > 0: `U + V`. Else if yesterday's X = 0: `U`. Else yesterday's X receded by yesterday's W. |
| Y / Z | **Resultant response / index** | `max(X, S)` and the index of whichever one won |
| AB | **Natural flow (m³/day)** | `Y` if > 0, else the Pitman natural flow (m³/day) if > 0, else 0 |

`recede(flow, index) = flow × lerp(factor[floor(index)], factor[floor(index)+1], frac(index))` (workbook: `ROUND(…, 0)`)

The interpolated factor is clamped at 0, so an index below 1 (a pulse starting at
`ShiftPeakIndexLo` < 1) can shrink a flow to nothing but never make it negative
([audit E2](./engine-audit.md)).

The same sheet also:

- Picks the **observed** flow series used for calibration: Pitman (1), gauge
  (2) or logger (3) via `rUseFlow`. It converts it to m³/day (the workbook rounds).
- Carries the **pragmatic EWR** for the day's month (AF), the **simulated
  outflow** at the outflow gauge (AG), an "EWR not met" flag (AJ = 1 when
  AG < AF) and the shortfall volume (AK = AG − AF when not met).
- Reports mean annual runoff and mean daily runoff (all days and summer only)
  for observed and simulated flow.

> The engine's `CalibrationParams` currently holds `a`, `b`, the threshold, the
> seasonal factors, summer months and the initial base flow. The recession
> curve, shift-peak indices, reset ratio and winter thresholds also have to be
> in project settings for a number-for-number match. The importer reads them
> from the workbook's named ranges (`rCalibration_*`).

### 2.5 Fragmentation (`[Fragmented flow]`, `[Fragmented EWR]`)

Each farm gets a fixed **share** (`frag[f]`, 0–1) of the catchment flow. The
method is chosen in `[Farm spec]`:

| Method | Share |
| --- | --- |
| **Area** | `farmArea / Σ farmArea`, where `farmArea = hiMapArea + loMapArea` |
| **Hi/Lo** | `hiArea/ΣhiArea × hiSplit + loArea/ΣloArea × loSplit` (Pitman split, default 0.81 / 0.19) |
| **Specific** | A value entered by hand ("external fragmentation") |

The shares should sum to 1 within `0.0002` (fragmentation tolerance). Then:

- Farm runoff: `runoff[f][t] = naturalFlow[t] × frag[f]` (workbook: `ROUND(…, 0)`)
- Farm EWR: `ewr[f][t] = pragmaticEwr[month(t)] × frag[f]` (workbook: `ROUND(…, 0)`)

### 2.6 Transfers (`[Transfers]`)

The workbook has two blocks of columns:

- **Draw From** (one column per transfer): water available in the *source* dam,
  based on **yesterday's** end-of-day storage:

  `draw[t] = monthIn(t, months) ? MIN( MAX(storage[src][t−1] − cap[src] × minPct[src], 0), maxRate_m3s × 86400 ) : 0`

- **InOut** (one column per farm with "Has transfer? = Yes"): the net volume
  entering (+) or leaving (−) that farm. Each is a **hand-written formula**, for
  example `<source farm> = −draw₁`, `<receiving farm> = +draw₁`.

client catchment has one transfer: one farm dam to another, in six months of the
year, capped by a maximum rate and a minimum level kept in the source dam.

The app replaces the free-form formulas with structured rules
(`transfer` table: from, to, months, max rate, optional daily cap, min storage %,
enabled). The out-leg and in-leg of each rule are the same volume, so they
always balance. Anything the hydrologist has written that doesn't fit this
shape has to be raised with them (see §3).

### 2.7 Farm balance (one sheet per element)

Farms are processed in network order. Upstream elements come first, so a farm
sees its upstream elements' **same-day** outflow. Per farm *f*, day *t* (the
sheet's column letters are in brackets). The workbook rounds L, M, T and the
storage to whole m³; the engine doesn't (R1).

| Step | Quantity | Formula |
| --- | --- | --- |
| F | Net irrigation demand | from §2.3 |
| H | Upstream inflow | Σ outflow `U` of the elements directly upstream |
| I | Farm runoff | fragmented natural flow (§2.5) |
| J | Transfer in (+) / out (−) | from §2.6 |
| L | Upstream inflow "below dam" | `H × pctUpstream` (see quirk Q1) |
| K | Upstream inflow "above dam" | `H − L` |
| M | Farm runoff into dam | `I × pctRunoffToDam` |
| N | Farm runoff below dam | `I − M` |
| O | Diverted back to dam | `MIN(divertCapacity, L + N)` |
| G | **Irrigation supplied** | `MIN(store[t−1] + M + O + K + J, F)` |
| P | Interim storage | `store[t−1] + M + O + K + J − G` |
| Q | **Storage, end of day** (`store[t]`) | `MIN(P, damCapacity)` |
| R | **Spill** | `MAX(P − damCapacity, 0)` |
| S | Below-dam flow not diverted | `L + N − O` |
| T | Irrigation return flow | `G × returnPct` |
| U | **Farm outflow** | `R + S + T` |
| V | Balance check | `abs((H+I+J) − G·(1−returnPct) − (store[t] − store[t−1]) − U)` must be 0 (the invariant tests check it on random networks) |
| W | **Irrigation deficit** | `F − G` |
| Y | Fragmented EWR | §2.5 |
| Z | Cumulative EWR | `Y + Σ Z` of the elements directly upstream (see quirk Q4) |
| AA | EWR shortfall (−) | `MIN(U − Z, 0)` |
| AB | Incremental EWR shortfall (−) | `MIN(AA − Σ AA of the elements directly upstream, 0)` |

Initial storage = `initialPct × damCapacity` (workbook: `ROUND(initialPct × ROUND(damCapacity, 0), 0)`).

A **gauge** element records the sum of its upstream elements' outflow (`= simulated flow`),
the sum of their cumulative EWR (Z), and its shortfall `MIN(flow − Z, 0)`. The workbook's
gauge sums the upstream elements' AA instead, which reports a shortfall at a
confluence whose flow meets the EWR when one branch is short and another has
water to spare; the engine (≥ 0.4.0) doesn't ([audit G1](./engine-audit.md)). The **outflow gauge's** flow is the
catchment's simulated outflow that goes back into `[Flow data]` AG. That is
compared with the full pragmatic EWR and the observed flow.

### 2.8 Outputs

| Workbook sheet | What it shows | App equivalent (V1) |
| --- | --- | --- |
| `[EWR shortfalls]` | Per day: unfragmented EWR, EWR volume not met at the gauge, a not-met flag, Σ incremental farm shortfalls, and per-farm incremental shortfall | Run series (`ewr_*` keys) + chart |
| `[Shortfalls]` | Per farm over a reporting window: average demand, supply, deficit, % supplied, target volume, reduce/gain (m³/day and l/s), average EWR shortfall, total reductions, volume left after irrigation is balanced and the EWR is met | `RunSummary.curtailment` over `settings.reportStart … reportEnd` (§2.11); `RunSummary.farms` keeps the whole-run averages |
| `[EWR analysis]` / pivots | Shortfall by farm × year × month, count and % of days not met | `RunSummary.ewrCompliance` + EWR heat map (§2.9) |
| `[Flow Calibr. Graph Full]`, `[Flow Calibration Cfg]` | Observed vs simulated flow over the calibration window | Calibration chart + `CalibrationStats` (§2.10) |

### 2.9 EWR compliance grid (`[EWR shortfalls Pivot Data]` → `[EWR analysis]`)

The workbook's VBA macro `sProEp_GenerateEWRpivotData` walks the
`[EWR shortfalls]` sheet and writes one row per calendar year × month × farm:
the month's summed incremental shortfall (AB, m³), a "not met" day count, and
that count / days in the month (February = `INT(28.25)` = 28). A pivot table
then shows it as farm × month.

The engine's `ewrCompliance` (`network/ewr.ts`) builds the same grid, laid
out as **water-year rows × Oct…Sep columns**, for the outlet (simulated
outflow vs the full pragmatic EWR, i.e. `[Flow data]` AK) and for each farm
(`ewr_shortfall_incremental`). Each cell holds the days simulated, the days
not met and the shortfall volume (m³, positive).

**Which days count as "not met".** The macro adds each day's shortfall to a
running monthly total and counts the day when *the total* is below zero. Once
a month has one short day, every later day of that month counts, even days
when the EWR was met. The engine counts a day only when **that day** is short
(`countMethod: 'daily'`), which is what "% of days EWR not met" means; the
summary uses this. `countMethod: 'runningTotal'` reproduces the macro, and the
client catchment regression test checks it against the extracted pivot. Volumes are
the same either way. The percentage the UI shows is days not met / days
simulated in that month, so a leap February is out of 29 and a part month at
either end of the run is out of the days actually simulated.

**The workbook's pivot is stale.** It is written by a macro, not by formulas,
so it reflects the model as it was when someone last ran the macro. In the
client catchment workbook about 23% of farm-months hold volumes that no longer match
the Element sheets or `[EWR shortfalls]` (for example a farm whose daily AB is
constant through a February shows a monthly sum that is not 28 × that value).
Where the volumes are current, the running-total counts match exactly.

### 2.10 Calibration statistics (`[Flow Calibration Cfg]`)

The hydrologist calibrates on a window, not the whole record:
`zCalibration_Date1`…`zCalibration_DateN` (client catchment: 2010-10-01 to
2018-09-30), against the flow record `rUseFlow` picks in `[Flow data]`
(1 = Pitman, 2 = the G1 gauge, 3 = the A1 logger; client catchment uses the
logger, which only has data from 2013-04-15). The importer copies both into
`settings.calibrationStart/End` and `settings.calibrationFlowKind`. With no
window the whole overlap is scored; with no flow kind the engine uses the gauge
series if present, else the logger.

`calibrationStats` (`network/stats.ts`) scores the days inside the window that
have an observation, in m³/s:

| Metric | Formula | Reads as |
| --- | --- | --- |
| NSE | 1 − Σ(o − s)² / Σ(o − ō)² | 1 perfect; ≤ 0 no better than the observed mean |
| PBIAS | 100 × Σ(o − s) / Σo | %; positive = model under-estimates volume |
| RMSE | √(Σ(o − s)² / n) | m³/s |
| KGE | 1 − √((r − 1)² + (α − 1)² + (β − 1)²) (Gupta et al. 2009) | 1 perfect; > −0.41 beats the mean flow (Knoben et al. 2019) |
| r, α, β | Pearson r; α = σs/σo; β = s̄/ō (population σ) | timing, variability and volume ratios |
| R² | r² | share of variance explained |
| log-NSE | NSE of ln(Q + ε), ε = ō / 100 (Pushpalatha et al. 2012) | fit of low flows |
| Volume error | 100 × (Σs − Σo) / Σo | %; positive = model too wet (= −PBIAS) |
| Annual volumes | Σ per water year of paired days, Mm³, and % difference | the annual water balance |

`moriasiRating` rates NSE and PBIAS after Moriasi et al. (2007): NSE > 0.75
very good, > 0.65 good, > 0.50 satisfactory; |PBIAS| < 10 very good, < 15
good, < 25 satisfactory; otherwise unsatisfactory. Those thresholds were set
for monthly flows; daily fits usually score lower.

The workbook's own summary (`[Flow data]` AF16/AG16) differs slightly: it
treats blank observations as 0 and then only counts days with observed flow
> 0. The engine skips blank days and keeps observed zeros.

**client catchment (engine 0.3.0, end to end from rain).** Whole record against the
G1 gauge (V1's behaviour): NSE −0.70, PBIAS −23%. The workbook's window
against the G1 gauge: NSE −0.34, PBIAS −116%, KGE −0.28. The workbook's
window against the logger it actually calibrates to (1 803 days, 2013-04-15 to
2018-03-22): **NSE 0.29, KGE 0.57 (r 0.69, α 1.11, β 1.28), R² 0.48, log-NSE
0.49, PBIAS −28%**. β = 1.278 equals the workbook's own "Calibration / Logger"
volume ratio (`[Flow Calibration Cfg]` K27 = 1.2783). The gauge and the logger
disagree badly from 2014 to 2017 (in one water year the gauge records less than
a tenth of the logger's volume): a question for the hydrologist.

### 2.10a Data quality: do the observed flow records agree?

Not in the workbook — added after comparing client catchment's two observed records.
When a project has both an observed gauge series (`flow_observed_m3s`, e.g.
G1) and a logger series (`flow_logger_m3s`, e.g. A1), every run compares
them per water year on the days **both** have a reading
(`observedAgreement`, `packages/engine/src/quality.ts`): volume of each in
Mm³, and the ratio gauge / logger. A year is **flagged** when the ratio falls
outside 2/3 … 3/2 (one instrument reads less than two-thirds or more than 1.5×
the other) on at least 90 shared days, or when one records nothing while the
other records flow. Flagged years produce a run warning and are listed in
`RunSummary.dataQuality.observedAgreement`.

Two instruments on the same reach should roughly agree; a sustained gap
usually means something physical at one of them (a damaged or silted weir, a
changed rating curve, flow bypassing the structure, zero-filled gaps) — and
calibrating to the wrong record skews every farm's supply and EWR result.
client catchment: 95 % (2012/13), 83 % (2013/14), then **13 %, 33 %, 8 %** for
2014/15–2016/17 → flagged. See the first hydrologist question in
[plan.md](./plan.md#model-and-hydrology-for-the-hydrologist).

### 2.11 Curtailment targets (`[Shortfalls]`)

The `[Shortfalls]` sheet answers *how much must each farm cut (or may it
gain) so that irrigation is shared fairly and the EWR is met?* It works on
averages over a **reporting window** the user types into two cells
("Set reporting period", named range `zShortfalls_PeriodStart` and the cell
below it). The engine reads the window from `settings.reportStart` /
`settings.reportEnd` (ISO dates, inclusive; `null` = the run's own start or
end; clipped to the run with a warning). It computes the table in
`packages/engine/src/network/curtailment.ts` and returns it as
`RunSummary.curtailment`.

**The idea in plain words.** Over the window, add up what every farm asked
for and what it actually got. The ratio is the catchment's **equitable supply
fraction**: if the water that was supplied had been shared in proportion to
demand, every farm would have received that fraction of its demand. That
share is the farm's **target volume**. A farm that received more than its
target must **reduce** by the difference; one that received less may
**gain**. Across all farms these reductions and gains cancel out (up to
rounding), so this step only *redistributes* water. The farm's average **EWR
shortfall** (the incremental shortfall it causes, §2.7 AB) is then added on
top. The result is the **total change** that both balances irrigation and
meets the EWR, and **target + EWR shortfall** is the volume the farm has left
to irrigate once both are done.

**Cell formulas.** One row per farm, in `[Network]` order, and gauges are
left out. *W* is the reporting window, and every average is a plain mean over
the days in *W*. Column letters are the workbook's. Signs follow the
workbook: **negative = reduce / shortfall, positive = gain**. The sheet rounds
and truncates as shown in brackets; the engine (≥ 0.4.0) computes every column
unrounded and the UI rounds for display ([audit R1, Q14, Q15](./engine-audit.md)).

| Col | Engine field (`CurtailmentFarm`) | Workbook label | Formula |
| --- | --- | --- | --- |
| H | `demandM3Day` | Average demand (m³/day) | `AVERAGE(F over W)` [sheet: `ROUND(…, 0)`], where F is the Element sheet's net demand |
| I | `suppliedM3Day` | Average supply (m³/day) | `AVERAGE(G over W)` [sheet: `ROUND(…, 0)`], where G is irrigation supplied |
| J | `deficitM3Day` | Average deficit (m³/day) | `I − H` (≤ 0) |
| K | `fractionSupplied` | %Supply | `IF(H = 0, "-", I / H)` (not rounded) |
| K<sub>tot</sub> | `equitableFraction` | (totals row) | `ΣI / ΣH` [sheet: over the rounded averages] |
| M | `targetM3Day` | Target volume (m³/day) | `H × K_tot` [sheet: `ROUND(…, 1)`] |
| N | `reduceGainM3Day` | − = Reduce, + = Gain (m³/day) | `M − I` |
| O | `reduceGainLs` | − = Reduce, + = Gain (l/s) | `N / 86.4` [sheet: `ROUNDDOWN(…, 1)`, truncated toward zero] |
| P | `targetFraction` | %Supply (of target) | `IF(H = 0, "-", M / H)` [sheet: `ROUND(…, 3)`]. This is K_tot for every farm with demand |
| R | `ewrShortfallM3Day` | Average EWR shortfall for the period (m³/day) | `AVERAGE(incremental EWR shortfall over W)` [sheet: `ROUND(…, 0)`] (≤ 0). The sheet reads it from `[EWR shortfalls]`, which copies Element sheet AB |
| S | `totalChangeM3Day` | Total reductions (m³/day) | `N + R` |
| T | `totalChangeLs` | Total reductions (l/s) | `S / 86.4` [sheet: `ROUNDDOWN(…, 1)`] |
| U | `volumeLeftM3Day` | Volume left after irrigation balanced & EWR met (m³/day) | `M + R` |
| V | `fractionOfDemandLeft` | Reduction of demand required (%) | `IF(H = 0, "-", U / H)` [sheet: `ROUND(…, 3)`] (see quirk Q12) |

The totals row (`CurtailmentSummary.totals`) is a plain `SUM` of H, I, J, M,
N, O, R, S and U. (The sheet's l/s total is the sum of the *truncated* farm
values.) T has no total. 86.4 converts m³/day to l/s (1 m³/day = 1000 l /
86 400 s). With nothing rounded, the reductions and gains (N) sum to 0 up to
floating-point noise.

The client catchment regression test feeds the workbook's own daily Element-sheet
values into `computeCurtailment` and checks every column against the cell
formulas written out unrounded, and the saved window's averages against the
sheet within its rounding (½ m³/day).

---

## 3. Workbook quirks and suspected bugs

The V1 engine reproduces these **as the workbook does them**, so it can be
regression-tested against client catchment. Each one needs a decision from the
hydrologist. When one is fixed, the fix goes behind a project setting (a
"workbook-compatible" mode against a "corrected" mode). That way old results
stay reproducible and the engine version records which one was used.

| # | Where | What we see | Why it matters |
| --- | --- | --- | --- |
| Q1 | Farm sheet K/L | **Naming mismatch on "Upstream inflow above dam %"**. The column's label says "above dam", but the formula puts `H × pct` *below* the dam (L) and only `H × (1 − pct)` into the dam (K). client catchment sets it to 100% for most farms, so under the formula no upstream water enters those dams (except through the diversion capacity). The `[Models]` sheet says "set to 100%" for a stand-alone dam, which contradicts the formula. The DB column is named `pct_upstream_to_dam` after the label. | This may change every downstream number. We must ask which meaning is intended. |
| Q2 | Blank `[Transfers]` | One "Draw From" column points at the source's **Spill** column (R) instead of **Storage** (Q) (`<Farm>!R6`). client catchment's live transfer correctly uses Q. | Shows how fragile hand-written formulas are. Confirm that no other catchment workbook carries the R reference. |
| Q3 | Transfers | A draw is capped by the source's *yesterday* storage and min %. It is **not** capped by the receiving dam's free space (the excess spills straight away), and irrigation at the source the same day can use the water first. | It is unclear whether the order (transfer vs irrigation) and the spill of transferred water are intended. |
| Q4 | Farm sheet Z/AB | **Corrected 2026-09 (engine review):** earlier versions of this table said Z was only the farm's own fragment. The client catchment Element sheets have `Z = Y + Σ upstream Z` (e.g. `FarmC!Z17 = Y17+FarmA!Z17+FarmB!Z17`) and `AB = MIN(AA − Σ upstream AA, 0)`; farms with nothing upstream have `Z = Y`, `AB = MIN(AA, 0)`. The engine already did this. The open question is Q17. | Only the doc was wrong; results unchanged. |
| Q5 | Farm sheet G | Irrigation can empty the dam completely. The **min dam %** only applies to transfers, not to irrigation. | Confirm whether farmers keep a reserve. |
| Q6 | Flow data R | The same thresholded rain drives both runoff and the effective-rain offset. Light rain (≤ 2 mm) never reduces demand. | Probably intended, but should be confirmed. |
| Q7 | Flow data AB | When the rain model gives 0, natural flow falls back to **Pitman** flow if present. Days with no rain data silently use a different source. | Mixed sources in one series. The UI should flag these days. |
| Q8 | Farm spec | The Hi/Lo method uses Σ hi-areas and Σ lo-areas over the listed farms, not over the whole catchment. In client catchment the Hi+Lo area sum differs slightly from the total area. The share sum is checked with a 0.0002 tolerance. | Small drift, but visible in the regression test. |
| Q9 | Several | The blank and client catchment differ in summer months (1–5, 11, 12 vs other sets) and in crop factors. | Settings are per project, so this is fine. It shows that defaults must not be trusted blindly. |
| Q10 | EWR Cfg | Pragmatic EWR = one percentile of the Desktop Reserve "without high flows" table, scaled and converted to m³/day, with manual overrides. The source table and scale factor are catchment-specific. | V1 stores only the final 12 numbers. Ask whether the app must derive them. |
| Q11 | Shortfalls M/N | **The target ignores the network.** The equitable share gives every farm the same fraction of its demand (ΣI/ΣH), as if water could be moved freely between any two farms. In practice, a downstream farm's surplus can't reach an upstream farm, and a farm without a dam can't store a "gain". The reduce/gain column is a *fairness* target, not a feasible schedule. It also sets no farm-specific priorities or licensed volumes. | Decides whether "gain" may be shown as water a farm can actually get. A network-aware redistribution (or licences, see planned-work) would change every target. |
| Q12 | Shortfalls V | The column is labelled **"Reduction of demand required (%)"**, but the formula is `U / H`, the share of demand that is *left*: 1.000 means no reduction, and 0.600 means a 40 % cut. **Mirrored**: `fractionOfDemandLeft` holds `U / H`, and the UI labels it "demand left", not "reduction". | The label invites exactly the wrong reading. We should ask which one the client reports. |
| Q13 | Shortfalls R/S/U | The EWR shortfall is the farm's **incremental** shortfall (Element AB). With quirk Q4 in play, that is the whole outflow compared with the farm's own fragment. A farm with no irrigation demand can still carry an EWR "reduction" (S < 0, U < 0) that it has no irrigation to cut. | We need to confirm how a cut is meant to be applied to a natural or stand-alone-dam element. |
| Q14 | Shortfalls K total | `K_tot = ΣI / ΣH` has no zero guard. With no demand in the window the workbook shows `#DIV/0!` in every target. The engine returns `equitableFraction = null` and targets of 0. The sheet also divides the **rounded** farm averages (H, I). **Fixed (engine 0.4.0, audit R1):** the engine uses the unrounded averages. | Cosmetic. The rounding effect was at most ½ m³/day per farm. |
| Q15 | Shortfalls O/T | The l/s columns use `ROUNDDOWN` (truncate toward zero), not `ROUND`. A cut below 0.1 l/s (8.64 m³/day) therefore shows as 0 l/s, and the l/s total is a sum of truncated values. **Fixed (engine 0.4.0, audit R1):** the engine returns `N / 86.4` unrounded and the UI rounds for display, so a small cut stays visible. | Truncation understated every cut and every gain by up to 0.1 l/s. |
| Q16 | Farm spec M | **Selected fragmentation is hard-coded to the area method for some farms.** In client catchment `M32`, `M33` and `M42` (Farm B, Farm C, Farm D) are `=G/rFarmSpec_AreaTotal`, not the `IF(method = Area, H, IF(method = Hi/Lo, K, L))` every other row uses. client catchment uses Area, so nothing changes today, but switching the workbook to Hi/Lo or Specific would give those three farms area shares and the sum would no longer be 1. The engine applies the chosen method to every farm. | Confirm this is a leftover edit. Otherwise a Hi/Lo run in the workbook and in the app will disagree. |
| Q17 | Farm sheet AB, Shortfalls R | **Incremental shortfalls do not add up to the outlet shortfall.** AA is clamped at 0, so a surplus on one branch is never credited against a deficit on another. Example: tributary A is 100 m³/day short (AA = AB = −100), tributary B has 300 m³/day to spare (AA = 0), and confluence farm C passes both through. Then `AA_C = MIN(200, 0) = 0` and `AB_C = 0`. Σ AB = −100 even though C and the outlet meet the EWR, and [Shortfalls] still asks A to cut 100 m³/day. A farm that adds water (return flow, a dam release) also gets no credit, because AB ≤ 0. A gauge with several upstream elements summed their AA (`I = Σ AA`) instead of computing `MIN(ΣU − ΣZ, 0)`; **fixed in engine 0.4.0** (audit G1). The farm attribution (AB) is still **mirrored**. | Decides whether the EWR has to be met reach by reach (current maths) or only at the outlet or other gauges. It changes every farm's curtailment. |
| Q18 | Transfers | **Several transfers from one dam can overdraw it.** Each "Draw From" column is `MIN(MAX(Q[t−1] − reserve, 0), cap)` on its own, so two transfers from the same source can each take yesterday's full storage. Example: storage 1 000 m³, two rules of 800 m³/day: 1 600 m³ leaves, the source has `avail = −600 + inflows`, and G, P and Q can go **negative**. The workbook has the same flaw, because its columns are independent. client catchment has only one transfer, so no result is affected. **Mirrored for now.** The engine should split the available volume in rule order, which makes no difference when the draws fit. That is an engine change for a later round (see docs/engine-review.md F1). | Negative storage and negative "supplied" are physically impossible. We need the hydrologist to choose a priority rule (rule order, or pro rata). |

---

## 4. The AI node-based model (v004 DEV)

This is an experimental rewrite of the ledger as a **16-node daily table**
(`Daily_Node_Ledger`) for client catchment, running 2013-04-24 … 2018-12-31. It is not
ported in V1. It shapes the later data model: the app's `node` table is already
general enough to hold these nodes.

- **Nodes:** headwaters, dam/bypass nodes, farms, a run-of-river node, a natural
  node, a confluence and the A1 gauge outlet. Each node has an upstream (up to
  2), a downstream, a calculation order, a local flow share, a dam-capture
  fraction, a river-abstraction fraction, a pump capacity (m³/day, computed as pumps ×
  m³/h × 24 h), pump trigger/stop %, pool storage, and flags
  (demand node, storage node, EWR node, include in outlet flow).
- **Ledger per node per day:** opening storage, local natural flow, captured to
  dam, bypass, upstream inflow, river available, transfers in/out, groundwater
  in, export, demand, pumped from river, demand met, shortfall, provisional and
  closing storage, spill, outflow, mass-balance and storage-balance errors.
- **Pump scenarios** (per farm): *Dam-first* (the dam until it drops below the
  trigger, then the river), *River-first*, *Trigger-based* (switch at 40–60%
  storage), *Run-of-river* (no storage). These are planned: seasonal
  river-first, no river pumping, drought-saving, opportunistic pumping, and
  groundwater (none / supplemental / primary / emergency; direct or to-dam).
- **Stress classes** (supply ratio): **≥ 95% Low, ≥ 85% Moderate, ≥ 70% High,
  ≥ 50% Severe, otherwise Critical**, reported per farm and per month.
- **Naturalisation:** present-day flow + irrigation demand = naturalised flow,
  compared with observed and simulated flow at the outlet.

**Unfinished or wrong as found:**

- Every farm shows 100% met. Naturalisation adds demand back into the flow that
  then supplies that same demand, which makes the result circular.
- Opening storage uses `OFFSET(…, −16, 0)` to find the same node's previous day.
  It only works while the table is sorted by date then node and has exactly 16
  nodes.
- Parameters are defined but unused, and `LocalFlowShare` sums to **1.01**.
- Some node names are spelled differently from b023, so matching by name
  between the two workbooks fails.

---

## 5. The AI runoff module (DEV 003)

This is an experimental **bucket rainfall-runoff model**, meant to replace the
b023 rain→flow recession routine as a *natural flow generator*. It uses Power
Query and table formulas.

- **12 hydrological units** (one per client catchment farm). Each has an area, a MAP
  and a reference rain gauge. At present every unit uses the same single gauge.
- **16 routing nodes** that match the node-based model.
- **Per unit per day:** a soil store (`SoilMax` 80 mm) and a constant ET loss
  (1.5 mm/day). Runoff starts above a threshold. A quickflow store and a
  baseflow store each drain with their own coefficients. Unit runoff is then
  routed through the nodes to the outlet.
- **Calibration at the outlet gauge:** NSE **0.624**, PBIAS **−7.7%**.

**Known issues found in review:**

- About **56% of effective rain is untracked**: it leaves the soil bucket
  without being counted as ET, runoff or storage, so the water balance does not
  close.
- `RainfallFactor` is defined but not used in the formulas.
- Soil drainage can **create water**: drainage is not limited by the store's
  contents.
- Node 16 (the outlet) is hard-coded instead of taken from the network.
- Parameters are left unused (`LagWeight`, `RainfallExponent`,
  `BaseflowFraction`, `QuickflowRecession`).

**The author's own TODO (P1–P6):** P1 diagnose the hydrograph (best/worst years,
peaks, recession), P2 annual water-balance table (observed vs simulated MAR by
year), P3 multiple rainfall stations per unit, P4 metrics (R², NSE, KGE),
P5 per-unit calibration multipliers, P6 feed the node flows into the WBT.

In the app, this becomes an **alternative flow generator** behind the same
interface as §2.4: `rain (+ params) → natural flow per node`. The b023 farm
balance can then run on either. That work waits until the water-balance leak is
fixed and the hydrologist trusts the module ([plan.md phase 5](./plan.md)).

---

## 6. Porting strategy and regression testing

1. **Port b023 exactly, rounding included.** The workbook rounds at specific
   steps: gross mm to 2 dp, farm demand to 1 dp, and net demand, fragmented
   flows, storage and return flow to 0 dp. The engine must round at the same
   points with Excel's `ROUND` semantics (half away from zero). `INT` floors.
2. **Fixtures come from the client workbook and are never committed.**
   `scripts/wbt-import` reads the client catchment inputs and the workbook's own
   computed columns into `data/` (for example `data/client-catchment/expected.json`; gitignored). The engine's
   regression tests load them when present and skip with a clear message when
   absent (for example on CI). Small synthetic fixtures that *are* committed
   cover the same code paths.
3. **Stage by stage:** natural flow (§2.4) → demand (§2.3) → fragmentation
   (§2.5) → farm balance and transfers (§2.6–2.7) → EWR and outputs (§2.8).
   Each stage is compared with the workbook's column for all 16 161 days. The
   target is **exact equality** on rounded columns and < 1e-9 relative
   difference elsewhere.
4. **Performance budget:** a full client catchment run (16k days × 13 elements) takes
   about **18 ms** in Node, which is fast enough to run in the browser as you
   type and in Lambda on request.
5. **Every run records `engine_version`** and a snapshot of its inputs, so an
   old result can always be explained after the model or the project changes.

---

## 7. Glossary

The app's `/help` page carries a fuller, searchable version of this glossary
plus per-field help (`frontend/src/lib/help/content.ts`). Keep the two in
step when a definition changes.

| Term | Meaning |
| --- | --- |
| **A-pan** | Class-A evaporation pan. Monthly A-pan evaporation (mm) × crop factor ≈ crop water requirement. |
| **WR90 / WR2012** | *Water Resources of South Africa* studies (1990, 2012). They provide the A-pan, MAP and naturalised flow data per quaternary catchment. |
| **Crop factor (Kc)** | A monthly multiplier from A-pan evaporation to crop water use. |
| **Effective rainfall** | The share of rain on cropped land that reduces irrigation need (65% here). |
| **MAP** | Mean Annual Precipitation (mm/yr). "Hi/Lo MAP" splits a catchment into high- and low-rainfall parts. |
| **MAR** | Mean Annual Runoff (M.m³/yr). |
| **M.m³** | Million cubic metres (10⁶ m³). 1 m³/s = 86 400 m³/day. |
| **Pitman** | A monthly rainfall-runoff model used in South African water-resource studies (WR90/WR2012). "Pitman flow" = its naturalised flow series. |
| **Natural flow** | Flow as it would be with no farms, dams or abstraction. |
| **Naturalisation** | Rebuilding natural flow from observed flow by adding back abstraction and storage changes. |
| **Fragmentation** | Splitting catchment flow (or EWR) into per-farm shares. |
| **EWR** | Environmental Water Requirement: the flow that must stay in the river for the ecosystem. |
| **IFR / Reserve** | Instream Flow Requirement or Ecological Reserve, the South African legal terms for the EWR. |
| **Desktop Reserve Model** ("Desktop Version 2") | Software that produces monthly EWR tables by percentile and ecological category (e.g. category B, W. Cape wet). |
| **Pragmatic EWR** | b023's simplification: one fixed m³/day per month instead of a flow-dependent requirement, so farmers can plan for it. |
| **Ecological category** | A–F class of river condition that the EWR aims to maintain. |
| **Quaternary catchment** | The smallest standard SA catchment unit (e.g. A21A). |
| **CHIRPS** | Climate Hazards Group InfraRed Precipitation with Station data: satellite-based daily rainfall. |
| **Water year** | Oct–Sep in South African hydrology. The workbook orders monthly tables this way. |
| **Recession curve** | How flow decays day by day without rain. b023 uses a table from flow to daily factor. |
| **Base flow / quickflow** | The slow groundwater-fed part of the flow, and the fast storm response. |
| **Spill** | Water that overflows a full dam and continues downstream. |
| **Return flow** | The share of irrigation water that runs back to the river. |
| **Transfer** | Water moved from one farm's dam to another farm (pipeline or canal). |
| **NSE** | Nash–Sutcliffe Efficiency = 1 − Σ(obs−sim)² / Σ(obs−mean obs)². 1 is perfect; ≤ 0 means no better than the mean. |
| **PBIAS** | Percent bias = 100 × Σ(obs−sim) / Σobs (the engine's sign). Positive means the model under-predicts volume. |
| **KGE** | Kling–Gupta Efficiency (Gupta et al. 2009): 1 − distance from perfect correlation, variability ratio and bias ratio. |
| **Log-NSE** | NSE on the logarithm of flow, which weights low flows. |
| **Calibration window** | The period the fit is scored over (the workbook's 2010–2018 for client catchment). |
| **Water year** label | The app labels a water year by the year its October falls in: 2010 = Oct 2010 – Sep 2011, shown as 2010/11. |
| **RMSE** | Root-mean-square error. |
| **Hydrological unit (HU)** | A sub-catchment with its own area, MAP and rain gauge (runoff module). |
| **Stress class** | Low / Moderate / High / Severe / Critical, from the supply ratio (node-based model). |
