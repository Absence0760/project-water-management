# Allocations: registered volumes vs modelled use

Roadmap [WP-3.10](./roadmap/step-3-licensing.md#wp-310-water-use-allocations-warms-vs-modelled-use),
planned-work row **Water-use licences / allocations**, issue #45 ("No
registered/licensed volume per water user (WARMS)"). This page covers
storing the volumes, importing them, comparing them with a run's modelled
use (the first slice), and, from the second (issue #72, engine 1.16.0),
licence conditions, the project's comparison band and the **allocation
mode** that caps a run at the volumes or scales it to them. What is still to
build is at the end.

This is not legal advice, and the app never decides whether a use is lawful.
It stores what an authorisation says and puts the model's abstraction beside
it. Every screen says **modelled use** and **registered volume**, and every
modelled number carries "modelled, not metered".

## What is stored

One **allocation** is one volume per year, for one water source, held under
one authorisation, for a farm or other water user (a `farm` or `user` node):

| Field | Meaning |
| --- | --- |
| Authorisation | `registration` (WARMS, GN R1352 of 1999), `licence` (s40), `general_authorisation` (s39, e.g. GN 538), `existing_lawful_use` (s32, verified under s35) |
| Purpose | `irrigation`, `domestic`, `livestock`, `industry`, `mining`, `municipal`, `other` |
| Water source | `surface` or `groundwater` |
| Volume | m³ per year, ≥ 0 |
| Storage | registered storage (s21b), m³; optional |
| Valid from / to | inclusive ISO dates; either may be open |
| Registration number, property | used to match the row to a node, and shown in the list |
| Registered user | the holder's name; see [Who sees what](#who-sees-what) |
| Reference | free text: the letter, the extract, a note |
| Source | the imported file (name and SHA-256), or none when typed in by hand |
| Months | licence condition (096): the calendar months the use may happen in; none = none stated |
| Maximum rate | licence condition (096): the most it may take at once, m³/s; optional |
| Conditions | licence conditions in words (096), up to 20, e.g. "No abstraction below 0.2 m³/s at the weir" |

Licence conditions are recorded and shown (the list sums them up in one
line, "Oct–Mar only · at most 0.05 m³/s · 2 conditions") but **not applied**
yet: neither the comparison nor the allocation mode reads them.

A farm may have several allocations (a registration and a later licence;
surface and groundwater). The comparison adds up every allocation in force for
the farm and source on each day.

Tables and policies: [data-model.md § Allocations](./data-model.md#allocations-038_allocationssql-096_allocation_conditionssql).

## Importing

WARMS has no public API; a CMA or DWS sends an extract. Extract layouts vary,
so the importer finds columns **by their heading** through an alias table
(`backend/src/allocations/parse.ts`, `HEADER_ALIASES`): "Registration
Number", "Registered Volume (m3/a)", "Resource Type", "Water Use Sector" and
so on, or the app's own template headings (`registration_no`, `farm`,
`holder`, `authorisation`, `purpose`, `water_source`, `volume_m3_year`,
`storage_m3`, `valid_from`, `valid_to`, `reference`, `property_ref`, and the
licence conditions `months` (numbers or names, ranges over the new year:
`Oct-Mar`), `max_rate_m3s` and `conditions`, separated by `|`). The
template is downloadable from the Allocations page's Import sheet. The aliases are **pending a real
extract** from the client (followups.md): a column the importer doesn't know
is listed as "not read", never guessed.

- **File.** CSV, comma- or semicolon-separated (a `;` file reads a comma as
  the decimal mark), UTF-8, at most 2 MB, 5 000 rows and 200 columns. Quoted fields,
  doubled quotes and line breaks inside quotes are read. XLSX is not read
  yet: save the sheet as CSV.
- **Refused files.** A heading that looks like an **ID number, passport,
  phone, cell, fax or email** column refuses the whole file, before anything
  is stored (POPIA minimisation, [security.md](./security.md)). A cell in the
  holder, reference, property or farm column that is a 13-digit number is a
  row problem ("looks like an ID number").
- **Row problems** (listed per row; those rows are not imported): an unknown
  authorisation or water source, a missing volume, a volume or storage that
  isn't a number ≥ 0, a date that isn't `YYYY-MM-DD` (or `YYYY/MM/DD`), valid
  from after valid to, no registration number, property or farm to match by.
  A WARMS extract without an authorisation column is read as registrations;
  the template must say.
- **Matching** a row to a node, in order: an earlier allocation with the same
  registration number, then the same property, then a farm or water user
  whose **name** equals the row's farm (or property), ignoring case and
  spacing. Two nodes with the same name match neither. The rest are
  "not matched"; the preview lists rows with problems first, then unmatched
  rows, each with a farm picker. The synthetic extract
  (`backend/src/allocations/fixtures/warms-synthetic.csv`) matches 9 of 10
  rows by name (acceptance: ≥ 90 %).
- **Commit.** The server keeps no preview: the commit sends the file again
  with the manual matches, re-parses it and stores the valid rows with the
  file's name and SHA-256 (`allocation_source`). The same file (same hash)
  can't be imported twice into a project. **Remove this import** deletes the
  file record and every row it brought.
- **CSV injection.** Cells are stored as text as they came (a holder of
  `=HYPERLINK(…)` is kept verbatim); the CSV export prefixes any cell that
  starts with `= + - @` (or a tab or CR) with `'`, as every export does
  (`backend/src/export/csv.ts textCell`).

Hand entry (**+ Add volume** in the page header), edits (including
matching a row to a farm, **Change** on a row) and deletes are on the
Allocations page for editors; the page's layout is in
[ui.md § Allocations](./ui.md#allocations-taballocations).

## The comparison

For a run, per farm or water user, per water source and per **water year**
(October–September), engine `compareAllocations`
([model.md §2.12](./model.md#212-allocations-modelled-use-vs-registered-volume-roadmap-wp-310)):

- **Modelled use**: the run's daily `supplied` series summed over the days of
  the water year inside the run. Groundwater is the `groundwater_used` series
  (boreholes, [model.md §2.7d](./model.md#27d-groundwater-abstraction-and-stream-depletion-engine--0230-roadmap-wp-134-audit-n5));
  surface water is supplied minus groundwater. Supply includes what the farm
  takes from its own dam. Groundwater pumped **into** a farm dam (a
  dam-target borehole, WP-3.9, `groundwater_to_dam`) counts as groundwater use
  on the day it is pumped, so the groundwater side of a water year equals the
  run's groundwater use table (to the crop + into the dam). Water pumped into
  the dam and later supplied from it is also in `supplied`; drawing it back
  out isn't a new surface take (in WARMS the groundwater take and the storage
  are separate registered uses), so the surface side nets it out: each water
  year, surface water = supplied − groundwater − MIN(pumped into the dam, drawn
  from the dam), where the dam draw is supplied less groundwater to the crop
  and the river pump (`river_abstraction`). 10 000 m³ pumped into a dam and
  40 000 m³ drawn from it read 30 000 m³ surface + 10 000 m³ groundwater,
  not 40 000 + 10 000. Water pumped before 1 October and drawn after it is
  not netted. The rule and its reasoning are in
  [model.md §2.12](./model.md#212-allocations-modelled-use-vs-registered-volume-roadmap-wp-310);
  pending the hydrologist's confirmation.
- **Registered volume**: each allocation's volume × the days it is valid in
  that part of the year ÷ the days in the water year (365 or 366). A run that
  covers only part of a water year compares that part with the prorated
  volume, marked **part**, and isn't counted in the summary.
- **Status**, with the project's band, ±10 % unless set (Settings ›
  Registered volumes, `settings.allocationTolerance`, pending the
  hydrologist; `?tolerance=` on the API overrides it for one request):
  *above registered* (modelled > registered × 1.1),
  *within band*, *below registered* (< × 0.9), *no registered volume*
  (modelled use with nothing in force), *no use, none registered*.
- **Storage**: the sum of the farm's registered storage beside the dam
  capacity the run modelled.
- Allocations not matched to a node, or matched to a node the run doesn't
  have, are counted and named, not compared.

### The allocation mode (engine ≥ 1.16.0)

Settings › Registered volumes › **Allocation mode** (`settings.allocationMode`)
decides what the volumes do to a run
([model.md §2.12a](./model.md#212a-allocations-and-full-allocation-runs-engine--1160-issue-72)):

- **Compare only** (the default): nothing; every run with volumes carries
  the comparison's whole-year figures in its summary.
- **Cap use at the registered volume**: each unit's surface-water use and
  groundwater use per water year stay within its volumes. The budget is the
  whole year's volume, so a unit may take it early; its boreholes cover what
  a capped surface can't, within the groundwater volume. A source with no
  volume isn't capped. What a cap does is visible: the run warns about the
  units it leaves alone, and the Allocations tab says the run was capped.
- **Full allocation**: each unit's demand is scaled, year by year, to ask
  for exactly its volumes, keeping its seasonal shape: the river if every
  registered user took their entitlement, the background of a cumulative
  assessment (WP-3.11). A scenario can switch it on for one run
  (`settings.set allocationMode`, [scenarios.md](./scenarios.md)).

Since every run's input carries the volumes (never the names), a stored run
replays with the volumes it ran on, a change to a volume makes the latest run
out of date, and comparing two runs lists the volumes that changed.

### What the comparison is not

- Not a finding. The model's supply is what the calibrated model would take
  with the demand it was given, not a meter reading. A registered volume can
  be missing, out of date or held by someone else.
- Not the whole entitlement picture: the Reserve, other users' priority and
  licence conditions (`months`, rates) aren't applied here, nor by the
  allocation mode.
- Pending the hydrologist: the ±10 % band, and counting supply from the
  farm's own dam as abstraction (the WP says so; a hydrologist may want dam
  filling, s21b, compared with storage instead).

## Who sees what

Decision D3 is open (client + legal adviser); the build follows its
recommendation (b), pending legal advice:

| Role | Volumes, numbers, dates | Registered user's name | Writes |
| --- | --- | --- | --- |
| Owner, editor | all | all | yes |
| Viewer | all | none | no |
| Farmer | their linked farms' allocations only (RLS) | their own only | no |
| Not a member | nothing | nothing | no |

Names live in their own table (`allocation_holder`) so RLS, not the API,
hides them. Farmers are refused the allocations routes today (like every
viewer route); their farm view doesn't show allocations yet (follow-up), but
RLS already scopes them. The history (readable by viewers) records
registration numbers and counts, never names.

## Still to build (WP-3.10)

Tracked in [followups.md § Allocations](./followups.md#allocations-wp-310):

- Applying licence conditions: the cap to keep to the months of use and the
  maximum rate.
- XLSX import and a column-mapping step for extracts whose headings the alias
  table doesn't know (waits on a real WARMS extract).
- The farm view (and share views, D3 (c)) showing a farmer their own
  registered volume beside their modelled use (waits on D3).
- Dam filling vs registered storage (s21b), and how the cap counts water
  drawn from a dam that boreholes filled (pending the hydrologist, issue #90).
- An over/under-use chart; in the evidence pack.
