# verify/ — an independent cross-check of the engine

A second implementation of the model's core daily chain, in Python, written
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
| `model.py` | The Python model (stdlib only). `run(input)` returns the daily series; `unsupported(input)` lists what an input uses beyond phase 1; `Refused` is a run the docs say is refused |
| `run_engine.ts` | `run <in> <out> …` runs `runModel` on each input; `examples <dir>` writes the three example catchments' inputs (`pnpm seed:examples`' data, without the automatic fit) |
| `generate.py` | This harness's own seeded random-network generator (stdlib `random`; not the engine's fuzz generator, which is never read). Synthetic data only |
| `probes.py` | Hand-built inputs, each pinning a point the docs left open (§ Findings) |
| `diff.py` | Runs both sides on the examples, the probes and N random networks and prints, per column, the largest absolute and relative difference and a coverage count |
| `test_verify.py` | The guard: agreement, the mutation self-test and the generator's scope |

## Running it

```bash
pnpm test:verify                                   # the guard: ~2 min locally (examples, probes, 12 random networks, 24 mutants)
VERIFY_TEST_RANDOM=200 pnpm test:verify            # what CI runs: agreement on 200 random networks
python3 verify/diff.py --random 100 --seed 1000    # the report; --keep DIR keeps the inputs and outputs, --verbose lists engine-only series
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

## Phase 2 (not covered yet)

`model.unsupported()` names each of these, and the generator never produces
them; diff.py refuses an input that uses one. Tracked as one item in
docs/followups.md § Verification ("`verify/` phase 2").

- boreholes (combined and individual, stream depletion, annual caps, the dam
  target), §2.7d;
- allocations and the licence cap, full-allocation runs, §2.12a;
- demand objects and the basic-needs floor, §2.7f;
- river off-takes and canal seepage, §2.6a;
- Reserve rule tables (and audit A1–A7), §2.9c–d;
- forecast mode (`runForecastChecked`; forecast rain as the last rain source
  *is* covered), §2.4f;
- calibration (the fit itself; the calibration statistics);
- land cover, §2.5a;
- time-varying development (sediment, a dam in service from a date,
  abstraction from a date), §2.7g;
- and the other inputs outside the core chain: other water users (§2.7c),
  supply rules and the river pump (§2.7e), dam survey curves and releases
  (§2.7a), hands-off flows and River to dam by month (§2.7h), rain-source
  periods (§2.4e), the areal rainfall correction (§2.4g), the daily A-pan
  series (§2.3a), CHIRPS fit ranges (§2.4b), keep-dry periods and the
  keep-dry guard, listed and kept accumulations, non-default data-quality
  limits (§2.10a), demand factors and the outlook-only settings.

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
absorb a real difference. `KNOWN_DIFFERENCES` in diff.py lists columns where
the engine is known to depart from its documentation, each with its
docs/followups.md item; it is empty.

## The mutation self-test

Agreement only means something if the cases exercise the rules. So
`test_verify.py` breaks `model.py` one documented rule at a time (24
mutants: the receiver's room ignored, or shared after the source's bands; one
reserve pool for all rules (N6); the room without the dam's losses, or
counting what the receiver sent; no soil-water store; zero runs as recorded;
accumulations not spread, or tested over the whole run; raw CHIRPS; the
low-vs-CHIRPS median; a negative reading letting CHIRPS in; the binding-site
tie; the seepage return; dead storage; J_int; the demand threshold; the
forecast warm-up; crop efficiencies; the PE and evaporation month lengths;
the return share; the exchange; no catchment area) and requires each mutant
to disagree with the engine somewhere. A new
rule added to `model.py` gets a mutant; a mutant that passes means the cases
need one that reaches it.

## Findings

Result on 2026-09-30 (engine 1.36.0): the examples, the probes and 750 random
networks (seeds 1–150 and 1000–1599) agree on every compared column (49
column kinds; largest difference 9e-9 m³/day). No engine behaviour departs
from its documentation in phase 1, so `KNOWN_DIFFERENCES` is empty.

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
