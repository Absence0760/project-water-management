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
| `model.py` | The Python model (stdlib only). `run(input)` returns the daily series, the allocation summary's run-dependent rows and coverage counts; `unsupported(input)` lists what an input uses beyond phases 1 and 2a; `Refused` is a run the docs say is refused |
| `run_engine.ts` | `run <in> <out> …` runs `runModel` on each input; `examples <dir>` writes the three example catchments' inputs (`pnpm seed:examples`' data, without the automatic fit) |
| `generate.py` | This harness's own seeded random-network generator (stdlib `random`; not the engine's fuzz generator, which is never read). Synthetic data only. `dense=True` puts every phase-2a feature in most networks (each in about a third otherwise) |
| `probes.py` | Hand-built inputs, each pinning a point the docs left open (§ Findings), and a few coverage probes for rules the random networks rarely reach |
| `diff.py` | Runs both sides on the examples, the probes and N random and dense networks and prints, per column, the largest absolute and relative difference, the known differences and a coverage count |
| `test_verify.py` | The guard: agreement, the mutation self-test and the generator's scope |

## Running it

```bash
pnpm test:verify                                   # the guard: ~2–3 min locally (examples, probes, 12 random + 12 dense networks, 64 mutants)
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
  `'asRecorded'`, listed missing periods as dates or water years);
  multi-day accumulations (detection, `'spread'` / `'asRecorded'`, and their
  days left out of the fit); the run window from the rain record or the
  simulation settings; the demand threshold.
- **GR4J** (§2.4a): the production and routing stores, both unit
  hydrographs, the exchange (X2 ≠ 0), the warm-up cycling the historical days
  only, PE from the pan coefficient × A-pan or a monthly PE row.
- **Crop demand** (§2.3): gross demand from A-pan × crop factor (28.25-day
  February), effective rain (annual or monthly fraction) through the
  soil-water store, D = F ÷ e with crop efficiencies combined as the weighted
  harmonic mean (N1).
- **Dams** (§2.7, §2.7a): the power-law area (and the unknown-area estimate),
  rain on the dam, evaporation (single or monthly lake factor, the b > 1
  limiter), seepage and its return share, the minimum operating level, spill,
  sub-m³ dams, farms without a dam.
- **Routing** (§2.5, §2.7): area, hi/lo and manual flow shares, the farm
  balance K … V in network order, gauges.
- **Transfers** (§2.6): priorities, one rate or monthly rates, daily caps,
  the receiver's room (its dam's own gains and losses, its demand) shared pro
  rata, and the source's water in bands at each rule's reserve.
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
  months and rates), shared by every draw on the source; a water year with
  none of the source's allocations in force uncapped, its room blank, engine
  ≥ 1.70.0, probe `cap-before-licence`), a demand-sized off-take into a
  capped unit sized to MIN(demand, its surface room) (§2.6a, engine ≥
  1.70.0, probe `offtake-into-capped-unit`), the `allocation_*`
  columns, and the summary's `capReached` and `limitBound` rows (with the
  day's kind); full-allocation runs (k per unit and water year over both
  sources, with a forecast tail, the floor held, the summary's `scaled`
  rows); compare-only runs.
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
- **Other water users** (§2.7c): senior and junior, returns, the seniors'
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
  what must pass, pools drawn after the flow, refilled last and evaporating.
  Not the pump-limited measure of engine 1.66.0 (`river_pump_limited@`): the
  model doesn't write it, so the comparison notes it as engine-only; the
  engine's own self-checks (`checkWorkings`, `checkReportTotals`) bound it.

Every daily series these produce is compared (the per-rule transfer and
per-object columns included), and `RunSummary.allocations`' run-dependent
rows (`capReached`, `limitBound`, `scaled`) within the same tolerance.

## Phase 2b (not covered yet)

`model.unsupported()` names each of these, and the generator never produces
them; diff.py refuses an input that uses one. Tracked as one item in
docs/followups.md § Verification ("`verify/` phase 2b").

- Reserve rule tables (and audit A1–A7), §2.9c–d;
- forecast mode (`runForecastChecked`; forecast rain as the last rain source
  *is* covered), §2.4f;
- calibration (the fit itself; the calibration statistics);
- land cover, §2.5a;
- time-varying development (sediment, a dam in service from a date,
  abstraction from a date), §2.7g;
- demand factors by part (`partDemandFactor`, the `demand.scale` scenario op
  with a part), and drought restrictions once #258 merges;
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
storage itself still is. Likewise `ewr_binding_site` labels a day with a
charge, so on a day both sides' charge on the unit is within 1e-6 m³ of 0
(float noise either side of the attribution's 10⁻¹² cut-off: dense seed
1101, a 1e-8 m³ charge on 12 000 m³ of flow) the label isn't compared; the
charge still is.

`KNOWN_DIFFERENCES` in diff.py lists columns where the engine is known to
depart from its documentation, each with its docs/followups.md item; it is
empty, and no other disagreement is allowed.

## The mutation self-test

Agreement only means something if the cases exercise the rules. So
`test_verify.py` breaks `model.py` one documented rule at a time (64
mutants). Phase 1's 24: the receiver's room ignored, or shared after the source's bands; one
reserve pool for all rules (N6); the room without the dam's losses, or
counting what the receiver sent; no soil-water store; zero runs as recorded;
accumulations not spread, or tested over the whole run; raw CHIRPS; the
low-vs-CHIRPS median; a negative reading letting CHIRPS in; the binding-site
tie; the seepage return; dead storage; J_int; the demand threshold; the
forecast warm-up; crop efficiencies; the PE and evaporation month lengths;
the return share; the exchange; no catchment area. Phase 2a's and later 40: a
borehole's annual cap, the depletion lag and its carried deficit, the
emergency level, supplemental boreholes before the dam, the 1 October reset;
the cap's proration, the licence months and rate, the limit-bound kind, a
full allocation's sources, its tail years and no-demand rows; the floor, the
per-unit losses, the last schedule window, the priority classes, ranks
within a class; the canal
loss, its gross-up and return unit, an off-take's hands-off flow, off-takes
of one priority sharing in bands at their keeps (engine 1.69.0), the dam
top-up; junior users, user returns, the seniors' pass; the trigger's stop
level, the pump's capacity and what it must leave; the survey curve, the
outlet on a pass-inflow release, dead storage and the room for transfers on
a fixed one; the hands-off flow on a dam, its EWR flag, no River to dam on
a dam on the river (engine 1.68.0), River to dam by
month. Each mutant must disagree with the engine somewhere on the examples,
the probes and the first 12 random and 12 dense networks (the dense ones and
three coverage probes reach the phase-2a rules a random network rarely
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

Points the docs left open, settled from `runModel`'s outputs (a probe each)
and written into docs/model.md:

| Probe | What the engine does | Where documented |
| --- | --- | --- |
| `band-and-room` | Within one priority the receiver's room is shared first (pro rata to MIN(limit, the rule's free water)), then the source's reserve bands, pro rata to what each rule still wants after the room | §2.6 |
| `room-while-sending` | A receiver's room is counted from yesterday's storage: what it sends at a lower priority the same day doesn't make room | §2.6 |
| `accumulation-window-run` | The accumulation run test reads CHIRPS over the window's run days (the run's last 92 at most), not the whole run | §2.4d |
| `low-vs-chirps-median` | The usual low-vs-CHIRPS ratio of an even number of years is the mean of the middle two | §2.10a |
| `negative-reading` | A negative catchment reading is a reading: it blocks the CHIRPS fallback, shows as recorded in `rain_final`, and runs as 0 mm | §2.4b |
| `zero-catchment-area` | A run with no catchment area (farm areas summing to 0 and no `catchmentAreaKm2`) is refused | §2.4a |
| `binding-site-tie` | A tie between two sites' charges goes to the more downstream site (already documented; pinned) | §2.7b |
| `forecast-tail-warmup` | The warm-up cycles the historical days only, never a forecast tail (already documented; pinned) | §2.4a, §2.4f |
| `full-allocation-tail-new-year` | Under a full allocation, a later water year a forecast tail runs into is a part year of its own, scaled over its tail days; only the year the tail starts in keeps its historical days' factor | §2.12a |
| `scaled-no-demand-tail-year` | A no-demand year's `scaled` row lists the volume registered over the days it is scaled on: its run days, the historical days of the year a forecast tail starts in (engine ≥ 1.57.0; before, that year listed k × demand = 0) | §2.12a |

Coverage probes (rules the docs settle, which the random networks rarely
reach in a way a mutant would show): `trigger-hysteresis` (the trigger rule
keeps pumping until the stop level, §2.7e), `junior-user` (a junior user
leaves the seniors' requirement, §2.7c) and `offtake-keep-bands` (off-takes
of one priority share the flow in bands at their keeps, so a sibling without
a hands-off flow doesn't let the others take below theirs, §2.6a, engine
1.69.0).
