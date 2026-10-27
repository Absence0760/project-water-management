# verify/ — an independent cross-check of the engine

A second implementation of the model's daily chain, in Python, written
**only from the documentation**, run beside the engine's public `runModel` on
the same inputs, day by day and column by column. The engine's own checks
(model.md §6 Verification) show the model agrees with itself; the Excel audit
workbook shows one farm's formulas recompute in someone else's tool; this
shows that what the docs say the model does is what the engine does, across
whole networks.

The operator decided (2026-09-30, docs/followups.md § Verification) to
rebuild `verify/` this way rather than delete it. The earlier plan transcribed
the b023 workbook's formulas, which the engine deliberately no longer follows
(engine-audit.md), so it was dropped; its formula dumper moved to
`scripts/wbt-import/dumpwb.py`.

## The independence rule

`model.py` was written from `docs/model.md`, `docs/engine-audit.md`,
`docs/data-model.md` and the public shape of the input and output
(`packages/engine/src/project.ts`, for the JSON field names only). Nothing
else under `packages/engine/src` was read while writing it, and a change to
it must keep to that. Where the docs don't say enough to write a step, that
is a documentation finding: settle it from `runModel`'s outputs on a small
input (a probe, `probes.py`), fix the doc to say what the engine does, and
add the probe. Never read the engine's code to find out.

`run_engine.ts` is the other side: it calls `runModel` and writes what it
returns. It imports the engine by path and the example catchments from
`backend/scripts/examples/`, and runs with the backend's `tsx`.

## Files

| File | What |
| --- | --- |
| `model.py` | The Python model (stdlib only). `run(input)` returns the daily series, the allocation summary's run-dependent rows and coverage counts; `unsupported(input)` lists what an input uses beyond phases 1 and 2a, per-unit rain and rainfall stations; `Refused` is a run the docs say is refused |
| `run_engine.ts` | `run <in> <out> …` runs `runModel` on each input; `examples <dir>` writes the three example catchments' inputs (`pnpm seed:examples`' data, without the automatic fit) |
| `generate.py` | This harness's own seeded random-network generator (stdlib `random`; not the engine's fuzz generator, which is never read). Synthetic data only. `dense=True` puts every phase-2a feature in most networks (each in about a third otherwise) |
| `probes.py` | Hand-built inputs, each pinning a point the docs left open (§ Findings), and a few coverage probes for rules the random networks rarely reach |
| `diff.py` | Runs both sides on the examples, the probes and N random and dense networks and prints, per column, the largest absolute and relative difference, the known differences and a coverage count |
| `test_verify.py` | The guard: agreement, the mutation self-test and the generator's scope |

## Running it

```bash
pnpm test:verify                                   # the guard: ~6 min locally (examples, probes, 12 random + 12 dense networks, 172 mutants)
VERIFY_TEST_RANDOM=200 VERIFY_TEST_DENSE=200 pnpm test:verify   # what CI runs: agreement on 200 of each
python3 verify/diff.py --random 100 --dense 100 --seed 1000     # the report; --keep DIR keeps the inputs and outputs, --verbose lists engine-only series
```

It needs Python 3.14 and the repo's `pnpm install` (for `tsx`); no database,
no network. CI runs it as the `verify` job (`.github/workflows/ci.yml`).

## What phase 1 covers

The core daily chain, with every setting of it the generator varies:

- **Rain used** (§2.4, §2.4b–d, §2.10a): catchment rain, else CHIRPS × the
  calendar-month bias factor (monthly or `'none'`; the fit's minimum sample,
  pooled fallback and 0.25–4 clamp; the low-vs-CHIRPS years, the flagged zero
  runs and the missing periods left out of it), else forecast rain; zero-rain
  runs (the wet-season 60-day rule, the plain 180-day rule, `'missing'` /
  `'asRecorded'`, listed missing periods as dates or water years; engine ≥
  1.81.0, a flagged day kept dry where CHIRPS reads at most the fill
  threshold `fillAboveChirpsMm`);
  multi-day accumulations (detection, `'spread'` / `'asRecorded'`, and their
  days left out of the fit; engine ≥ 1.70.0, a blank or listed-missing stretch
  of more than 7 days ending the run, and a reading straight after one set
  aside); the run window from the rain record or the
  simulation settings; the demand threshold.
- **GR4J** (§2.4a): the production and routing stores, both unit
  hydrographs, the exchange (X2 ≠ 0), the warm-up cycling the historical days
  only, PE from the pan coefficient × A-pan or a monthly PE row, and under a
  monthly row a daily reference ET series (`evap_et0_mm`, engine ≥ 1.102.0,
  issue #604 R5-E) as it stands on the days it has a value ≥ 0 (probes
  `daily-et0-monthly-pe`, `daily-et0-pan-pe`, `daily-et0-zero-row`).
- **Crop demand** (§2.3): gross demand from A-pan × crop factor (28.25-day
  February), effective rain (annual or monthly fraction) through the
  soil-water store, D = F ÷ e with the plantings' efficiencies combined as
  the weighted harmonic mean (N1). Engine 1.72.0's irrigation systems: the
  project's table (absent = the SABI defaults, or edited with rows of the
  project's own), a crop's default system and a unit's own system per
  planting, resolved in that order, a system the table lacks skipped for the
  next, then a pre-1.72.0 crop's own efficiency, else the unit's (the
  generator's `add_irrigation_systems`, its own random stream).
- **Return flow** (§2.3, engine ≥ 1.71.0): r as a share of the water
  supplied, T = r × G, capped at 1 − e at the unit's combined efficiency e
  (the losses), a demand object's own return share on its part.
- **Dams** (§2.7, §2.7a): the power-law area (and the unknown-area estimate),
  rain on the dam, evaporation (single or monthly lake factor, the b > 1
  limiter), seepage and its return share, the minimum operating level, spill,
  sub-m³ dams, farms without a dam.
- **Routing** (§2.5, §2.7): area, hi/lo and manual flow shares, the farm
  balance K … V in network order, gauges.
- **Transfers** (§2.6): priorities, one rate or monthly rates, daily caps,
  the receiver's room (its dam's own gains and losses, its demand) shared pro
  rata, and the source's water in bands at each rule's reserve; a dam rule
  out of the catchment (toNodeId null, engine 1.86.0) runs as any rule with
  no receiver (probe `transfer-out-of-catchment`, and a fifth of the random networks);
  from engine 1.88.0 its source's surface use, so under a cap the rules out
  of one source share its surface room pro rata as an outside receiver of
  their own and the volume counts against the year's volume
  ([engine-audit.md X1](../docs/engine-audit.md), probe
  `transfer-out-of-catchment-cap`).
- **EWR** (§2.7, §2.7b): Y, Z, AA and AB; the outlet and gauge EWR sites
  (`ewrSite` on or off); the attribution with J_int, Σ A + N = D, the charge
  as the largest share, its irrigation part and the binding site.
- **Refusals**: no evaporation (`GR4J_NO_PET`), flow shares over 1, no
  catchment area.

Every one of the engine's daily series for these is compared, except the
observed-flow and rain-diagnostic series (`observed_flow`, `rain_chirps`,
`rain_source`, `rain_catchment_missing`, `rain_catchment_spread`), which are
inputs echoed or labels rather than model results. Summaries (curtailment,
compliance grids, assurance, the water account) are not compared: they are
reductions of these series, which the engine's own checks recompute.

## What phase 2a covers

Added on engine 1.53.0 (tracking issue #259), each written from its
docs/model.md section, in about a third of the random networks and most of
the dense ones:

- **Boreholes** (§2.7d): the node's combined capacity and individual
  boreholes, their modes (`primary`, `supplemental`, `emergency` and the
  combined `drought` rule, each below its level), the dam target (primary
  and emergency only on a day the dam is drawn for demand, supplemental for
  the dam's shortfall, dead storage first), annual caps reset on 1 October,
  and stream depletion (its lag store and the depletion the river can't pay
  carried as a deficit); modes and targets on a node without a dam.
- **Allocations** (§2.12a): the cap per source (the budget prorated by the
  allocations' validity, the room MIN(left, the licence limit of the day's
  months and rates), shared by every draw on the source; a day with none of
  the source's allocations in force uncapped, its room blank and its use not
  counted, engine ≥ 1.70.0, probes `cap-before-licence` and
  `cap-licence-from-september`), a demand-sized off-take into a
  capped unit sized to MIN(demand, its surface room) (§2.6a, engine ≥
  1.70.0, probe `offtake-into-capped-unit`), the `allocation_*`
  columns, and the summary's `capReached` and `limitBound` rows (with the
  day's kind); full-allocation runs (k per unit and water year over both
  sources, 1 in a year with none in force, probe `full-allocation-gap-year`,
  with a forecast tail, the floor held, the summary's `scaled` rows; k
  fitted on the demand before the demand factors, which then apply after
  it, engine ≥ 1.70.0); compare-only runs. The take at the river intake of a
  dam beside the river and the water such a dam gives other units (§2.12,
  engine ≥ 1.82.0: `intake_take`, `received_at_intake`, River to dam and the
  top-up off-take less the same day's spill at most that diversion, the river
  water used directly, dam rules and remote shares split by which side of
  the rule is measured at the intake).
- **Demand factors** (§2.3 item 4a) from `demandFactorFrom`.
- **Demand objects** (§2.7f): monthly and per-unit sizing (losses, monthly
  factors), schedules (always, yearly, a date range, Easter-relative, by
  weekday; the last window wins), the priority classes around the crop and
the ranks within one (engine ≥ 1.64.0),
  returns and external destinations, and the basic-needs floor under a
  demand factor.
- **River off-takes** (§2.6a): network order with off-takes, demand and
  capacity sizing (shares of the destination's need, the dam top-up), rates
  by month, daily caps, priorities, hands-off flows (and the EWR), canal
  losses and their return to a chosen unit, off-take water used first at the
  destination, and the attribution's seepage legs.
- **Other water users** (§2.7c): priority and non-priority, returns, the priority users’
  requirement passed by the farms upstream, boreholes on users.
- **Supply rules** (§2.7e): river first, the trigger with its stop level,
  run of river, pump capacities, what the pump must leave in the river.
- **Dam curves and releases** (§2.7a): survey curves (sorted, rejected when
  unusable) with the evaporation limiter on a segment's slope, pass-inflow
  and fixed releases with the outlet capacity, and the fixed release's room
  for transfers.
- **Hands-off flows** (§2.7h): a flow by month and/or the EWR at the farm,
  on farms with and without a dam; River to dam by month.
- **River abstractions** (§2.7j, engine ≥ 1.65.0): the crops or a demand
  object on a river pump of their own beside the dam, the dam side serving
  the rest, the takes by supply level from the flow passing the dam above
  what must pass, pools drawn after the flow, refilled last; storage only from engine 1.86.0 (no evaporation).
  Not the pump-limited measure of engine 1.66.0 (`river_pump_limited@`): the
  model doesn't write it, so the comparison notes it as engine-only; the
  engine's own self-checks (`checkWorkings`, `checkReportTotals`) bound it.
- **The crop supply table** (§2.7k, engine ≥ 1.73.0): the crops' demand
  in shares of the unit's dam side, the crops' river abstraction and another
  unit's dam; the remote share settled in the supplying unit's step before
  its spill, pro rata between receivers, through a pipe; the receiving unit
  after its source in the network order, and a remote share the unit drains
  into skipped; the remote share counted as a transfer in the EWR
  attribution (`remote_dam_in`, `remote_dam_out`).
- **Bed losses** (§2.6b, engine ≥ 1.75.0): MIN(cap, f × outflow) lost in
  the reach below any node but the outlet, the node below receiving the
  rest; a priority user's claim grossed up through every reach on the way, and
  the requirement crossing each less what the claims were grossed up by for
  it (`reach_loss`, `senior_reach_loss`).
- **A unit's base-flow loss and gain** (§2.6b, engine 1.86.0): MIN(loss, I)
  taken off the unit's runoff and the gain added before the dam/river split,
  the priority pass and the hands-off flow, the runoff column staying I; the
  EWR attribution's net impact reading the runoff after them
  (`baseflow_loss`, `baseflow_gain`; probe `baseflow-loss-and-gain`, and a
  quarter of the random networks).

Every daily series these produce is compared (the per-rule transfer and
per-object columns included), and `RunSummary.allocations`' run-dependent
rows (`capReached`, `limitBound`, `scaled`) within the same tolerance.

## What per-unit rain covers

Added on engine 1.78.0 (issue #482 part E), written from docs/model.md
§2.4h, in about a third of the random networks and most dense ones
(`generate.py` `add_unit_rain`, its own random stream, so the rest of a
network is unchanged):

- **The rule** each land unit (a farm with an area above 0) gets, from the
  records the input holds (any reading at all, a negative one on a unit's
  record being a no-data code): its own gauge; the catchment gauge × clamp(unit
  MAP ÷ gauge MAP); its own CHIRPS; the catchment forcing. A record of
  nothing but blanks and no-data codes is no record.
- **Each rule's chain**, day by day: the gauge rain G (the prepared catchment
  rain on its recorded days, before the CHIRPS infill; a negative reading is
  a reading and runs as 0), the unit's own gauge after the catchment's
  checks (below), the unit's CHIRPS levelled by clamp(unit MAP ÷ its
  mean annual rain) over the complete calendar years in the MAP period (every
  complete year of the record when fewer than 10 are there; with none, the
  catchment's §2.4b monthly factors, else raw; complete years averaging 0 mm
  make it unusable, below), then the catchment's rain × the MAP ratio (else
  × 1), and 0 mm with no value.
- **Forecast days** through the catchment's rain (× the MAP ratio on a unit
  where rule 2's conditions hold, or levelled like the unit's CHIRPS for a
  CHIRPS-GEFS forecast, below), the warm-up cycling each unit's historical
  days only.
- **Runoff**: GR4J per land unit with the one parameter set, the catchment
  PE and its own area; its runoff as the unit's local inflow in place of
  natural × share; natural flow the units' sum; the catchment area the units'
  areas summed (`catchmentAreaKm2` ignored); the catchment's GR4J series as
  the units' area-weighted means; no land unit at all runs the catchment
  rain, as without the setting.
- **Off**: a network with unit records and MAPs but `mode: 'catchment'`
  (15 % of those networks) runs as without them.
- **The reference gauge** (engine 1.80.0, issue #500, §2.4h *Reference
  gauge*), in half the per-unit networks (`add_unit_rain_reference`, drawn
  last from the same stream): the catchment gauge or a farm's own as the
  reference gauge, a reference farm (now and then one without area, so not
  a land unit), and its cell series (the gauge × a bias per calendar month,
  some past the clamp, with gaps and a no-data code, or none). Python fits
  the 12 factors from the text (90 shared days and 50 mm, else 1; the
  clamp) and levels every unit's CHIRPS by factor × k_unit (below; until
  issue #500's decisions, × clamp(unit MAP ÷ the reference unit's MAP)). The
  ensemble's engine-only `pinnedFactors` is outside it.
- **Issue #500's decisions** (operator, 2026-10-09; `model.py` written from
  the issue's decision table, ahead of the docs; `generate.py`
  `add_unit_rain_decisions`, its own random stream):
  - *1a, k_unit*: with a reference, a unit's CHIRPS reading v is
    v × f[month] × k_unit, k_unit = clamp(unit MAP ÷ the unit's mean annual
    (CHIRPS × f)) over its complete calendar years in the MAP period (every
    complete year with fewer than 10 there); without a MAP, or with no
    complete year yet, k = 1 (the factors alone). The reference unit is
    levelled the same way.
  - *1c*: the reference fit reads the checked gauge rain: the catchment
    gauge as rule 2 reads it (after §2.4c and §2.4d, before the CHIRPS
    infill), a unit's own gauge after item 6's checks, and leaves the
    accumulation windows (and readings set aside after an outage) out, as
    §2.4b does.
  - *4*: `UNIT_MAP_MIN_YEARS` = 10, for the MAP factor and k_unit alike.
  - *5*: with `forecastRainSource` 'chirps_gefs', a unit whose chain falls
    to the catchment's rain on a forecast day (the catchment's rain from
    `rain_forecast_mm`) and has usable CHIRPS of its own takes the forecast
    levelled like that CHIRPS: a level that reaches the unit's MAP (f ×
    k_unit, rule 3's MAP factor) alone; one that only shapes it (§2.4b
    factors, f without k_unit) × the MAP ratio too; raw CHIRPS, and
    otherwise, and for 'other' or absent, × the MAP ratio as before.
  - *6*: a unit's own gauge (negative values blanked as no-data codes) goes
    through `prepare_rain`, the catchment's §2.4c zero runs and §2.4d
    accumulations, with the catchment's modes, fill threshold and
    data-quality limits but none of its dated lists, against the unit's own
    CHIRPS, else the catchment's; a day the checks remove falls to the next
    link of rule 1 (own CHIRPS, levelled).
  - *7a*: a unit's CHIRPS whose complete years average 0 mm (with a MAP or
    without one) is unusable: every link reading it is skipped, with or
    without a reference.

Compared: each land unit's `rain_unit` and `runoff_natural`, and every
series downstream of them.

Points of issue #500 the decisions left open, each now pinned by a probe
and settled by engine 1.85.0 (§2.4h):

- **A unit gauge's checks and the catchment's dated lists.** The listed
  missing periods, keep-dry periods, kept readings and listed accumulations
  name days of the catchment gauge's record, so they don't apply to a unit's
  gauge; the modes, the fill threshold and the data-quality limits do
  (probe `unit-rain-gauge-catchment-settings`, unit u1). This harness first
  applied the missing periods too.
- **Which CHIRPS those checks read.** The unit's own, else the catchment's
  `rain_chirps_mm` (the same probe, unit u2). This harness first gave a
  unit without CHIRPS of its own none, so no fill threshold and no
  accumulation test.
- **Accumulation windows in the reference fit.** Left out, as §2.4b leaves
  them out, for the catchment gauge and a unit gauge alike (probes
  `unit-rain-reference-checked` and `unit-rain-reference-unit-gauge-checked`,
  June 2018). This harness first fitted on the spread rain.
- **Unusable CHIRPS without a MAP**: yes (probe `unit-rain-unusable-chirps`,
  unit c0), and **a CHIRPS-GEFS forecast on a unit without a reference**:
  rule 3's levelling (probe `unit-rain-forecast-gefs-noref`). The engine
  agreed with this harness's reading on both. The run summary's `unitRain` block (rules,
factors, day counts, per-unit balances) is a reduction of these and not
compared; the engine's `checkRunoffBalance` closes it. The areal correction
(§2.4g) stays unsupported, so a rule-4 unit runs on the catchment rain × 1.

## What rainfall stations cover

Added on engine 1.91.0 (issue #553), written from docs/model.md §2.4i, in
about 30 % of the random networks and 65 % of the dense ones (`generate.py`
`add_rain_stations`, its own random stream, drawn last, so the rest of a
network is unchanged; station records reach up to six years before the
network so some pairings have their five years):

- **The rule** for the catchment (`settings.rainStations.catchment`, under
  Fragmentation and under per-unit rain alike) and for each land unit
  (`units`, per-unit rain only): the station's checked reading × r, r =
  clamp(area MAP ÷ station MAP, 0.25–4), × 1 with `scaleToMap` false or
  either MAP missing; on its gaps the area's CHIRPS (`rain_chirps_mm`, a
  unit's `rain_chirps_mm@<unit>`) × the pairing factor of `correctAgainst`
  (default its own station), as is; then the catchment: the forecast, a
  unit: the catchment forcing × 1; else 0 mm.
- **The checked record**: negative values blanked; §2.4c and §2.4d with the
  catchment's modes, threshold and limits but none of its dated lists,
  against the CHIRPS at the station (its cell, else its site unit's CHIRPS,
  else the catchment's); the station that is the catchment gauge
  (`isCatchmentGauge`) with the dated lists too, against the catchment's
  CHIRPS (below); then the unreliable periods blanked.
- **The pairing**: per calendar month Σ station ÷ Σ CHIRPS at the station on
  the days both have a reading (accumulation windows out), whole records,
  90 days and 50 mm else 1, clamped; refused with no record, no CHIRPS at the
  station (never the catchment's), or fewer than 5 complete calendar years in
  common, counted on the record as the forcing reads it (engine 1.96.0,
  engine-audit.md RS6): a spread accumulation's days count as read, while
  an unreliable day, a blank outage and the reading set aside after it, or
  a window's blank days run as recorded make the year incomplete.
- **The catchment under its station**: the stored gauge unread, no §2.4b
  factors, the catchment MAP `catchmentMapMm` (when in 1–12 000 mm) else the
  land units' area-weighted mean (none, so r = 1, when a land unit has no
  MAP), the run window from the first to the last day the catchment rain has
  a value (a checked station day, a corrected CHIRPS day, a forecast day).
- **Units without a station** keep §2.4h's chain on the catchment's rain,
  the station's when the catchment has one: rule 2's gauge rain is station ×
  r and its MAP ratio divides by the level that rain is at, station MAP × r
  (`gaugeMapMm` only switches rule 2 on; without the station's MAP rule 2
  doesn't apply), the same ratio on the unit's gaps and forecast days; a
  `rain_catchment_mm` reference gauge is fitted on station × r with the
  station's accumulation windows left out. An assignment without a station
  id, or naming a station without a record, runs as without it.

Compared: `rain_final`, `rain_used`, each land unit's `rain_unit` and
`runoff_natural` and everything downstream. `summary.stations` is a
reduction of these and isn't compared. The engine-only pinned pairing
factors (`rainStations.pinnedFactors`) and a unit's own forecast
(`rain_forecast_mm@<unit>`, outlook members) stay out (§ Phase 2b).

Probes: `station-units` (two units sharing a station at ratios 1.2 and 0.7,
ratios clamped up and down, `scaleToMap` false, `correctAgainst`, a unit
without CHIRPS, a unit without a MAP, a unit without a station; gap,
no-data, zero-run and unreliable days on the corrected CHIRPS; a pairing on
a site unit's CHIRPS with a month under 50 mm, one on a cell with a clamped
month; the catchment's missing list not applied), `station-pairing-refused`
(five complete years fitted, four refused, a spread accumulation window
counted as read so its year is complete, a station with no CHIRPS at it,
`correctAgainst` a refused pairing), `station-pairing-as-recorded` (the same
with accumulations run as recorded: the window's blank days make its year
incomplete, so that pairing is refused), `station-catchment` (Fragmentation on a station that is
the catchment gauge: the units' mean MAP, its missing list, its zero run
checked against the catchment's CHIRPS, a refused pairing falling to the
forecast), `station-catchment-map` (an entered catchment MAP, clamped; the
catchment's CHIRPS × a site unit's pairing; a unit on a refused pairing
falling to the station-forced catchment rain), `station-catchment-window`
(the run window from the checked station days),
`station-catchment-reference` (the reference fit on station × r, its
window left out) and `station-catchment-rule2` / `-no-map` (rule 2 at the
station rain's level, 900 mm not `gaugeMapMm`'s 450, on station days, gaps
and the forecast; no rule 2 without the station's MAP).

## What the EWR split covers

`settings.ewrSplit` (model.md §2.5b, engine ≥ 1.94.0, issue #553): with
`'naturalMar'` under per-unit rain, each unit's EWR share is its own
`runoff_natural` (days above 0) summed over the complete water years of the
historical days, else every historical day, ÷ the units' total in node-id
order, every farm without runoff at 0; with no runoff over the period, and
under catchment rain, the flow shares. `add_ewr_split` (its own random
stream, last) sets it on half the per-unit networks and a tenth of the
others. Compared: every unit's `ewr` and everything downstream
(`ewr_cumulative`, `ewr_shortfall`). Probes:
`ewr-split-station-units` (station-units' network: two units on one station,
one draining into the other, twelve calendar years whose complete water years
leave out the first nine months) and `ewr-split-short-run` (eight months, no
complete water year: the whole run). Mutants: the split ignored, and the MAR
taken over every day instead of the complete water years.

## Phase 2b (not covered yet)

`model.unsupported()` names each of these, and the generator never produces
them; diff.py refuses an input that uses one. Tracked as one item in
docs/followups.md § Verification ("`verify/` phase 2b").

- the seasonal outlook's engine-only per-unit inputs (a unit's
  `rain_forecast_mm@<unit>`, `settings.unitRain.pinned`), §2.4h and §2.15,
  and the uncertainty ensemble's pinned reference factors
  (`settings.unitRain.reference.pinnedFactors`), §2.4h, and pinned station
  pairing factors (`settings.rainStations.pinnedFactors`), §2.4i;
- Reserve rule tables (and audit A1–A7), §2.9c–d;
- forecast mode (`runForecastChecked`; forecast rain as the last rain source
  *is* covered), §2.4f;
- calibration (the fit itself; the calibration statistics);
- land cover, §2.5a;
- time-varying development (sediment, a dam in service from a date,
  abstraction from a date), §2.7g;
- demand factors by part (`partDemandFactor`, the `demand.scale` scenario op
  with a part), dated demand factors (`demandFactorWindows`, the op with
  `from`/`to`, engine ≥ 1.82.0), and drought restrictions once #258 merges
  (with a Priority user's fixed restriction %, engine 1.86.0, §2.7i);
- rain-source periods (§2.4e), the areal rainfall correction (§2.4g), the
  daily A-pan series (§2.3a), CHIRPS fit ranges (§2.4b), the CHIRPS quantile
  map (CR-23), keep-dry periods and the keep-dry guard, listed and kept
  accumulations, non-default data-quality limits (§2.10a) and the
  outlook-only settings.

## Tolerance

A column agrees when on every day `|python − engine| ≤ 1e-6 + 1e-9 × the
column's largest magnitude` (and both are blank on the same days). Both sides
are float64 but don't run the same operations in the same order, and GR4J's
stores carry a last-bit difference from day to day; in practice the largest
difference is about 1e-8 m³/day (on dam storage of up to millions of m³) and
3e-14 mm on rain, mostly under 1e-12 of the column's largest value. The
report's relative column shows `inf` where the engine's column is all zero
and Python's differs by float noise (well inside the absolute part). The tolerance is the model's own
float-noise level (model.md §6: daily balances to 1e-6 m³), not a way to
absorb a real difference. One exception: a dam's area is a power (or a
curve) of its start-of-day storage, so float noise in an empty dam becomes a
visible area (an exponent of 0.62 turns 1e-13 m³ into 4e-4 m²), and the
rain on it and its evaporation follow. On a day both sides started with a
storage within 1e-6 m³ of 0, those three columns aren't compared; the
storage itself still is, net of the water a noise area gained. That rain
can grow the noise past 1e-6 m³ over a wet spell (dense seed 206: an
exponent of 0.53 turned 8.5e-14 m³ into 1.2e-5 m³ in two days, and the next
day's area 0.03 m²). So each side carries the water its noise areas gained
(rain on the dam less evaporation on a noise day, never more than its
storage, until the dam lets it go), the next noise day is judged on the
storage net of it, and the storage column compares the net storage
(`_dam_noise` in diff.py). The water then goes on to real flows (dense 206:
it stood in for 1.28e-4 m³ of borehole pumping, and the depletion lag spread
that), so a case's tolerance is widened by exactly the water the two sides'
noise areas gained apart: Σ |Δ(rain on the dam − evaporation)| over the
noise days. It is 0 in a case without such an episode (177 of 180 station
cases; the other two under 1e-20 m³), never a fixed amount, and a real
difference is still bigger than the noise water it rides on. Likewise `ewr_binding_site` labels a day with a
charge, so on a day both sides' charge on the unit is within 1e-6 m³ of 0
(float noise either side of the attribution's 10⁻¹² cut-off: dense seed
1101, a 1e-8 m³ charge on 12 000 m³ of flow) the label isn't compared; the
charge still is.

`KNOWN_DIFFERENCES` in diff.py lists columns where the engine is known to
depart from its documentation, each with its docs/followups.md item; it is
empty, and no other disagreement is allowed.

## The mutation self-test

Agreement only means something if the cases exercise the rules. So
`test_verify.py` breaks `model.py` one documented rule at a time (172
mutants). Phase 1's 23 (the band-and-room order mutant went in engine 1.70.0, whose order is the one it tested): the receiver's room ignored; one
reserve pool for all rules (N6); the room without the dam's losses, or
counting what the receiver sent; no soil-water store; zero runs as recorded;
accumulations not spread, or tested over the whole run; raw CHIRPS; the
low-vs-CHIRPS median; a negative reading letting CHIRPS in; the binding-site
tie; the seepage return; dead storage; J_int; the demand threshold; the
forecast warm-up; planting efficiencies; the PE and evaporation month lengths;
the return share; the exchange; no catchment area. Phase 2a's and later 64: a
borehole's annual cap, the depletion lag and its carried deficit, the
emergency level, supplemental boreholes before the dam, the 1 October reset;
the cap's proration, the licence months and rate, the limit-bound kind, a
full allocation's sources, its tail years and no-demand rows; the floor, the
per-unit losses, the last schedule window, the priority classes, ranks
within a class; the canal
loss, its gross-up and return unit, an off-take's hands-off flow, off-takes
of one priority sharing in bands at their keeps (engine 1.69.0), the dam
top-up, an off-take leaving its source's pass-inflow target, rules of one
priority asking only MIN(limit, need) for off-takes and dam rules (not first
capped at the free flow or water), a receiver's room shared by what the
sources gave (not by what the rules ask: the wasted room) and offered again
while a receiver fills (not one round), and a top-up's and a dam rule's room
counting a fixed release's MIN(amount, outlet) in full (engine 1.70.0); non-priority users, user returns, the priority users’ pass; the trigger's stop
level, the pump's capacity and what it must leave; the survey curve, the
outlet on a pass-inflow release, dead storage and the room for transfers on
a fixed one; the hands-off flow on a dam, its EWR flag, no River to dam on
a dam on the river (engine 1.68.0), River to dam by
month; a cap's year with no licence in force, its per-day budget and the
use outside a licence's days, a full allocation's unlicensed year, an
off-take into a capped unit sized to the whole demand (engine 1.70.0);
blank days counted however many, a reading after a blank outage kept on its
day, and the 7-day limit off by one (engine 1.70.0); a return flow above
the losses not capped at 1 − e (engine 1.71.0); a unit's own system on a
planting ignored, a crop's default system ignored, and the project's
systems table ignored for the SABI defaults (engine 1.72.0); bed losses left
in the river, uncapped, a priority claim not grossed up for them, and the
priority requirement crossing a reach whole (engine 1.75.0); a base-flow
loss not capped at the runoff, the gain left out, and the split reading the
runoff before them (engine 1.86.0). Per-unit
rain's 21 (engine 1.78.0): the units' records used with the setting off; a
unit's inflow as natural × share; `catchmentAreaKm2` kept; no land unit
refused; the catchment's series weighting every unit alike; a unit's
warm-up cycling the forecast tail; a record of blanks picking rule 1; a
unit's negative gauge value read; CHIRPS before the gauge × the MAP ratio;
either factor unclamped; the MAP period ignored, or used however few its
years; incomplete years counted; a unit's
CHIRPS without a MAP raw; rule 1 skipping the unit's CHIRPS, rule 2 never
reaching it; G with the CHIRPS infill, or a negative G letting the CHIRPS
in; the catchment's rain filling a gap × 1. The reference gauge's five:
the clamp, 89 shared days, no 50 mm test, a no-data code read, a reference
without land setting the factors. Issue #500's 17: no k_unit, k_unit from
raw CHIRPS, k_unit unclamped, the year minimum at 9 or 11, CHIRPS averaging
0 mm levelled by the old fallback (with and without a reference) or only
unusable with a MAP, a CHIRPS-GEFS forecast at the MAP ratio, an uploaded
one levelled too, a unit's gauge read as recorded or its accumulations not
spread, the catchment's missing periods blanking a unit's gauge, a unit
gauge without CHIRPS checked against none, the reference fit reading the
gauge as stored, and it keeping the catchment's or a unit gauge's
accumulation windows. Rainfall stations' 25 (engine 1.91.0, one added on 1.96.0): the MAP ratio
unclamped, or 1 whatever the MAPs, `scaleToMap` false ignored; gap days ×
the MAP ratio too, or on raw CHIRPS; a unit's last gaps dry rather than the
catchment forcing; `correctAgainst` ignored; the pairing's five years at 4
or 6, its windows kept, its complete years leaving a spread window's days
out (before RS6), a month without the 50 mm test, a factor unclamped,
a station without CHIRPS at it paired with the catchment's; unreliable
periods read, the checks skipped, a negative value a reading; every station
given the catchment's dated lists, the catchment gauge's station without
them, or checked against the CHIRPS at it; the catchment's station ignored;
the catchment MAP an unweighted mean, `catchmentMapMm` ignored; the run
window from the stored record, or counting CHIRPS a refused pairing doesn't
correct; rule 2 dividing by `gaugeMapMm`, or by the station MAP without r,
or applying without the station's MAP; the reference fit keeping the
station's windows. The EWR split's 2 (engine 1.94.0): the natural MAR
split ignored, and its MAR taken over every day rather than the complete
water years. Each mutant must disagree with the engine somewhere on the examples,
the probes and the first 12 random and 12 dense networks (the dense ones and
five coverage probes reach the phase-2a rules a random network rarely
does). A new rule added to `model.py` gets a mutant; a mutant that passes
means the cases need one that reaches it.

## Findings

Phase 1, 2026-09-30 (engine 1.36.0): the examples, the probes and 750
random networks (seeds 1–150 and 1000–1599) agree on every compared column
(49 column kinds; largest difference 9e-9 m³/day). No engine behaviour
departs from its documentation in phase 1, so `KNOWN_DIFFERENCES` is empty.

Phase 2a, 2026-09-30 (engine 1.53.0): the examples, the 12 probes, 800
random and 800 dense networks (seeds 1–400 and 1000–1399 of each) agree on
every compared column (71 column kinds and the three allocation summary
parts; largest difference 6e-6, a dam area in m², 5e-11 of its column's
largest value) except on four networks, all one engine departure, **fixed in
engine 1.57.0** (erratum ER-12; the harness now allows no known case):

- **A float-noise demand switched on a dam-target borehole** (§2.7d). The
  docs say a primary or emergency dam-target borehole pumps only while the
  dam is drawn for demand, Dr > 0 to within 10⁻¹² × D. The engine switched
  it on for a rounding residual: random seed 1343, a crop requirement of
  1.4e-14 m³ left by the soil-water store (D = 1.4e-12 m³ at e = 0.01), and
  the emergency borehole pumped 495 m³ into its 495 m³ dam (Python: 0);
  dense seed 86, off-take water arriving at 980.5862268744551 m³ against a
  demand of 980.5862268744552 m³, and it pumped 1 590 m³ (dam 3 189 vs
  1 599 m³ after). The same noise demand made a day of `limitBound` read
  two ways (random and dense seed 145: 198 days vs 199 in water year 2010).
  Fixed at the source: rain within 10⁻¹² of the need covers it (§2.3, so no
  noise requirement arises), the switch judges the rest against the day's
  full demand, off-take water included (§2.7d), and §2.12a now states
  `limitBound`'s noise floor (a deficit of 10⁻⁹ m³ or less on a demand under
  1 m³ doesn't count), which `model.py` follows.

Two more disagreements were the harness's own, fixed here: Python kept the
factor of the year a forecast tail starts in on the tail's days in the next
water year (the docs meant that year's tail days only; now written into
§2.12a), and a noise-level storage in an empty dam showed as an area, and a
noise-level charge as a binding site (§ Tolerance). With the engine 1.57.0
fix, `model.py` also treats a forecast tail that starts on 1 October as
starting a part year of its own (no historical days to fit on), as the engine
does and §2.12a now says.

Per-unit rain, 2026-10-09 (engine 1.78.0): the examples, the 25 probes and
400 random and 400 dense networks (seeds 1000–1199 and 1–200 of each) agree
on every compared column (largest difference on the new columns 4e-9
m³/day on `runoff_natural` and 6e-14 mm on `rain_unit`). No engine behaviour departs from §2.4h.
Two points §2.4h didn't settle, both now written into it from the engine's
output (rows `unit-rain-map-period` and `unit-rain-no-land-unit` below):

- **A CHIRPS mean annual rain of 0 mm.** §2.4h said "with no complete year,
  the next sub-rule applies"; complete years that all read 0 mm left the MAP
  factor as unit MAP ÷ 0. The engine treats them as no complete year (the
  §2.4b factors, else raw, with a warning); a 0 mm year among rainy ones
  still counts in the mean.
- **Per-unit rain with no land unit.** §2.4h makes the catchment area the
  land units' areas summed with `catchmentAreaKm2` ignored, which with no
  land unit is 0, a run §2.4a refuses. The engine instead runs GR4J on the
  catchment rain over `catchmentAreaKm2`, as if the setting were off, with a
  warning. Python now does the same; a judgement call for the docs' owner,
  not a defect.

Points the docs left open, settled from `runModel`'s outputs (a probe each)
and written into docs/model.md:

| Probe | What the engine does | Where documented |
| --- | --- | --- |
| `band-and-room` | Engine ≥ 1.70.0: within one priority the source's reserve bands come first (pro rata to what each rule asks), then the receiver's room, pro rata to what the sources gave, in rounds while a receiver fills. Before 1.70.0 the room came first (pro rata to MIN(limit, the rule's free water)) and the bands after, which this probe pinned then | §2.6 |
| `room-while-sending` | A receiver's room is counted from yesterday's storage: what it sends at a lower priority the same day doesn't make room | §2.6 |
| `accumulation-window-run` | An outage reading's run test reads CHIRPS over the outage's last 92 days, not the whole outage (up to engine 1.83.0 a zero run's window; since 1.84.0 zeros are no run and a window's run is at most 7 blank days) | §2.4d |
| `low-vs-chirps-median` | The usual low-vs-CHIRPS ratio of an even number of years is the mean of the middle two | §2.10a |
| `negative-reading` | A negative catchment reading is a reading: it blocks the CHIRPS fallback, shows as recorded in `rain_final`, and runs as 0 mm | §2.4b |
| `zero-catchment-area` | A run with no catchment area (farm areas summing to 0 and no `catchmentAreaKm2`) is refused | §2.4a |
| `binding-site-tie` | A tie between two sites' charges goes to the more downstream site (already documented; pinned) | §2.7b |
| `forecast-tail-warmup` | The warm-up cycles the historical days only, never a forecast tail (already documented; pinned) | §2.4a, §2.4f |
| `full-allocation-tail-new-year` | Under a full allocation, a later water year a forecast tail runs into is a part year of its own, scaled over its tail days; only the year the tail starts in keeps its historical days' factor | §2.12a |
| `unit-rain-map-period` | A unit's CHIRPS whose complete years read 0 mm (a mean annual rain of 0) isn't levelled by its MAP: the §2.4b factors, else raw. A 0 mm year among rainy ones counts in the mean | §2.4h |
| `unit-rain-no-land-unit` | Per-unit rain with no land unit runs GR4J on the catchment rain over `catchmentAreaKm2`, with a warning, rather than refusing a zero area | §2.4h |
| `scaled-no-demand-tail-year` | A no-demand year's `scaled` row lists the volume registered over the days it is scaled on: its run days, the historical days of the year a forecast tail starts in (engine ≥ 1.57.0; before, that year listed k × demand = 0) | §2.12a |

Coverage probes (rules the docs settle, which the random networks rarely
reach in a way a mutant would show): `trigger-hysteresis` (the trigger rule
keeps pumping until the stop level, §2.7e), `junior-user` (a non-priority user
leaves the priority users’ requirement, §2.7c), `priority-user-fixed-restriction`
(a Priority user's fixed restriction %, engine 1.86.0, issue #523 B3, changes no
daily series without a drought restriction rule: it acts only in the curtailment
table and under the rule, both outside this cross-check, §2.7c) and `offtake-keep-bands` (off-takes
of one priority share the flow in bands at their keeps, so a sibling without
a hands-off flow doesn't let the others take below theirs, §2.6a, engine
1.69.0), `offtake-release-keep-and-floor` (an off-take leaves its source's
pass-inflow target in the river, and a top-up into a dam near its dead
storage counts its fixed release in full, §2.6a, engine 1.70.0, issue #90
Q26/Q27), `dam-rules-rationing-and-release` (two dam rules of one priority
share a dam running dry 3 : 1 by their limits; a dam rule's room into a dam
near its dead storage counts its fixed release in full; an empty source
beside a full one into one receiver, the full one filling the room; one
source into three receivers whose rooms fill one after another, its water
offered again twice: §2.6, engine 1.70.0, issue #90 Q25/Q26),
`outage-reading-set-aside` (a 30 mm reading after 150 blank days is set aside and CHIRPS fills its day, §2.4d, engine 1.70.0, issue #90 Q31)
and `short-blank-run-window` (7 blank days after 4 zeros are still a run, so the
reading is spread over the 7 blanks only, engine 1.84.0, issue #523 A2; its mutants
move the limit by one and count the zeros too), `flagged-zero-run-outage` (a
40 mm reading after a 200-day zero run §2.4c flags and fills: the flagged zeros
read as blank, so it is an outage and the reading is set aside rather than
kept beside the run's CHIRPS fill, engine 1.84.0, issue #523 A2, provisional;
its mutant lets the flagged zeros end the run), `unit-rain-forecast-warmup`
(each unit's warm-up cycles its historical days only, §2.4h, §2.4f) and `unit-rain-rules`
(§2.4h: one farm per point of the forcing rule, with gaps that walk each
chain to its end, a clamped MAP ratio, a negative catchment reading on a
gauge-MAP unit's wet CHIRPS day, a MAP period holding five of six complete
years, a record of no-data codes only, a farm without area, a forecast tail
and a `catchmentAreaKm2` that is ignored), `unit-rain-reference` (§2.4h
*Reference gauge*: a month with exactly 90 shared days and one with 89, a
month under 50 mm of CHIRPS, a clamped month, a no-data code on the cell, a
clamped MAP ratio, a unit without a MAP, a gauge unit's gaps filled from its
levelled CHIRPS; mutants move the day minimum by one, drop the 50 mm test,
the clamp and the MAP ratio) and `unit-rain-reference-not-land` (a reference
farm without area: each unit's CHIRPS levelled as without a reference).

Reference gauge, 2026-10-10 (engine 1.80.0): the examples, the 27 probes and
30 random and 30 dense networks (seed 1000) agree on every compared column,
written from §2.4h's text alone; `test_verify.py` with its six new mutants
passes. Nothing in §2.4h *Reference gauge* needed a probe to settle.

Issue #500's decisions, 2026-10-12 (written ahead of the engine change, on
branch `test/500-verify`, then checked on `feat/500-unit-rain`):
`model.py` follows the decision table (§ What per-unit rain covers),
`generate.py` adds them on a stream of their own, and nine probes pin them.
Against engine 1.85.0 on 2026-10-12, after the three readings above were
settled: the examples, the 37 probes and 100 random and 100 dense networks
(seed 1000) agree on every compared column (85 column kinds, one case
refused by both sides; largest difference 3e-14 mm on `rain_unit` and
2e-9 m³/day on `runoff_natural`). The networks reach every new rule
(unit-days or units, in how many networks): k_unit from a MAP 68 (36),
unusable CHIRPS 35 (30), CHIRPS-GEFS forecast days levelled 114 (9), unit
gauge days set aside 391 (12), unit gauge accumulation windows 4 (4),
reference fit days the checks left out 2 502 (21), of them in a window 2
(2). The non-engine tests pass (`test_verify.Generator`, `Gr4jPieces`).
The cross-check found no engine departure from the decisions; the three
disagreements were this harness's readings of points the decisions left
open.

| Probe | What it pins |
| --- | --- |
| `unit-rain-reference-kunit` | k_unit = clamp(unit MAP ÷ mean annual CHIRPS × f): over the ten MAP-period years when there are ten (p), every complete year with nine (q), the factors alone with no complete year (n), unusable CHIRPS under a reference (z), k_unit clamped to 0.25 (t), the reference unit levelled to its own MAP (r); a clamped (May) and a defaulted (June) month |
| `unit-rain-unusable-chirps` | Without a reference, CHIRPS averaging 0 mm is skipped: rule 3 with a MAP (c3) and without one (c0) run on the catchment's rain, a unit gauge's gaps (c1) fill from it |
| `unit-rain-forecast-gefs` | A CHIRPS-GEFS forecast under a reference: × f[month] × k_unit on units with usable CHIRPS (two months' factors), × the MAP ratio on a unit without CHIRPS and one whose CHIRPS is unusable |
| `unit-rain-forecast-gefs-noref` | The same without a reference: × rule 3's levelling (MAP factor, or the §2.4b factor without a MAP) |
| `unit-rain-forecast-other` | An uploaded forecast (`'other'`) keeps × the MAP ratio |
| `unit-rain-gauge-checks` | A unit's own gauge: a flagged wet-season zero run filled from its CHIRPS (kept at 0 where CHIRPS ≤ 2 mm), an accumulation spread over its blanks |
| `unit-rain-gauge-catchment-settings` | A catchment's listed missing period doesn't blank a unit gauge's days (u1); a unit gauge without CHIRPS of its own is checked against the catchment's (u2: a run day at 1 mm keeps its 0) |
| `unit-rain-reference-checked` | The reference fit leaves the catchment gauge's set-aside zero-run days and its accumulation window out |
| `unit-rain-reference-unit-gauge-checked` | The same with a unit's own gauge as the reference, and that unit's filled days on its levelled CHIRPS |

Rainfall stations, 2026-10-24 (engine 1.91.0, written from §2.4i on branch
`feat/553-rain-stations` while the engine landed beside it): the probes
and the station networks of random and dense seeds 1–259 (170 cases) agree
on every compared column. Three points were settled from the engine's
output, one of them an engine fix:

- **The run window under the catchment's station** ("follows the station's
  record in the gauge's place") is the first to the last day the catchment
  rain has a value: a checked station day (not a blank, set-aside or
  unreliable one), a corrected CHIRPS day (none when the pairing is
  refused) or a forecast day. This harness first took the stored records'
  spans (random seeds 4, 5 and 12; probe `station-catchment-window`). Now
  in §2.4i.
- **Which CHIRPS the catchment gauge's station is checked against**: the
  catchment's `rain_chirps_mm`, as today's run checks that record, not the
  CHIRPS at the station (random seed 4: a 193-day zero run whose cell reads
  0 kept 13 days dry, the 13 where the catchment CHIRPS reads at most 2 mm;
  probe `station-catchment`). Now in §2.4i.
- **The §2.4h reference fit under the catchment's station** (resolved, an
  engine fix). §2.4i said every reader of the catchment rain sees station
  × r and the stored gauge isn't read; the first engine 1.91.0 still fitted
  a `rain_catchment_mm` reference gauge on the stored, prepared gauge
  (dense seed 20: April 235 ÷ 1 644 mm, the stored gauge's sums, against
  339 ÷ 1 644 on the station; probe `station-catchment-reference`, where a
  unit's rain differed by up to 27.4 mm a day). Fixed in the engine
  (86b2b80dc, fitting on station × r), and with it rule 2's MAP ratio now
  divides by the station rain's level, station MAP × r, not `gaugeMapMm`
  (3e949975f; probes `station-catchment-rule2` and `-no-map`).

Engine 1.96.0 (engine-audit.md RS6, provisional) counts a pairing's
complete years on the station's record as the forcing reads it, so a spread
accumulation's days count as read; the factors still leave the window out.
`model.py` follows model.md § Accumulations and complete years, and station
E of `station-pairing-refused` (one accumulation in 2014) moved from refused
to fitted; `station-pairing-as-recorded` keeps a window-broken year refused.

§2.4i also said a negative value is a no-data code "as in §2.4b", where
§2.4b reads a negative catchment reading as a reading; it now says a value
below 0 is a gap in a station's record and no CHIRPS in an area's.
