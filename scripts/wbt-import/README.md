# WBT workbook import

Python scripts that read a b023 Water Balance Tool workbook (`.xlsm`) and write
JSON the app and the engine's tests use. Client workbooks and everything
generated from them stay out of git: put workbooks in `Original/` and outputs in
`data/` (both gitignored).

| Script | Output |
| --- | --- |
| `extract_project.py WORKBOOK OUTDIR` | `OUTDIR/project.json` holds a project: `{ name, description, settings, model, series }`, with `settings` = `ProjectSettings`, `model` = `ProjectModel` and `series` = `[{ kind, name, unit, startDate, values }]` (see `packages/engine/src/project.ts`). `OUTDIR/expected.json` holds the workbook's own daily results per Element sheet plus the catchment columns, for the engine regression test. |
| `calibration.py WORKBOOK` | Prints the [Flow Calibration Cfg] parameters. `extract_project.py` uses it for `settings.calibration`. |
| `extract_flow_fixture.py` | The rain-model fixture for `packages/engine/src/flow.test.ts`. |

## Setup

The scripts need Python 3.10+ and `openpyxl`:

```sh
python3 -m venv .venv && .venv/bin/pip install openpyxl
```

## Run

```sh
.venv/bin/python scripts/wbt-import/extract_project.py "Original/Client_WBT_b023_v001_20260407_WORKING 007.xlsm" data/client-catchment
.venv/bin/python scripts/wbt-import/extract_project.py Original/Blank_WBT_b023_v001.xlsm data/blank
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
  `divertCapacityM3Day` is the m³/day column.
- **Crops** come from [Crop demand]: 12 factors per crop, Oct–Sep. Crop areas
  come from [Farm demand], zero areas omitted.
- **Transfers** are the [Transfers] "Draw from dam" columns whose "Transfer
  To" is a farm and whose max rate is above 0. `minStoragePct` is that column's
  "Min capacity (%)". `dailyCapM3` is null because the engine derives the cap
  from the rate. Month lists are expanded with the workbook's substring
  matching; see quirk 2 in `packages/engine/src/network/README.md`.
- **Settings**: A-pan evaporation, effective rainfall %, February days
  (AppSettings), fragmentation method and hi/lo split, pragmatic EWR, and
  calibration (via `calibration.py`; engine defaults with a note if that
  module is missing).
- **Series** are [Flow data] columns F–K: Pitman flow, observed flow (G1),
  logger, catchment rain, CHIRPS rain and forecast rain. A column with no
  values is skipped. Blank cells become `null`.

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
  refuses to run it ("no rainfall or Pitman flow series").
