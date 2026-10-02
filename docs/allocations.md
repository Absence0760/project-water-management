# Allocations: registered volumes vs modelled use

Roadmap [WP-3.10](./roadmap/step-3-licensing.md#wp-310-water-use-allocations-warms-vs-modelled-use),
planned-work row **Water-use licences / allocations**, issue #45 ("No
registered/licensed volume per water user (WARMS)"). This page covers
storing the volumes, importing them, comparing them with a run's modelled
use (the first slice), and, from the second (issue #72, engine 1.18.0),
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
| Authorisation | `registration` (WARMS, GN R1352 of 1999), `licence` (s40), `general_authorisation` (s39, e.g. GN 538), `schedule_1` (Schedule 1 permissible use, s22(1)(a)(i); 136), `existing_lawful_use_claimed` (s32, claimed or registered, not verified; 136), `existing_lawful_use` (s32, verified under s35). A registration is not an entitlement and doesn't confirm lawfulness; only s35 verification does ([DWS verification guide](https://www.dws.gov.za/WAR/documents/VerificationGuideDec06.pdf), issue #281) |
| Purpose | `irrigation`, `domestic`, `livestock`, `industry`, `mining`, `municipal`, `other` |
| Water source | `surface` or `groundwater` |
| Water use | the NWA s21 water use (142, issue #72): `21a` taking water (the default) or `21b` storing water. A `21b` row is a dam's registered storage only: volume 0, a storage, surface water; it is never compared, capped or scaled as a take (engine 1.59.0) |
| Volume | m³ per year, ≥ 0 (0 on a `21b` row) |
| Storage | registered storage (s21b), m³; optional on a take, required on a `21b` row |
| Valid from / to | inclusive ISO dates; either may be open |
| Registration number, property | used to match the row to a node, and shown in the list |
| Registered user | the holder's name; see [Who sees what](#who-sees-what) |
| Reference | free text: the letter, the extract, a note |
| Source | the imported file (name and SHA-256), or none when typed in by hand |
| Months | licence condition (103): the calendar months the use may happen in; none = none stated |
| Maximum rate | licence condition (103): the most it may take at once, m³/s; optional |
| Conditions | licence conditions in words (103), up to 20, e.g. "No abstraction below 0.2 m³/s at the weir" |

Licence conditions are recorded and shown (the list sums them up in one
line, "Oct–Mar only · at most 0.05 m³/s · 2 conditions"). The months and
the maximum rate bind a run whose allocation mode is **cap** (engine 1.37.0,
[model.md §2.12a](./model.md#212a-allocations-and-full-allocation-runs-engine--1180-issue-72)):
the unit takes nothing of that source in a month outside the months of use,
and at most the rate × 86 400 m³ a day. The comparison and a full-allocation
run don't read them, and the conditions in words are never applied.

A cap run says which limit held use back (engine 1.40.0): per unit, source
and water year, the days the source took all the room it had and the unit
still went short, split into days the year's volume was used up, days at
the maximum rate and days outside the months of use, beside the years the
volume was used up (`RunSummary.allocations` `limitBound` and `capReached`,
[model.md § Which limit bound](./model.md#212a-allocations-and-full-allocation-runs-engine--1180-issue-72)).
The Allocations page shows it under the picked unit's water years ("The cap
held use back on 80 days in 1 water year: 80 with the volume used up. The
registered volume was used up in 2021/22."), and the run's summary CSV has
an *Allocation cap by water year* table. When a licence states conditions,
the run also stores what is left of the year's volume each day
(`allocation_left_surface` / `allocation_left_groundwater`) beside the day's
room. A run before 1.40.0 has the years the volume was used up only; run the
model again for the days. Both come from the whole run, a forecast tail
included, while the comparison reads the record only (issue #51); the page
says so for a forecast run.

A farm may have several allocations (a registration and a later licence;
surface and groundwater). The comparison adds up every allocation in force for
the farm and source on each day.

Tables and policies: [data-model.md § Allocations](./data-model.md#allocations-038_allocationssql-103_allocation_conditionssql).

## Importing

WARMS has no public API; a CMA or DWS sends an extract. Importing one needs
its reference: **how you obtained this extract** (the DWS or CMA letter or
terms; 162, operator agreement 3A.1(d)). No published DWS terms for WARMS
extracts were found, so the app records the client's; stricter terms win
over the app's defaults. Extract layouts vary,
so the importer finds columns **by their heading** through an alias table
(`backend/src/allocations/parse.ts`, `HEADER_ALIASES`): "Registration
Number", "Registered Volume (m3/a)", "Resource Type", "Water Use Sector" and
so on, or the app's own template headings (`registration_no`, `farm`,
`holder`, `authorisation`, `purpose`, `water_source`, `volume_m3_year`,
`storage_m3`, `valid_from`, `valid_to`, `reference`, `property_ref`, the
licence conditions `months` (numbers or names, ranges over the new year:
`Oct-Mar`), `max_rate_m3s` and `conditions`, separated by `|`, and
`water_use`, `21a` or `21b`, blank = a take). The
template is downloadable from the Allocations page's Import sheet. The aliases are **pending a real
extract** from the client (followups.md): a column the importer doesn't know
is listed as "not read", never guessed.

- **File.** CSV, comma- or semicolon-separated (a `;` file reads a comma as
  the decimal mark), UTF-8, at most 2 MB, 5 000 rows and 200 columns. Quoted fields,
  doubled quotes and line breaks inside quotes are read. XLSX is not read
  yet: save the sheet as CSV.
- **One row per s21 water use** (issue #72). WARMS registers water per
  water use, per property: a 21(a) row's registered volume is a take per
  year, but a 21(b) row's is the dam's storage. So each row is read by its
  **water-use code** (a column headed "Water use", "s21", "Water use code"
  …: "21(a)", "21a", "s21 a", "Section 21(a)", "a", "taking water"; "21(b)"
  …, "storing water") and the volume by its **unit and frequency** (a "Unit"
  column such as `m3/a`, `Ml/a`, `ML per annum`, `kl/a`, or a unit and a
  separate "Frequency" column; a megalitre is 1 000 m³; with neither column,
  m³ a year as the volume heading says). A 21(b) row is stored as storage
  only (its volume cell, or the storage column, as the storage; volume 0;
  surface water when the source is blank). These rows are **refused, not
  guessed**: no code, a code naming two uses ("21(a)(b)"), another s21 use
  (21(c) to 21(k): not a take or a storage the app compares), a blank or
  unreadable unit (a lower-case "ml" too: millilitres as written), a unit
  and frequency that disagree, a take per month, day or second (the app
  won't guess how they add up to a year), a 21(b) row with two different
  storages, with none, or on groundwater. A WARMS extract **without** a
  water-use column is refused whole: its storage rows can't be told from
  its takes. The template has its own volume and storage columns, so there
  a blank or missing `water_use` is a take.
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
- **Authorisation words** (`parseAuthorisation`, issue #281): "existing",
  "ELU", "existing lawful use", "s32" or "claimed" / "unverified" ELU read as
  `existing_lawful_use_claimed`; only an explicit "verified" (ELU) or "s35"
  reads as `existing_lawful_use` (verified). "Schedule 1", "Sch 1" or
  "permissible use" read as `schedule_1`, never as a general authorisation
  ("GA", "s39"). Migration 136 moved imported rows stored as verified before
  this to the claimed value, since the cell's words weren't kept; rows typed
  in by hand keep what was picked.
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
  volume, marked **part**, and isn't counted in the summary. A forecast
  run (WP-2.12) is compared on its record only, the days before its
  forecast (issue #51), so its last water year may end as a part year.
- **Status**, with the project's band, ±10 % unless set (Settings ›
  Registered volumes, `settings.allocationTolerance`, pending the
  hydrologist; `?tolerance=` on the API overrides it for one request):
  *above registered* (modelled > registered × 1.1),
  *within band*, *below registered* (< × 0.9), *no registered volume*
  (modelled use with nothing in force), *no use, none registered*.
- **Storage**: the sum of the farm's registered storage (21(b) rows and
  storage stated on a take) beside the dam capacity the run modelled, with
  the difference (capacity − registered) and a status banded like a year's
  use (issue #72): *over* is a dam larger than the storage registered for
  it, *under* a smaller one, *unregistered* a dam with none registered. The
  page says it in words. Arithmetic only: whether filling the dam is also a
  s21(a) take is the hydrologist's question (issue #90). A 21(b) row is
  never part of the registered volume a year's use is compared with.
- Allocations not matched to a node, or matched to a node the run doesn't
  have, are counted and named, not compared.

### The allocation mode (engine ≥ 1.18.0)

Settings › Registered volumes › **Allocation mode** (`settings.allocationMode`)
decides what the volumes do to a run
([model.md §2.12a](./model.md#212a-allocations-and-full-allocation-runs-engine--1180-issue-72)):

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
  registered or licensed volume were taken in full (a registration is not an
  entitlement), the background of a cumulative
  assessment (WP-3.11). A scenario can switch it on for one run
  (`settings.set allocationMode`, [scenarios.md](./scenarios.md)).

A scenario can also set, replace or remove a volume for one run
(`allocation.set` / `allocation.remove`, engine ≥ 1.35.0, [scenarios.md §
Registered volumes](./scenarios.md)): "what if this licence were for 200 000
m³ a year" under the cap, or the applicant's requested volume in a
full-allocation background. The op carries only what a run reads (no
holder, registration number or property); a volume on the applicant's own
unit is their proposal, one on another's a baseline assumption.

Since every run's input carries the volumes (never the names), a stored run
replays with the volumes it ran on, a change to a volume makes the latest run
out of date, and comparing two runs lists the volumes that changed.

### In the evidence report

The licensing evidence report ([ui.md § Evidence report](./ui.md#evidence-report),
[design/evidence-report.md](./design/evidence-report.md)) carries the
comparison as **§ 5 Registered water use** and one fixed page-1 row,
*Registered vs modelled use* (issue #71; `EvidenceReport.allocations`,
report version `evidence-2`). The persona licence applicant asked for
existing lawful use beside the application's numbers.

- **Page 1's board against full authorised use** (`evidence-14`, licensing
  build item 8; [evidence-pack.md § Both impact bases](./evidence-pack.md#both-impact-bases)):
  the baseline and the application run again with every holder at their
  registered volume, and the volume it held them to is printed by how it is
  held (`authorisation`: licence and verified existing lawful use as
  entitlements, the rest not), totals only: no holder, registration
  number or unit is named, so a viewer reads nothing the Allocations tab
  wouldn't show them. The mix reads the allocations' rows when an editor
  runs the pair (a later change shows only when it is run again).
- **Each run's own volumes, not today's.** The backend
  (`backend/src/allocations/runUse.ts`, `runAllocationComparison`) runs
  `compareAllocations` over the run's stored series, the allocations stored
  in its input and the run's own `allocationTolerance`, record days only. A
  volume added after a run doesn't reach its report; the Allocations tab
  (the project's volumes and band now) can differ for an older run. Both
  read the same series through `runUseNodes`, so a run's figures agree.
- **What § 5 shows**: per farm or water user with a volume in either run and
  per water source with one, every water year of both runs (registered
  volume, modelled use, how they compare), the whole years above, within
  and below the band, the mean volumes, the allocation mode each run ran
  with (`RunSummary.allocations.mode`) and the volumes on no unit (counted,
  not compared). Units are matched across the runs by node id, as § 4
  matches them; a unit only one run has is marked. A part year is marked
  per run and counted only in a run it is whole in; when the runs used
  different bands, the row, the flag and § 5 name both. The over/under-use
  chart plots each whole year at modelled ÷ registered, with a screen-reader
  description counting the whole years above the band per run. The
  Allocations tab draws the same chart (`allocations/UsePlot.svelte`) for the
  run it compares, with the project's band now ([ui.md § Allocations](./ui.md#allocations-taballocations)).
- **What the cap held back** (report version `evidence-6`): a run made with
  the cap cites, per unit and water source it caps, the water years its use
  reached the registered volume and the days the licence limit held use
  back, split into volume used up, maximum rate and outside the months of
  use (`capA` / `capB`, copied from the run's `RunSummary.allocations`, the
  same words as the Allocations page). A source the run doesn't cap reads
  "Not capped"; the table is left out when neither run is a cap run, and a
  pack drafted before `evidence-6` has none.
- **The page-1 row** sums the whole unit-years above the band over units and
  sources, baseline and application, with the run's own difference and no
  band (the ensemble doesn't carry it). It is a fixed row (G6): when the
  runs carry no volumes, or none on a unit of theirs, or cover no whole
  water year, it prints *Not assessed* and why, and the "expect questions"
  list names it.
- **A flag** under *Read these first* (caution) when the reported run (the
  application, or the baseline for baseline evidence) is above a volume in a
  whole year: each unit and source, with the baseline's count beside the
  application's, at most five, then a count.
- **No names.** A run's stored allocations never carry the holder's name or
  the registration number, so neither does the report, whoever reads it
  (viewers and up). An issued evidence pack (WP-3.14) freezes this document.
- **Only the applicant's own units, one by one** (report version
  `evidence-15`, decision D3). Every other unit is one *Other registered
  users (n units)* total per water source and water year (the volumes and
  use summed, judged against the band as a whole), left out when fewer than
  5 units hold that source; the section says how many were left out. Baseline
  evidence has no applicant, so every unit is in the totals. The page-1 row
  still counts unit-years over the band unit by unit (`unitYears`, counts
  only), and the flag names the applicant's units or the total. The
  project's editors see every unit on the Allocations tab. The engine counts
  units, since a run's allocations carry no holder.

### What the comparison is not

- Not a finding. The model's supply is what the calibrated model would take
  with the demand it was given, not a meter reading. A registered volume can
  be missing, out of date or held by someone else.
- Not the whole entitlement picture: the Reserve, other users' priority and
  licence conditions (`months`, rates) aren't applied here; only a cap run
  applies them (above).
- Pending the hydrologist: the ±10 % band, and counting supply from the
  farm's own dam as abstraction (the WP says so; a hydrologist may want dam
  filling, s21b, compared with storage instead, issue #90).

## Who sees what

Decision D3, provisional position (pre-counsel research, 2026-10-01; the
reasoning is in [security.md § Allocations](./security.md#allocations-popia-minimisation-038_allocationssql)):

| Reader | Volumes, numbers, dates | Registered user's name | Writes |
| --- | --- | --- | --- |
| Owner, editor | all | all | yes |
| Viewer | only when an owner switches **What viewers see** on (`project.allocations_viewer_units`, 162); otherwise totals per water source held by 5 or more registered users: the volume and storage in force today, and a run's use against them by water year | none | no |
| Farmer | their linked farms' allocations only (RLS); the farm view shows their own farm's totals | their own only (not shown on the farm view) | no |
| Share links, pack links, the verify page | none (any later total at 5 or more holders, never per unit) | none | no |
| An issued evidence pack | the applicant's own units; the rest as totals at 5 or more units (`evidence-15`) | none | no |
| Not a member | nothing | nothing | no |

The switch is off by default, for viewers can be outside the organisation
(an NGO posting public-participation comments). The Allocations tab tells
an owner to switch it on only if every viewer works for, or was appointed
by, the organisation. With it off, no route hands a viewer a copy of the
volumes ([api.md § Allocations](./api.md#allocations)), except a capped
run's per-unit daily series, which still bound use by the volume
([followups.md § Allocations](./followups.md#allocations-wp-310)).

Names live in their own table (`allocation_holder`) so RLS, not the API,
hides them. Farmers are refused the allocations routes (like every viewer
route). Their farm view shows **Your registered water** (issue #72,
`FarmView.registered`): the farm's own surface and groundwater volumes a
year and registered storage in force today (Schedule 1 permissible use left
out: it isn't registered with DWS), summed, read under their RLS,
beside the season's modelled supply and the modelled dam, with "A
registered volume is not an entitlement, and it doesn't say whether a use is
lawful". No holder name, registration number or property, and nothing about
another farm. This isn't blocked by D3, which is about other people's names
and volumes; the farmer's own figures are theirs (and already in their
data-subject export). The history (readable by viewers) records
registration numbers and counts, never names.

## Still to build (WP-3.10)

Tracked in [followups.md § Allocations](./followups.md#allocations-wp-310):

- XLSX import and a column-mapping step for extracts whose headings the alias
  table doesn't know (waits on a real WARMS extract).
- Allocation figures on share views: totals only, at 5 or more holders (the
  share links' `k` rule), never a unit name beside a volume, never a name
  (D3, narrowed from "volumes public, names hidden": per-farm volumes aren't
  anonymous). Share views show none today.
- Whether filling a dam is also a s21(a) take, and how the cap counts water
  drawn from a dam that boreholes filled (pending the hydrologist, issue
  #90). Dam capacity against registered storage is built (above).
- The issued pack (WP-3.14) freezes § 5 once it lands.
