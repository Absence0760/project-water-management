# WBT workbook import

Python scripts that read a b023 Water Balance Tool workbook (`.xlsm`) and write
JSON the app and the engine's tests use. Client workbooks and everything
generated from them stay out of git: put workbooks in `../project-water-management-source/Original/` (outside the repo) and outputs in
`data/` (both gitignored).

| Script | Output |
| --- | --- |
| `extract_project.py WORKBOOK OUTDIR [--gauge-as-reference …]` | `OUTDIR/project.json` holds a project: `{ name, description, settings, model, series }`, with `settings` = `ProjectSettings`, `model` = `ProjectModel` and `series` = `[{ kind, name, unit, startDate, values }]` (see `packages/engine/src/project.ts`). `OUTDIR/expected.json` holds the workbook's own daily results per Element sheet plus the catchment columns, for the engine regression test. |
| `calibration.py WORKBOOK` | Prints the [Flow Calibration Cfg] parameters. `extract_project.py` uses it for `settings.calibration`. |
| `extract_flow_fixture.py` | The rain-model fixture for `packages/engine/src/flow.test.ts`. |

## Setup

The scripts need Python 3.10+ and `openpyxl`:

```sh
python3 -m venv .venv && .venv/bin/pip install openpyxl
```

## Tests

```sh
.venv/bin/python -m unittest discover -s scripts/wbt-import
```

## Run

```sh
.venv/bin/python scripts/wbt-import/extract_project.py "../project-water-management-source/Original/<client workbook>.xlsm" data/client-catchment
.venv/bin/python scripts/wbt-import/extract_project.py ../project-water-management-source/Original/Blank_WBT_b023_v001.xlsm data/blank
```

The 87 MB client catchment workbook takes about 20 s. The script prints a summary and
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
- **Series** are [Flow data] columns G–K: observed flow (G1), logger,
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
column as observed flow. The seed re-extracts when these options change.

- **Expected results** (`expected.json`): every Element sheet's daily
  columns, the [Flow data] catchment columns, and `shortfalls`: the
  [Shortfalls] reporting period plus every farm row (H–V: averages, target,
  reduce/gain, EWR shortfall, total change and volume left) and the totals
  row. A `"-"` or error cell becomes `null`. The engine's regression test
  compares `RunSummary.curtailment` with these values.

Ids are `uuid5` of the project name and the element, crop or transfer name, so
re-importing a workbook gives the same ids.

## Known limits

- Transfer "InOut" columns are hand-written formulas in each workbook. The
  importer assumes the standard pattern: add to the destination, subtract from
  the source.
- The blank template holds one day of data and no rainfall, so the engine
  refuses to run it ("no rainfall series").
