# WBT workbook import

Python scripts that read a b023 Water Balance Tool workbook (`.xlsm`) and write
JSON the app and the engine's tests use. Client workbooks and everything
generated from them stay out of git: put workbooks in `../project-water-management-source/Original/` (outside the repo) and outputs in
`data/` (both gitignored).

| Script | Output |
| --- | --- |
| `extract_project.py WORKBOOK OUTDIR [--gauge-as-reference …]` | `OUTDIR/project.json` holds a project: `{ name, description, settings, model, series }`, with `settings` = `ProjectSettings`, `model` = `ProjectModel` and `series` = `[{ kind, name, unit, startDate, values }]` (see `packages/engine/src/project.ts`). `OUTDIR/expected.json` holds the workbook's own daily results per Element sheet plus the catchment columns, for the engine regression test. |
| `calibration.py WORKBOOK` | Prints the [Flow Calibration Cfg] parameters. `extract_project.py` uses it for `settings.calibration`. |
| `extract_flow_fixture.py WORKBOOK OUT.json` | The rain-model fixture for `packages/engine/src/flow.test.ts`, which reads `data/fixtures/client-catchment-flow.json`. |
| `make_synthetic_workbook.py [OUTDIR]` | The **synthetic** b023 workbook of an invented catchment and `extract_project.py`'s output for it, committed in `fixtures/` (see [The synthetic workbook](#the-synthetic-workbook)). |

## Setup

The scripts need Python 3.10+ and `openpyxl` (pinned in `requirements.txt`):

```sh
python3 -m venv .venv && .venv/bin/pip install -r scripts/wbt-import/requirements.txt
```

## Tests

```sh
.venv/bin/python -m unittest discover -s scripts/wbt-import
```

CI runs them in the `wbt-import` job (Python 3.14, `.github/workflows/ci.yml`),
which fans into `CI gate`.

## Run

```sh
.venv/bin/python scripts/wbt-import/extract_project.py "../project-water-management-source/Original/<client workbook>.xlsm" data/client-catchment
.venv/bin/python scripts/wbt-import/extract_project.py ../project-water-management-source/Original/Blank_WBT_b023_v001.xlsm data/blank
```

A large client workbook takes some seconds. The script prints a summary and
any `note:` lines about things it had to interpret. Then run the engine tests:
`pnpm -C packages/engine test`. The client catchment regression in `run.test.ts` runs
when `data/client-catchment/expected.json` exists and is skipped otherwise.

## What it reads

The workbook must have been **calculated and saved in Excel**. The script opens
it with `data_only=True`, which reads the values Excel cached; it can't
recalculate formulas. It finds every table through the workbook's named ranges
(`zNetwork_*`, `zFarmSpec_*`, `zCropDemand_*`, `zFarmDemand_*`,
`zTransfers_*`, `zEWR_Pragmatic`, `zFlowData_*`, `zShortfalls_*`), so moved
rows and columns don't break it.

- **Nodes** come from [Network] and [Farm spec]. `downstreamNodeId` is the
  inverse of the "Upstream element" columns. `areaKm2` is the farm's total area
  (hi + lo). `flowShareManual` is the "External fragmentation" column.
  `divertCapacityM3Day` is the m³/day column. `damMinPct` (the dam's minimum
  operating level, engine ≥ 0.16.0) is written as 0: the workbook's "min %"
  is the transfer minimum, which each transfer rule carries, and a `note:`
  names any farm that had one (docs/engine-audit.md Q5). The irrigation
  return flow % r becomes `irrigationEfficiency` e = 1 − r with
  `lossReturnFraction` 1 (r = 0: e = 1, 0), the same mapping as migration
  006 (docs/engine-audit.md N1). The workbook has no dam surface areas:
  `damAreaFullM2` is null (runs estimate capacity ÷ 3 m and warn, N2),
  `damAreaExponent` 0.7 and `damSeepagePerDay` 0, with one `note:`.
- **Crops** come from [Crop demand]: 12 factors per crop, Oct–Sep. Crop areas
  come from [Farm demand], zero areas omitted.
- **Transfers** are the [Transfers] "Draw from dam" columns whose "Transfer
  To" is a farm and whose max rate is above 0. `minStoragePct` is that column's
  "Min capacity (%)". `dailyCapM3` is null because the engine derives the cap
  from the rate. `priority` is the rule's position (0, 1, …), so rules from
  one dam are served in the workbook's column order (docs/engine-audit.md
  Q18). Month lists keep the months they name; the workbook's
  substring matching (which makes "11" also mean January) is a bug, and the
  script prints a `note:` when a list relied on it (quirk 2 in
  `packages/engine/src/network/README.md`, docs/engine-audit.md M1).
- **Settings**: A-pan evaporation, effective rainfall %, February days
  (AppSettings), fragmentation method and hi/lo split, pragmatic EWR, and
  calibration (via `calibration.py`; engine defaults with a note if that
  module is missing). `calibrationStart/End` come from [Flow Calibration Cfg]
  `zCalibration_Date1/DateN`, and `calibrationFlowKind` from [Flow data]
  `rUseFlow` (left null, with a note, when that series has no values).
- **Zero-rain runs** (issue #2): a `note:` lists runs of zero catchment rain
  that look like missing data, by the engine's `zeroRainRuns` rule (60+ days
  in the series' six wettest months, or 180+ days with under two years of
  data; `docs/model.md` §2.10a). The values are imported unchanged: from
  engine 0.15.0 a run treats a flagged run as missing by default
  (`settings.zeroRainRuns`, `docs/model.md` §2.4c), so bias-corrected CHIRPS
  fills it; Settings → Zero-rain runs keeps a real dry spell as recorded, so
  there is no need to re-export the zeros as blanks. The low-vs-CHIRPS year check is
  engine-only (it shows in every run and on the Time series tab).
- **expected.json `ewrPivot`**: the [EWR shortfalls Pivot Data] rows (year,
  month, farm, summed shortfall, days not met). A macro writes that table, so
  it can be stale; see `docs/model.md` §2.9.
- **Series** are [Flow data] columns G–K: observed flow (the gauge), logger,
  catchment rain, CHIRPS rain and forecast rain. A column with no values is
  skipped. Blank cells become `null`. Column F (Pitman flow) is never
  imported, because the app has no Pitman input (`docs/engine-audit.md` P1): a
  note gives how many days it held, and a workbook whose `rUseFlow` calibrates
  against it gets a `WARNING` and no `calibrationFlowKind`.

## The gauge column on another river (`--gauge-as-reference`)

By default the gauge column becomes `flow_observed_m3s`, the catchment's own
observed flow. Some workbooks hold a gauge on a *neighbouring* river there,
sometimes scaled by a catchment-area ratio for part of the record. Such a
record is not observed flow for the modelled river, so import it as a
reference gauge instead:

```sh
.venv/bin/python scripts/wbt-import/extract_project.py WORKBOOK.xlsm OUTDIR \
  --gauge-as-reference --gauge-scaling-from YYYY-MM-DD --gauge-scale-factor F
```

- `--gauge-as-reference` writes the column as `flow_reference_m3s`
  ("Reference gauge (other catchment)"). The engine never reads that kind: it
  is never the calibration or validation record, never in the gauge-vs-logger
  check and never in the EWR results (docs/model.md §2.10). It can be charted
  on the Time series tab as a regional wet/dry index.
- `--gauge-scaling-from` and `--gauge-scale-factor` (together, and only with
  `--gauge-as-reference`) undo a known scaling: values on or after the date
  are divided by F (> 0). Blanks stay blank. A `note:` gives the day count. To
  find the date, look for where the column's values stop being whole
  thousandths of m³/s (DWS publishes three decimals; a scaled value has many).
- If `rUseFlow` picks the gauge (2), `calibrationFlowKind` is left unset and a
  `WARNING:` goes to stderr. Runs then calibrate on the logger if there is one.
  Check the choice in Settings → calibration flow series.
- `expected.json` is unchanged: it is the workbook's own results.

`pnpm seed:demo` uses this for the client workbook, extracting into
`data/client-catchment-app/`, while `data/client-catchment/` stays the
workbook-faithful extraction for the regression tests. The scaling is client
data, so it's read from `WBT_GAUGE_SCALING_FROM` / `WBT_GAUGE_SCALE_FACTOR`,
set in the environment or in `$WBT_SOURCE_DIR/wbt-import.env` beside the
workbooks, never in the repo. Set `WBT_GAUGE_AS_REFERENCE=0` to import the
column as observed flow. The seed re-extracts when these options change, or
when the importer (`extract_project.py`, `calibration.py`) does.

- **Expected results** (`expected.json`): every Element sheet's daily
  columns, the [Flow data] catchment columns, and `shortfalls`: the
  [Shortfalls] reporting period plus every farm row (H–V: averages, target,
  reduce/gain, EWR shortfall, total change and volume left) and the totals
  row. A `"-"` or error cell becomes `null`. The engine's regression test
  compares `RunSummary.curtailment` with these values.

Ids are `uuid5` of the project name and the element, crop or transfer name, so
re-importing a workbook gives the same ids.

## The synthetic workbook

`fixtures/synthetic_b023.xlsx` is a b023-layout workbook of an **invented**
catchment: NATO-alphabet farm names ("Alpha Farm" … "Hotel Farm"), made-up
crops, areas and dams, and three water years (2019-10-01 to 2022-09-30) of
daily series from a seeded random generator. Nothing in it comes from a client
workbook; only the layout (sheet names, named ranges, which cell holds what)
follows the tool. It's the one `.xlsx` the repo tracks (a narrow `.gitignore`
exception). The in-browser importer's parity test (WP-1.31) reads it and must
produce the committed Python output:

| File | What |
| --- | --- |
| `synthetic_b023.xlsx` | the workbook (about 85 KB) |
| `synthetic_b023.project.json` / `.notes.txt` | `extract_project.py` output and its notes, one per line (a `WARNING: ` prefix kept) |
| `synthetic_b023.gauge-reference.project.json` / `.notes.txt` | the same with `--gauge-as-reference --gauge-scaling-from 2021-10-01 --gauge-scale-factor 0.8` |

`expected.json` isn't committed: the Element sheets hold only a week of
invented values, enough for the reader to run.

Regenerate after changing the generator or the importer, then commit all five
files (the TypeScript port must follow an importer change):

```sh
.venv/bin/python scripts/wbt-import/make_synthetic_workbook.py
```

The output is deterministic (fixed seed, dates and zip timestamps): the same
openpyxl version writes the same bytes. `test_synthetic.py` regenerates the
workbook into a temp dir and checks that both it and the committed workbook give
exactly the committed JSON and notes, that the files stay under pre-commit's
500 KB cap, and that each case below still shows up.

**Cached values and formulas.** The importer opens the workbook with
`data_only=True`, and openpyxl writes a formula with no cached value, so a
formula would read as blank. Every cell an importer reads therefore holds a
plain value, as if Excel had calculated and saved it. The only formulas are the
[Transfers] formula row (row 7: the hand-written InOut formulas and the
draw-from-dam formulas), with the same text as plain strings in row 8
(`zTransfers_FormulasAsTxt`), as in b023. SheetJS drops a formula cell with no
value unless you pass `sheetStubs: true`, and then gives it `t: 'z'`: treat it
as blank, like the Python importer.

What each part of the fixture exercises (the note text is in `synthetic_b023.notes.txt`):

| Fixture | Importer branch |
| --- | --- |
| [Network]: 8 farms and 2 gauges, a three-way confluence (Echo) and a two-way one (Hotel), a gauge mid-network (Midway Gauge), one outflow (Outlet Gauge) | `read_network`, `downstreamNodeId` as the inverse of the upstream columns, gauge vs farm kind, `sortOrder` |
| "Echo&nbsp;&nbsp;Farm" (double space) in [Network], "Echo Farm " and " Golf Farm" in [Farm demand] | `clean()` whitespace normalisation, names matched across sheets |
| Delta Farm in [Network], not in [Farm spec] | note "missing from [Farm spec]"; zero parameters, `pctUpstreamToDam` 1, `flowShareManual` null |
| [Farm spec] method "Specific"; Charlie Farm's external fragmentation blank | `flowShareMethod: "manual"`; a blank share reads as 0 (the "Specific with no values" case) |
| Min dam % on Bravo, Echo and Golf | note per farm, `damMinPct` 0 (Q5) |
| Irrigation return flow 0.1–0.3 on most farms, 0 on Charlie and Foxtrot | `irrigationEfficiency` 1 − r with `lossReturnFraction` 1, or 1 and 0 (N1) |
| 6 farms with a dam, Charlie without one (blank cells) | note "6 dam(s) have no surface area" (N2); blank capacity reads as 0 |
| Golf Farm total area 8.5 km² vs hi + lo 8.0 | both kept as typed (the engine warns) |
| Foxtrot's diversion typed as the text "4320" | `num()` of a numeric string |
| Hi/lo split 0.8/0.2, tolerance 0.0002, February 28.25 days, A-pan row, effective rain 0.7 | settings read from their named ranges |
| [Crop demand] 5 crops; Fodder E grown nowhere | crops and factors, Oct..Sep header check |
| [Farm demand]: zero and blank areas, a blank row, Hops X (not in [Crop demand]) on Echo, Kilo Farm (not in [Network]) | zero areas omitted, blank rows skipped, notes "crop Hops X is not in [Crop demand]" and "farm Kilo Farm is not in [Network]" |
| [Transfers] 7 draw-from-dam columns: months `"1,2,3,4,11,12"`; `"11,12"`; the number `7`; `" 5, 6 ,7"`; to `--`; rate 0; to "Zulu Farm" | month lists, the M1 substring note (`"11,12"`), a numeric month cell, spaces, two rules on one dam (Bravo, priorities 0 and 3 by column order), the two silent skips, note "names an unknown element; skipped" |
| [Transfers] InOut formula `=S7*0.9-V7` on Echo (a conveyance loss) beside six add/subtract formulas | a hand-written formula that doesn't fit the rule shape, for the TypeScript unmapped report (the Python importer doesn't read formulas) |
| [Flow Calibration Cfg] summer months `"10,11,12,3,"` (trailing comma), recession table, calibration window 2019-10-01..2021-09-30 | `extract_calibration`, the summer-months M1 note, `calibrationStart/End` |
| [Flow data] `rUseFlow` 2 | `calibrationFlowKind: "flow_observed_m3s"` |
| Pitman column with 120 days of values | note "Pitman flow column has 120 days"; never imported |
| Gauge column: blanks, the text "n/a", values × 0.8 from 2021-10-01 | blanks and text read as null; the gauge-reference output undoes the scaling (note "divided by 0.8 (365 days)") and warns that `rUseFlow` pointed at the gauge, falling back to the logger |
| Logger only from 2021-06-01 | a part-empty series kept whole |
| Catchment rain: zeros 2021-01-05..03-20 in the wet season, zeros May–Aug 2020 in the dry season, 5 blank days, the text "err" | the zero-rain note flags the wet-season run only (it grows to 2020-12-31..2021-03-22 with the dry days around it); blanks and text read as null and end a run |
| CHIRPS column with a blank header; forecast column empty | a series named after its kind; an empty column skipped |
| Two dated rows after `zFlowData_DateE_DateSeries` | reading stops at the last date |
| No Element sheet for Hotel Farm | note "no Element sheet for Hotel Farm" |
| [Shortfalls] and [EWR shortfalls Pivot Data] (a "-" where demand is 0) | `expected.json` only |

Branches the committed workbook can't reach, because they exclude a case above
or would stop the project importing and running. `test_synthetic.py` (class
`Variants`) checks each on an uncommitted variant of the generator; the
TypeScript port needs its own tests for them:

- `unknown fragmentation method` (the fixture uses "Specific");
- several roots (`elements … have no downstream element`): the app rejects a
  network with more than one outflow;
- `rUseFlow` 1 (the Pitman warning) and `rUseFlow` on a series with no values
  (the fixture uses the gauge, for the gauge-as-reference warning);
- a calibration window that ends before it starts (both dates become null).

Not in the fixture at all: `--gauge-as-reference` on a workbook with no gauge
values (`test_gauge_reference.py`), and the errors (non-consecutive dates, an
unknown or doubled upstream element, a crop header without Oct, no A-pan row,
missing [Transfers] labels, an Element sheet starting on another date).

Both outputs import and run: `pnpm import:project
scripts/wbt-import/fixtures/synthetic_b023.project.json --email
synthetic@example.com --password synthetic-password --run` (use an absolute
path; the script runs in `backend/`).

## Known limits

- Transfer "InOut" columns are hand-written formulas in each workbook. The
  importer assumes the standard pattern: add to the destination, subtract from
  the source.
- The blank template holds one day of data and no rainfall, so the engine
  refuses to run it ("no rainfall series").
