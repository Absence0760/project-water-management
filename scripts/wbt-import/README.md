# WBT workbook import

Python scripts that read a b023 Water Balance Tool workbook (`.xlsm`) and write
JSON the app and the engine's tests use. Client workbooks and everything
generated from them stay out of git: put workbooks in `../project-water-management-source/Original/` (outside the repo) and outputs in
`data/` (both gitignored).

| Script | Output |
| --- | --- |
| `extract_project.py WORKBOOK OUTDIR [--gauge-as-reference …]` | `OUTDIR/project.json` holds a project: `{ name, description, settings, model, series }`, with `settings` = `ProjectSettings`, `model` = `ProjectModel` and `series` = `[{ kind, name, unit, startDate, values }]` (see `packages/engine/src/project.ts`). `OUTDIR/expected.json` holds the workbook's own daily results per Element sheet plus the catchment columns, for the engine regression test. |
| `calibration.py WORKBOOK` | Prints the [Flow Calibration Cfg] parameters. `extract_project.py` uses it for `settings.calibration`. |
| `frontend/src/lib/spreadsheet/import/` (TypeScript) | The same `project.json` and notes in the browser, plus an unmapped report; see [The TypeScript port](#the-typescript-port-in-browser-import). |
| `make_synthetic_workbook.py [OUTDIR]` | The **synthetic** b023 workbook of an invented catchment and `extract_project.py`'s output for it, committed in `fixtures/` (see [The synthetic workbook](#the-synthetic-workbook)). |
| `make_string_decoding_fixture.py [OUTDIR]` | A small hand-written workbook of every cell-text decoding case and what openpyxl reads from it, committed in `fixtures/` (see [The string-decoding fixture](#the-string-decoding-fixture)). |

## Setup

The scripts need Python 3.10+ and `openpyxl` (pinned, with its dependency and
the sha256 of each, in `requirements.txt`; pip checks the hashes):

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
.venv/bin/python scripts/wbt-import/extract_project.py "../project-water-management-source/Original/<the blank b023 template>.xlsm" data/blank
```

A large client workbook takes some seconds. The script prints a summary and
any `note:` lines about things it had to interpret. Then run the engine tests:
`pnpm -C packages/engine test`. The client catchment regression in `run.test.ts` runs
when `data/client-catchment/expected.json` exists and is skipped otherwise.

To read a workbook's cell formulas (array formulas included) while working
on the importer, `dumpwb.py` prints them sheet by sheet (read-only, openpyxl;
moved here from `verify/`, whose workbook transcription it served):

```sh
.venv/bin/python scripts/wbt-import/dumpwb.py "<workbook>.xlsm" <max rows> [Sheet1,Sheet2]
```

Its output quotes the client's cells, so it stays on your machine, never in
an issue or a commit.

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
  `damAreaFullM2` is null (runs estimate 7.2 × capacity^0.77 m² and warn, N2),
  `damAreaExponent` 0.7 and `damSeepagePerDay` 0, with one `note:`.
  **Upstream inflow above dam %** is stored as 1 − the workbook's value, with
  a `note:`: b023's formula sends that share past the dam, not into it, and
  the values were entered against the formula, so this keeps what the
  workbook ran (a b023 100 % is an off-channel dam, 0 % here). A workbook
  carrying the defined name `zFarmSpec_UpstrInflowIntoDam` (the fixed
  workbooks, whose formula sends the share into the dam) imports its values
  as entered, with a different `note:` (docs/model.md §3 Q1). Everything below
  reads the stored share (the share into the dam).
  b023 has no river abstraction, so a unit that pumps straight from the river
  is entered as a "dummy dam". A farm whose dam takes 100 % of the upstream
  inflow and either is a pool (under 1 % of a day of its diversion capacity,
  or under 1 m³) or holds exactly a whole number of m³/s for one day (the
  capacity a multiple of 86,400 m³, within 1 m³) with none of the farm's own
  runoff gets a `WARNING:` "probable run-of-river, for the modeller to
  confirm" (issue #54, 2d). The dam is
  still imported as it is: its storage, spill and level results mean nothing
  until run-of-river supply with a pump capacity lands (#54, 2c). A real
  on-channel dam holds days to months of its diversion and catches its own
  farm's runoff, so it doesn't trip either test. A farm with **no dam** that
  takes 100 % of the upstream inflow gets the same flag with its own text: the
  engine lets a dam-less farm irrigate from the river routed to it with no
  limit, where b023's formula gave it nothing (issue #54). The run warns about it too (docs/model.md §2.7e).
  A farm whose dam takes **less** than 100 % of the upstream inflow but holds
  under 100 m³ (less than a day of one hectare's peak irrigation) or under
  1 % of a day of its diversion capacity gets a `WARNING:` "probable
  placeholder pool, for the modeller to confirm" (issue #90 Q18): it stores
  nothing from one day to the next, so it is either a placeholder (set the
  capacity to 0) or a unit pumping from the river (run of river with a pump
  capacity). It is imported as it is; `--run-of-river` doesn't convert it.
  **`--run-of-river`** (off by default; the seed turns it on per workbook with
  `WBT_RUN_OF_RIVER=1` in `wbt-import.<Prefix>.env`, bin/seed-demo.sh) imports
  every unit so flagged as run of river instead (issue #54, 2c/2d):
  `supplyRule: "runOfRiver"`, the dummy dam dropped (`damCapacityM3` 0, as the
  model rules require) and `pumpCapacityM3Day: null`, with a `WARNING:` per
  unit. b023 has no pump capacity, and nothing in it caps what a dummy dam or a
  dam-less farm takes from the water routed to it (the dam's one-day capacity
  doesn't: the day's inflow is available on top of it), so the pump is left
  uncapped, as the workbook had it, and each run warns until the modeller
  enters the capacity. A unit that an enabled transfer draws on keeps its dam
  (the transfer needs the storage), with a warning saying so; a river off-take
  (below) draws on the river, so its source is converted like any other. On a unit with
  no dam the river pump can take the unit's own runoff as well as the upstream
  inflow (it takes from the river below the unit), where the dam-less import
  took only what was routed to its absent dam.
- **Crops** come from [Crop demand]: 12 factors per crop, Oct–Sep. Crop areas
  come from [Farm demand], zero areas omitted. The app computes demand from
  crop areas only, so the importer checks the sheet's gross demand
  (`zFarmDemand_GrossMth`) against Σ area × factor × A-pan ÷ 1000 ÷ days
  (`zFarmDemand_GrossMthDays`). A farm that is off by more than 1 m³/day and
  1 % in any month gets a `WARNING:`. That catches a demand typed over the
  formula, such as a non-crop demand typed in by hand, and a formula
  that skips a crop because its crop index cell is blank (issue #54). Where the workbook is **higher** than its crop areas
  (the typed-over case), the part above them, month by month, is imported as a
  **demand object** (engine ≥ 1.7.0, docs/model.md §2.7f, issue #54 2b):
  `model.demandObjects` gets one "Non-crop demand" object on that farm, sized
  `monthly` with that part in m³/day (months within the sheet's rounding are
  0), supplied with the crops (`shared`), used in the catchment, and returning
  the farm's irrigation return flow % r, so it takes and gives back what the
  workbook's single demand did (supplied × r back, the rest consumed). A farm
  with no crop areas at all is taken as a town or scheme (`municipal`);
  otherwise the category is `other`. The warning then says what was done and
  asks the modeller to confirm the category, priority and return share. Where
  the workbook is **lower** (a formula that skips a crop), the app keeps the
  crop-area figure, as before, and the warning says so. One difference stays:
  b023 takes effective rain off a farm's whole gross demand, typed part
  included, over its cropped area; the object isn't reduced by rain (on a farm
  with no crops the two agree, the offset being 0). `model.demandObjects` is
  present only when there is one, so a workbook without typed-over demand
  imports exactly as before.
- **The crop table's own slips** (issue #289). b023's [Crop demand] has rows
  pasted from another crop and one-month slips (issue #54 item 1). The factors
  are imported as they are, never corrected, and each crop gets at most one
  `WARNING:` (`crop_table_notes`, the same rules and text in the browser
  importer): a row whose 12 factors equal an earlier, differently named
  crop's, naming that crop (a row of zeros, an unused crop, isn't compared);
  otherwise every suspect month of the row: a negative factor, a 0 between two
  months above 0 (a lone month out of the ground), a month more than 0.3
  above or below both its neighbours (a lone spike or dip; the year wraps, so
  Oct's neighbours are Sep and Nov), and a factor above 1.0. Thresholds and
  their sources: docs/model.md §2.3.
- **Transfers** are the [Transfers] "Draw from dam" columns whose "Transfer
  To" is a farm and whose max rate is above 0. `minStoragePct` is that column's
  "Min capacity (%)". `dailyCapM3` is null because the engine derives the cap
  from the rate. `priority` is the rule's position (0, 1, …), so rules from
  one dam are served in the workbook's column order (docs/engine-audit.md
  Q18). Month lists keep the months they name; the workbook's
  substring matching (which makes "11" also mean January) is a bug, and the
  script prints a `note:` when a list relied on it (quirk 2 in
  `packages/engine/src/network/README.md`, docs/engine-audit.md M1).
  A column whose draw formula is the constant 0 (`=0`, or `0` in the text
  copy `zTransfers_FormulasAsTxt`) was switched off by the hydrologist: the
  workbook never moved that water. It is imported with `enabled: false` and a
  `WARNING:` (issue #54), so the app doesn't run a
  transfer the workbook didn't. A workbook without the text copy imports
  every rule on, as before.
  b023 has one maximum rate per rule and the months it runs in, so no rule
  gets monthly rates (`monthlyRateM3s` is left out, which is the one rate in
  the listed months; docs/model.md §2.6).
  A transfer **from a probable run-of-river unit** (the dummy-dam flag above)
  **into a unit with no dam and no demand** (no crop area, no demand object)
  is how b023 fakes a canal fed from the river: the transfer can only draw on
  the dummy dam, and a destination with neither a dam nor a demand takes
  nothing. Both importers import it as a **river off-take** (engine ≥ 1.14.0,
  docs/model.md §2.6a): `source: "river"`, sized to capacity (the workbook's
  max rate), no hands-off flow, no losses, the EWR not kept, no dam top-up,
  with a `WARNING:` saying what to set (the canal's real capacity, by month if
  it varies, its hands-off or EWR condition, its losses and whether it runs
  full). A column switched off by a `=0` draw formula stays off, and the
  warning says to switch it on once the values are set, so the import runs as
  the workbook did.
- **Settings**: A-pan evaporation, effective rainfall %, February days
  (AppSettings), fragmentation method and hi/lo split, pragmatic EWR, and
  calibration (via `calibration.py`; engine defaults with a note if that
  module is missing). `calibrationStart/End` come from [Flow Calibration Cfg]
  `zCalibration_Date1/DateN`, and `calibrationFlowKind` from [Flow data]
  `rUseFlow` (left null, with a note, when that series has no values).
  `simulationStart/End` come from [Home] `zHome_CalcDate1/CalcDateN`, the
  window the workbook last calculated, when that window lies inside [Flow
  data] and cuts some of it off, with a `note:` (issue #54). A gauge record
  can run decades longer than the rain (a workbook whose flow record starts
  decades before its rain), and a run over all of it has decades of no rain. Otherwise
  both stay null and runs cover the flow record. Every series keeps its full
  record either way.
- **Zero-rain runs** (issue #2): a `note:` lists runs of zero catchment rain
  that look like missing data, by the engine's `zeroRainRuns` rule (60+ days
  in the series' six wettest months, or 180+ days with under two years of
  data; `docs/model.md` §2.10a). The values are imported unchanged: from
  engine 0.15.0 a run treats a flagged run as missing by default
  (`settings.zeroRainRuns`, `docs/model.md` §2.4c), so bias-corrected CHIRPS
  fills it; Settings → Zero-rain runs keeps a real dry spell as recorded, so
  there is no need to re-export the zeros as blanks. The low-vs-CHIRPS year check is
  engine-only (it shows in every run and on the Time series tab).
- **The daily EWR's source** (engine ≥ 1.77.0, issue #455, `docs/model.md`
  §2.9f): an optional `[EWR options]` sheet with the defined names
  `zEwrOpt_Method` (*Pragmatic*, *TAB file* or *Percentile tables*, case
  ignored; blank = Pragmatic), `zEwrOpt_Scaling` (*MAR ratio* or *Area
  ratio*; blank = MAR ratio), `zEwrOpt_TableMar` (Mm³/a) and
  `zEwrOpt_TableArea` (km², may be blank), `zEwrOpt_TabM3s` (12 cells, Oct …
  Sep, m³/s), `zEwrOpt_PctPoints` (10 cells, 0.1 … 0.99) and
  `zEwrOpt_NaturalPct` / `zEwrOpt_ReservePct` (12 rows × 10 columns, m³/s)
  becomes `settings.ewrDailySource` (`read_ewr_options`): `method` `pragmatic`
  | `tab` | `percentile`, `scaling` `mar` | `area`, `tableMarMm3`,
  `tableAreaKm2`, `tabM3s`, `naturalPctM3s`, `reservePctM3s`. A MAR or area
  that isn't a number above 0 is `null`; a table with a blank, text or
  negative cell (or the wrong shape) is `null`. A note says which EWR the
  workbook uses. `WARNING`s, each importing the pragmatic EWR (keeping the
  values it read): an unknown method or scaling (the scaling falls back to MAR
  ratio), a method that lacks its table or its scaling's MAR or area, and
  points other than 0.1 … 0.99 (the tables are read as those points, in
  order). A workbook without `zEwrOpt_Method` imports exactly as before: no
  `ewrDailySource` key, no note.
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
observed flow. **A logger column that copies it** (the same start and the same
value on every day) is not imported: a copy would
read as two instruments agreeing, and could be picked as an independent
validation record. A `WARNING:` says so, and an `rUseFlow` choice of the logger
becomes the gauge, the same record (`duplicate_logger_note`, before
`--gauge-as-reference`; the browser importer's `duplicateLogger` does the
same, with the same text). A gauge column may hold a record measured
elsewhere, or one rescaled for part of its span. Such a record is not observed
flow for the modelled river, so import it as a reference gauge instead:

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

`pnpm seed:demo` uses this for each client workbook, extracting into
`data/client-<prefix>-app/`, while `data/client-catchment/` stays the
workbook-faithful extraction for the regression tests. The scaling is client
data, so it's read from `WBT_GAUGE_SCALING_FROM` / `WBT_GAUGE_SCALE_FACTOR`,
set in `$WBT_SOURCE_DIR/wbt-import.<prefix>.env` beside the workbooks
(`<prefix>`: the file name before `_WBT_b023`), never in the repo. Set `WBT_GAUGE_AS_REFERENCE=0` to import the
column as observed flow. The seed re-extracts when these options change, or
when the importer (`extract_project.py`, `calibration.py`) does. Two more
per-workbook settings act on the extracted document at import, never on
`data/`: `WBT_SETTINGS=<file>` (a settings patch, a JSON object, relative to
`$WBT_SOURCE_DIR`), `WBT_TRANSFERS=<file>` (a transfer patch, a JSON list of
`{ from, to, set }` naming each rule by its end nodes' names, applied before
the fit: an off-take's capacity the workbook doesn't hold, docs/model.md
§2.6a) and `WBT_FIT=1` (fit GR4J and store the fit), through
`pnpm import:project --settings … --transfers … --fit` (docs/model.md
§2.10b, "Fit at import").

- **Expected results** (`expected.json`): every Element sheet's daily
  columns, the [Flow data] catchment columns over the same window, and `shortfalls`: the
  [Shortfalls] reporting period plus every farm row (H–V: averages, target,
  reduce/gain, EWR shortfall, total change and volume left) and the totals
  row. A `"-"` or error cell becomes `null`. The engine's regression test
  compares `RunSummary.curtailment` with these values. The Element sheets
  hold the workbook's model window, which can start after [Flow data] does
  (a gauge record decades longer than the rain record). `startDate` and
  `days` are that window, and the project's series keep every [Flow data] day.

Ids are `uuid5` of the project name and the element, crop or transfer name, so
re-importing a workbook gives the same ids.

## The synthetic workbook

`fixtures/synthetic_b023.xlsx` is a b023-layout workbook of an **invented**
catchment: NATO-alphabet farm names ("Alpha Farm" … "Hotel Farm"), made-up
crops, areas and dams, and three water years (2019-10-01 to 2022-09-30) of
daily series from a seeded random generator. Nothing in it comes from a client
workbook; only the layout (sheet names, named ranges, which cell holds what)
follows the tool. It's one of the two `.xlsx` files the repo tracks (narrow
`.gitignore` exceptions; the other is the [string-decoding
fixture](#the-string-decoding-fixture)). The in-browser importer's parity test (WP-1.31) reads it and must
produce the committed Python output:

| File | What |
| --- | --- |
| `synthetic_b023.xlsx` | the workbook (about 85 KB) |
| `synthetic_b023.project.json` / `.notes.txt` | `extract_project.py` output and its notes, one per line (a `WARNING: ` prefix kept) |
| `synthetic_b023.gauge-reference.project.json` / `.notes.txt` | the same with `--gauge-as-reference --gauge-scaling-from 2021-10-01 --gauge-scale-factor 0.8` |
| `synthetic_b023.run-of-river.project.json` / `.notes.txt` | the same with `--run-of-river` (Delta and India Farm converted) |
| `synthetic_b023.ewr-options.xlsx` | the same workbook with an invented `[EWR options]` sheet (the percentile tables, by MAR; issue #455) |
| `synthetic_b023.ewr-options.json` | its `settings.ewrDailySource` and `[EWR options]` notes (`test_ewr_options.py` keeps it in step; the browser importer's `ewrOptions.test.ts` checks parity and that the sheet adds nothing else) |

`expected.json` isn't committed: the Element sheets hold only a week of
invented values, enough for the reader to run.

Regenerate after changing the generator or the importer, then commit all nine
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
(`zTransfers_FormulasAsTxt`), as in b023. The TypeScript reader skips a
formula cell with no value (as SheetJS did without `sheetStubs`), so it reads
as blank, like the Python importer.

What each part of the fixture exercises (the note text is in `synthetic_b023.notes.txt`):

| Fixture | Importer branch |
| --- | --- |
| [Network]: 9 farms and 2 gauges, a three-way confluence (Echo) and a two-way one (Hotel), a gauge mid-network (Midway Gauge), one outflow (Outlet Gauge) | `read_network`, `downstreamNodeId` as the inverse of the upstream columns, gauge vs farm kind, `sortOrder` |
| "Echo&nbsp;&nbsp;Farm" (double space) and "Golf⏎Farm" (a line break typed in the cell) in [Network], "Echo Farm " and " Golf Farm" in [Farm demand], "Vines D" typed with a U+009F control character for the space in [Crop demand] | `clean()`: every run of whitespace and control characters (C0, DEL, C1) one space, so a name is one line, as the app requires (issue #385); names matched across sheets |
| Delta Farm in [Network], not in [Farm spec] | note "missing from [Farm spec]"; zero parameters, `pctUpstreamToDam` 1, `flowShareManual` null |
| Every [Farm spec] farm | note "Upstream inflow above dam %: … stores 100 % − the workbook's value"; the generator types b023's values (India Farm 0, Alpha 1, Hotel 0.75 …), so the stored shares are 1, 0, 0.25 … |
| [Farm spec] method "Specific"; Charlie Farm's external fragmentation blank | `flowShareMethod: "manual"`; a blank share reads as 0 (the "Specific with no values" case) |
| Min dam % on Bravo, Echo and Golf | note per farm, `damMinPct` 0 (Q5) |
| Irrigation return flow 0.1–0.3 on most farms, 0 on Charlie and Foxtrot | `irrigationEfficiency` 1 − r with `lossReturnFraction` 1, or 1 and 0 (N1) |
| 7 farms with a dam, Charlie without one (blank cells) | note "7 dam(s) have no surface area" (N2); blank capacity reads as 0 |
| Delta Farm: missing from [Farm spec], so no dam but 100 % of the upstream inflow | `WARNING:` "probable run-of-river … it has no dam" (the no-dam case) |
| India Farm (below Golf): a 20 m³ dam taking 100 % of the upstream inflow (0 % in the workbook), diversion 12,960 m³/day | `WARNING:` "probable run-of-river" (the pool test); imported unchanged. Bravo and Hotel take part of the upstream inflow and aren't flagged |
| Golf Farm total area 8.5 km² vs hi + lo 8.0 | both kept as typed (the engine warns) |
| Foxtrot's diversion typed as the text "4320" | `num()` of a numeric string |
| Hi/lo split 0.8/0.2, tolerance 0.0002, February 28.25 days, A-pan row, effective rain 0.7 | settings read from their named ranges |
| [Crop demand] 6 crops; Fodder E grown nowhere, with a lone 0 in Dec and 1.2 in Mar; Pasture F a copy of Pasture C's row | crops and factors, Oct..Sep header check; the crop-table `WARNING:`s (a lone month out of the ground, a lone spike, above 1; "the same as Pasture C's"), the factors imported unchanged |
| [Farm demand]: zero and blank areas, a blank row, Hops X (not in [Crop demand]) on Echo, Kilo Farm (not in [Network]) | zero areas omitted, blank rows skipped, notes "crop Hops X is not in [Crop demand]" and "farm Kilo Farm is not in [Network]" |
| [Transfers] 7 draw-from-dam columns: months `"1,2,3,11,12"`; `"11,12"`; the number `7`; `" 5, 6 ,7"`; to `--`; rate 0; to "Zulu Farm" | month lists, the M1 substring note (`"11,12"`), a numeric month cell, spaces, two rules on one dam (Bravo, priorities 0 and 3 by column order), the two silent skips, note "names an unknown element; skipped" |
| [Transfers] an 8th column, Foxtrot → Golf, whose draw formula is `=0` | `WARNING:` "its draw formula is the constant 0", imported with `enabled: false`; the InOut formulas include it, so no unmapped row |
| [Transfers] a 9th column, India (a dummy dam) → Delta (no dam, no demand), draw formula `=0` | imported as a river off-take (`source: "river"`, `sizing: "capacity"`), switched off, with both warnings |
| [Home] `zHome_CalcDate1/CalcDateN` equal to [Flow data]'s first and last dates | `model_window` reads them and leaves `simulationStart/End` null (the window covers the whole record) |
| [Transfers] InOut formula `=S7*0.9-V7` on Echo (a conveyance loss) beside six add/subtract formulas | a hand-written formula that doesn't fit the rule shape, for the TypeScript unmapped report (the Python importer doesn't read formulas) |
| [Flow Calibration Cfg] rain threshold, calibration window 2019-10-01..2021-09-30 (the legacy model's summer months, factors and recession table are still in the sheet, and not read since engine 1.0.0) | `extract_calibration`, `calibrationStart/End` |
| [Flow data] `rUseFlow` 2 | `calibrationFlowKind: "flow_observed_m3s"` |
| Pitman column with 120 days of values | note "Pitman flow column has 120 days"; never imported |
| Gauge column: blanks, the text "n/a", values × 0.8 from 2021-10-01 | blanks and text read as null; the gauge-reference output undoes the scaling (note "divided by 0.8 (365 days)") and warns that `rUseFlow` pointed at the gauge, falling back to the logger |
| Logger only from 2021-06-01 | a part-empty series kept whole |
| Catchment rain: zeros 2021-01-05..03-20 in the wet season, zeros May–Aug 2020 in the dry season, 5 blank days, the text "err" | the zero-rain note flags the wet-season run only (it grows to 2020-12-31..2021-03-22 with the dry days around it); blanks and text read as null and end a run |
| CHIRPS column with a blank header; forecast column empty | a series named after its kind; an empty column skipped |
| Two dated rows after `zFlowData_DateE_DateSeries` | reading stops at the last date |
| No Element sheet for Hotel Farm | note "no Element sheet for Hotel Farm" |
| Charlie Farm: no crop areas, gross demand typed as 150 m³/day | `WARNING:` "the gross demand in 12 of 12 months doesn't follow from its crop areas" (the other farms' rounded sums don't trip it), and a municipal "Non-crop demand" object of 150 m³/day every month |
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
- a calibration window that ends before it starts (both dates become null);
- Element sheets that start after [Flow data] (`ELEMENT_START_OFFSET`):
  `expected.json` starts on the Element sheets' first date and slices the
  catchment columns to match, and the project keeps every [Flow data] day.
  Element sheets that start before [Flow data] are refused.

Not in the fixture at all: `--gauge-as-reference` on a workbook with no gauge
values (`test_gauge_reference.py`), the run-of-river test's other branch (a
dam holding a whole number of m³/s for one day) and its negative controls
(`test_run_of_river.py`, and `farms.test.ts` with the same text), and the errors (non-consecutive dates, an
unknown or doubled upstream element, a crop header without Oct, no A-pan row,
missing [Transfers] labels, an Element sheet starting on another date than
the first one).

Both outputs import and run: `pnpm import:project
scripts/wbt-import/fixtures/synthetic_b023.project.json --email
synthetic@example.com --password synthetic-password --run` (use an absolute
path; the script runs in `backend/`).

## The string-decoding fixture

`fixtures/string_decoding.xlsx` is a one-sheet workbook whose XML
`make_string_decoding_fixture.py` writes by hand, since no spreadsheet program
writes most of its cases on demand; every string in it is invented.
`fixtures/string_decoding.cells.json` is every cell openpyxl reads from it,
opened as `extract_project.py` opens a workbook (read-only, cached values).
The cases: Excel's `_xHHHH_` escapes (and `_x005F_`, its escaped underscore)
in shared, inline and formula strings; a formula's cached text (`t="str"`)
holding entity references; `&#13;&#10;`, literal CRLF and lone CR; references
beyond U+FFFF; CDATA; rich-text runs; `x005F_` mid-text. openpyxl expands the
XML entities once, leaves `_xHHHH_` as written, keeps a CR written as a
reference, normalises literal line breaks to LF, and drops every `x005F_`
from a shared string (not from an inline or formula string).

`frontend/src/lib/spreadsheet/import/stringDecoding.test.ts` (CI) reads the
workbook with the TypeScript reader and compares every cell with the JSON.
`test_string_decoding.py` checks the committed workbook is what the generator
writes and the JSON is what openpyxl reads. Regenerate after changing the
generator, then commit both files:

```sh
.venv/bin/python scripts/wbt-import/make_string_decoding_fixture.py
```

## The TypeScript port (in-browser import)

`frontend/src/lib/spreadsheet/import/` is a TypeScript port of
`extract_project.py`'s project extraction and `calibration.py`, for the
in-browser workbook import (roadmap WP-1.31): `await readWorkbook(bytes)` then
`extractProject(wb, { fileName, gaugeAsReference, runOfRiver })` gives `{ project, notes,
unmapped }`. Per decision D17 the **TypeScript port is the user path** (the
import in the UI), and the Python scripts stay for the regression fixtures
(`expected.json`), `pnpm seed:demo` and the
synthetic fixture's committed output.

**Parity rule.** For the same workbook and options, `project` equals the
Python's `project.json` key for key and value for value, and `notes` are its
`note:` / `WARNING:` lines, same text and order (less "no Element sheet …",
which is about `expected.json`). A change to what `extract_project.py` or
`calibration.py` writes or prints lands in the port in the same change, and
the other way round. Two tests hold it:

- `fixture.test.ts` (CI) runs the port on `fixtures/synthetic_b023.xlsx` and
  compares it with the committed `.project.json` and `.notes.txt`, with and
  without the gauge-reference options, and with `--run-of-river`
  (`runOfRiver: true`);
- `sourceWorkbooks.test.ts` (local only) runs `extract_project.py` on every
  workbook in `$WBT_SOURCE_DIR/Original/` (default
  `../project-water-management-source/Original/`) into a temp directory
  outside the repo and compares, with no options, `--gauge-as-reference`,
  `--run-of-river`, and the seed's scaling from `wbt-import.env`. It skips without the workbooks or
  Python with openpyxl (`PYTHON`, else the checkout's `.venv`, else
  `python3`), and takes some seconds per workbook variant, most of it the
  Python.

**The reader.** `readWorkbook` is the port's own streaming OOXML reader
(`zip.ts`, `xml.ts`, `workbookParts.ts`, `sheet.ts`, `sharedStrings.ts`), not
SheetJS, which the port used first: SheetJS held the whole [Flow data] XML
and an object per cell, which a large workbook turns into a lot of memory. The
reader gives the parser the cells SheetJS gave it (cached values, the number
formats that mark a date, blanks for formula cells with no value), with one
deliberate difference: cell text is decoded as openpyxl decodes it, since
the Python importer is the reference (issue #22). So the XML entities are
expanded once, a formula's cached text included (SheetJS decoded it twice:
`a&amp;amp;b` read `a&b`, openpyxl `a&amp;b`); Excel's `_xHHHH_` escapes are
left as written (SheetJS turned `_x000D_` into a CR); a CR written as
`&#13;` stays a CR and a literal CR becomes LF; a reference beyond U+FFFF is
one character; and a shared string drops every `x005F_`, as openpyxl's
`read_string_table` does. The [string-decoding
fixture](#the-string-decoding-fixture) pins each case to openpyxl's output.
Sheet names, defined names and number formats (`workbookParts.ts`) still use
SheetJS's decoding (`unescapeXml`); openpyxl reads those without `_xHHHH_`
handling too, which only a sheet name or defined name containing a
literal `_xHHHH_` would show.
A third test holds the reader to SheetJS: `readerParity.test.ts` (CI) reads
the synthetic workbook, SheetJS-written workbooks and hand-written edge cases
with both readers (SheetJS's in `sheetjsReference.ts`, test-only) and compares
every cell through `B023Workbook`; `stringDecoding.test.ts` lists exactly the
fixture cells whose text SheetJS read differently; `sourceWorkbooks.test.ts`
compares the client workbooks, allowing only differences that
`explainedByDecoding()` puts down to the text decoding.

**In the UI.** **Import b023 workbook** on the project list runs the port in a
Web Worker (`import.worker.ts`: the picked file goes in, progress per sheet
comes out, then the project, notes and unmapped report), shows the review,
and posts the project to `POST /projects/import`, the same route and
validation as a `.json` file ([docs/ui.md](../../docs/ui.md#import-a-b023-workbook)).
The review's gauge option is `gaugeAsReference` (a date and factor for the
scaling), and its *River pumping units* option, shown only when a unit is
flagged as probable run-of-river, is `runOfRiver` (`--run-of-river`, same
conversion, same notes; `asRunOfRiver` in `farms.ts`). Nothing from the workbook but the project reaches the server.

**Acceptance (the client workbook).** `sourceWorkbooks.test.ts` shows the
port's `project.json` equals the Python's, with and without the gauge
options. The same `project.json` makes the same run: the import route is a
function of the document alone, fresh ids keep the document's id order (the
engine's summation and tie-break order), and the engine is deterministic.
Checked end to end on 2026-09-25: both documents imported through the route's
code with a run stored identical run summaries (a one-off local script
outside the repo; no client data committed).

What the port does beyond the Python:

- **The unmapped report** (plan.md 1b): what it couldn't carry across as the
  workbook meant, each with a code, the sheet and cell: [Transfers] InOut and
  draw-from-dam formulas that don't fit the rule shape (read from the
  plain-text copy b023 keeps in `zTransfers_FormulasAsTxt`, so nothing is
  parsed from formulas), a farm in a transfer with no InOut column, a draw
  column with a rate but no destination (the workbook still takes that water
  from the source dam), a destination with no rate, the M1 month lists, a
  blank share under the Specific method, an element type other than Farm or
  Gauge, a [Farm spec] farm not in [Network], and number cells holding text or
  errors (read as 0 or blank, as in the Python). It never changes a value.
- **Typed errors**: not a b023 workbook (the named ranges it lacks), an
  unsupported build (AppSettings `zAppVer` other than b02x), a file over 150 MB
  or 250 sheets, and the Python's own stops (non-consecutive dates, an unknown
  upstream element …).
- It unpacks and parses only the parts the named ranges point at, never the
  Element sheets. SheetJS's own zip reader inflates every part first (a
  workbook's parts unpack to several times its size on disk), so `readWorkbook` reads the zip
  itself (`zip.ts`: capped, bounds-checked, only the needed parts, with the
  platform's `DecompressionStream`) and parses each part as it inflates
  (see **The reader** above). That's why `readWorkbook` is async. Measured
  figures are in [followups.md](../../docs/followups.md) (WP-1.31).
- It reads `.xlsx` and `.xlsm` alike. The parity tests use SheetJS's mini
  build (`xlsx/dist/xlsx.mini.min`) as the reference reader; the import
  worker carries no SheetJS.

Differences no b023 workbook reaches: Python's `\d` also matches non-ASCII
digits in a month list; a cell SheetJS reads as an ISO date (`t="d"`, which
Excel doesn't write) or with an error code it doesn't know; and repr() of a
whole number of 10¹⁵ or more in a note's text.

## Known limits

- Transfer "InOut" columns are hand-written formulas in each workbook. The
  Python importer assumes the standard pattern: add to the destination,
  subtract from the source. The TypeScript port assumes the same and lists
  every formula that differs in its unmapped report.
- The blank template holds one day of data and no rainfall, so the engine
  refuses to run it ("no rainfall series").
