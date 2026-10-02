# Design: start a new catchment from the map

Design for #326 **C3** (start a catchment from the map), with the
B-delineate stretch it needs (**sub-catchments at every dam and abstraction
point**, deferred from [delineation.md](./delineation.md) § Not built) and
**D4** (the Map's empty state leads with drawing and delineating). Written
before the build, then built to it (migration 178,
`backend/src/delineation/subcatchments.ts` and `start.ts`, the Map tab's
**Start from the map** sheet); where the build had to differ, the section
says so.

## The flow

An editor with an **empty model** (no nodes) opens the Map tab. The empty
state leads with the map: **Delineate from the outlet** (when the server has
a DEM) and **Draw the boundary**, then *or upload a GeoJSON file* (D4). Once
anything is on the map, the side column offers **Start the model from the
map** while the model has no nodes; it opens a sheet (`start=1`, in the URL
like every Map sheet). The sheet is not a wizard with its own state: each
step is read from what is on the server, so leaving and coming back (or a
reload) lands on the same step.

1. **The boundary.** Done when the project has one. Otherwise the step
   offers Delineate, Draw the boundary and Upload (the existing tools; the
   sheet closes into them).
2. **The points.** Every dam (a point or a polygon), every *other* point
   and every gauge on the map is listed. For each the editor says what it is
   in the model:
   - **A unit with a dam** (dams' default): a hydrological unit whose
     sub-catchment ends at the dam wall;
   - **A unit at an abstraction point** (other points' default): a unit
     whose sub-catchment ends where it takes water from the river;
   - **Another water user** (a town, industry: a *user* node, no land);
   - **Not in the model** (gauges' default, except the outlet).
   The **outlet** is picked from the gauges, or *the boundary's own outlet*
   (the default: the delineated outlet when the boundary came from
   Delineate, else the most-drained cell inside the boundary). **Place a
   point** is a button here (the existing drawing mode; typed coordinates
   behind it as always). **Propose the network** sends the choices.
3. **The proposal** (one open per project, like a delineation): a review
   table with one row per unit, plus the outflow gauge and *Rest of the
   catchment* (what drains to the outlet through no unit; a natural-area
   unit, since the engine's catchment area is the units' sum). Each
   proposed **value** has its own tick, unticked until the editor ticks it
   (or **Tick every value**):
   - the unit's **name** (an input, from the feature's name);
   - its **area** (km²; its incremental sub-catchment), which also saves the
     outline as the unit's parcel, linked to it, so the area is "from the
     map" exactly as Use this area makes it;
   - **drains into** (the next unit downstream, or the outflow gauge);
   - for a dam unit, **runoff to the dam = 100 %** (its sub-catchment is,
     by construction, all above the wall).
   An unticked value is not applied: the area stays 0 (typed on the
   Network later), the unit drains into the outflow gauge, runoff to the
   dam keeps its default. Each row shows the method's facts (snap distance,
   whole area upstream), and the sheet lists the warnings, the dataset and
   the method. **Apply the ticked values** (confirmed) or **Discard**.
4. **Data and the first run.** With the network in, the sheet lists the
   existing Part B proposals, each with its own accept, and where it is:
   rain from the boundary (the CHIRPS feed, on this sheet), the nearest
   gauging station (Settings → Data feeds), evaporation (Settings &
   calibration → Demand, which links Evaporation from the map: the monthly A-pan the dams, river pools and crops lose,
   since an ET₀ row from the map feeds the runoff model only and with no
   A-pan the dams lose nothing; round 4), each dam's capacity from the
   register and full-supply area from its polygon (Dams), cultivated area
   (Crops), and finally **Run the model** (Runs & results). Nothing there is
   new: the step links the proposals that already exist, in order.

**Typing stays.** The Network's *Add outflow gauge* is untouched, a GeoJSON
upload works at every step (step 1 and 2 link it), and any applied value can
be typed over afterwards (an area typed over goes back to *typed*, as now).

**Nothing is silent.** Apply refuses (409) once the model has nodes: the
flow only *starts* a model, it never edits one. Every value applied was
ticked; the proposal row keeps the plan and the ticks (the decision); the
model change is one revision whose reason names the method and dataset; the
parcels carry "Sub-catchment delineated from … (start-2)". (`start-1` was
the first build; `start-2` added gauges as nodes and their counted whole
catchment, the partition of land-owning units unchanged.)

## Sub-catchments: the method

In `backend/src/delineation/subcatchments.ts`, reusing delineation's DEM
reading, filling, D8 and outline tracing (`flow.ts`, `outline.ts`):

1. **One window, routed once.** Centred on the outlet (or the boundary's
   middle when the outlet is to be found in it), at the smallest of
   delineation's windows (1 024, 2 048, 3 072 cells) that holds the
   boundary's box. Filled and routed once; grown while the outlet's
   catchment reaches the window's edge; refused at the cap (the ~100 km
   limit stays, followups.md), as a single delineation is.
2. **The outlet.** A gauge or a delineated outlet snaps as a click does
   (150 m). Otherwise it is the most-drained cell inside the boundary.
3. **Each unit's point** snaps the same way. A dam *polygon* takes the
   most-drained cell inside it (or within the snap radius of it): its
   spillway, near enough. Two points that snap to one cell, or a point
   whose cell isn't upstream of the outlet, are dropped with a warning, not
   guessed at.
4. **Drains into**: follow D8 down from the unit's cell to the first other
   unit's cell, or the outlet's. Exact on the D8 tree: no polygon tests.
5. **Incremental area**: every cell upstream of a unit's cell whose path
   meets no other unit's cell first. One flood upstream from each outlet
   cell that stops at other units' cells, so the pieces partition the
   catchment exactly (each cell belongs to the first unit below it). A
   *water user* point is in the network but owns no cells: its cells stay
   with the unit below it, since a user has no land. A **gauge** inside the
   catchment is the same (a gauge node owns no land); what it measures, its
   whole catchment, is counted from its cells upstream (each at its row's
   cell size), since the pieces above it would miss the land between them
   and it.
6. **Outline**: each piece traced on the cells' edges as delineation does,
   **with its holes kept** (a tributary's unit wholly inside the unit below
   it is a hole in that unit's piece, not overlapping land), simplified
   while it stays valid, checked by `checkGeometry`, and its area computed
   on the ellipsoid. The rest of the catchment is the outlet's own piece.
7. **Checks, as warnings**: the catchment above the outlet against the
   boundary's area (over 10 % apart: said, since a drawn boundary and the
   DEM disagree); a unit whose area is under one hectare; a dropped point.

**Without a DEM** (`DEM_URL` empty, the committed default) the same flow
works with less: the units come from the points, nobody drains into anyone
but the outflow gauge, no unit gets an area, and the rest of the catchment
is the boundary's polygon and area. The sheet says the elevation model is
off, so the order and the areas are the editor's to type. A fresh clone
runs the flow with no download.

**Cost**: one fill and one routing per proposal, not one per point: the
largest window takes about 4 s on the real DEM, the same budget as a single
delineation (20 s), and proposals count against the same 30-an-hour cap.

## Data model and API

Migration **178_start_proposal.sql**: `start_proposal`, project-scoped,
viewers read and editors propose and decide (RLS and grants in the same
file), at most one open per project, a decision final once made (the
175 trigger's pattern), superseded and discarded ones pruned past 50. The
plan is one `jsonb` snapshot (it is only ever read whole, and it records
what was proposed); the decision is another (the ticks, the node ids made,
the revision). Migration 179 (reserved) wasn't needed.

API, in docs/api.md § Start from the map:

- `GET /projects/:id/map/start` (viewer): whether the DEM is on, whether the
  model is empty, and the latest proposals.
- `POST /projects/:id/map/start` (editor): `{ outletFeatureId?, points }` →
  the proposal (201); 422 with the refusal's sentence.
- `POST …/map/start/:pid/apply` (editor): the ticks → the nodes, parcels
  and links, in one transaction and one model revision.
- `POST …/map/start/:pid/discard` (editor).

Each is audited (`map.start_proposed`, `map.start_applied`,
`map.start_discarded`).

## Gauges as nodes

Built after the first release of the flow (#326 C3's follow-up, PR
feat/326-start-followups). In the points step a gauge on the map other than
the outlet is **A gauge in the network (no land)** by default (or *Not in
the model*; a gauge point offers nothing else, since a gauge node stands for
a gauge on the map, map_feature's `KIND_NODES`). It partitions like a water
user: in the order (the units above it drain into it, it drains into the
next point down) but owning no land, its cells left to the unit below. Its
card says what it measures (its whole catchment) and offers its order only.
Applied, it is a `gauge` node (engine ≥ 1.4.0 already reads a gauge node
inside the network: its record, the EWR site checks, docs/model.md §2.10d),
and its point is linked to it. A gauge outside the catchment is dropped with
the reason; without a DEM, a point outside the boundary is dropped too.
No engine change, so no ENGINE_VERSION bump.

## Each unit's piece on the map

The open proposal (a start or a division) is drawn piece by piece
(`frontend/…/map/pieces.ts`, `mapStyle.ts` `proposalLayers`), never as one
shape: each unit's own sub-catchment filled with one of six tints (away
from the map's meaningful hues: no green, blue or amber; touching pieces
always different, `pieceTintsFor`; the rest of the catchment the proposal's
teal) under the proposal's short dash, so the edges between pieces show. Every piece has its **number** on it (a badge inside the
piece, at the middle of the widest stretch through its centroid's latitude,
so inside a crescent or beside a hole; a unit with no land, a water user or
a gauge, beside its point, so its marker stays visible and clickable; the
rest of the catchment **R**). The number is what
identifies a piece: the tint only helps the eye (WCAG 1.4.1).

- **The cards are the key.** Each card in the sheet carries the same number
  and tint (`PieceBadge.svelte`; its text is "Unit 2: 2" to a screen
  reader, "Piece" rather than "Unit", since a gauge is one too). A card with the focus or the pointer **lights its piece**: a
  denser tint and a solid outline in the map's selection colour on its
  casing, and its badge's border in the same colour.
- **From the map.** With the sheet closed, a line over the map says in
  words what the numbered pieces are, with **Review it**; a piece or its
  number under the pointer says its name over the map's top-left corner
  ("Proposed piece 2 / Mid weir"), and a click on one opens the sheet at its card, focused. The
  badges are hidden from assistive technology and take no focus: the sheet's
  cards do everything they do (the map is never the only way).
- Labels are DOM badges, not map symbols, so they need no glyphs (which the
  basemap only has when PUBLIC_TILES_GLYPHS_URL is set).

## Dividing a model that has nodes

Built after the first release (#326 C3's follow-up). **Divide the model**
at the end of the key row's first line under the map (editors, a model with
nodes, a DEM on the server; not in the header, which it would push onto a
second row, nor the side column, whose height the feature list needs) opens
`divide=1`, two steps read from the server:

1. **The points.** Each dam, other point and gauge on the map with a select:
   *Not in the division*, a node its kind may stand for (never the outflow),
   or for an unlinked gauge *A new gauge node*. A point linked to a node
   stands for it by default; two points can't stand for one node. The
   outlet is a gauge linked to the outflow (or unlinked), or the boundary's
   own; the outflow node is the model's one node that drains nowhere.
   **Propose the division** routes the DEM once, as starting does.
2. **The proposal**, one card a point (upstream first), each value with its
   own tick, all off, each **beside the node's value now**: its own area
   ("Now: 12.00 km², typed", "(the same)" when equal), what it drains into
   ("Now: Valley weir"), and for a dam unit all of its runoff to the dam
   ("Now: 50 %"); a new gauge's **Add it** and its name. The rest of the
   catchment's area goes to *nobody*, a unit of the model that isn't one of
   the points, or *a new unit*. Units no point stands for are named ("No
   point stands for Hillside: it keeps its values").

**Nothing is silent.** Apply takes only the ticked values. The plan keeps
each node's values as they were when proposed, and apply refuses (409) a
ticked value whose current one changed since ("Top pump's area changed
since the proposal, so taking the proposed value would overwrite it unseen;
propose again"): what the editor saw replaced is exactly what is replaced.
An order into a new gauge that isn't being added, a loop made by ticking one
order without another along it, or a clashing name, is refused (400) with
the sentence, and the sheet says the same before Apply. A taken area is
saved as the node's `farm_parcel` ("<name>: own sub-catchment", its
description naming the dataset and method) with `area_source = 'map'`; when
the node's area already came from a parcel an earlier start or division made
(its id is in an applied decision), that parcel is redrawn in place, so
dividing again doesn't pile outlines up. A parcel the editor drew is never
touched: the node's area moves to the new one, and the drawn one stays on
the map. One model revision ("Divided from the map: 2 areas, 3 drains-into,
0 runoffs to the dam, 1 gauge added from …"), audited (`map.divide_*`).

**Data model**: migration **182_divide_proposal.sql** adds
`start_proposal.mode` (`start` | `divide`, never changed: the 178 trigger is
redefined to keep it), a division always `from_dem`. One table, so the one
open proposal a project, the hourly cap, discard and the GET are shared.
API: `POST /projects/:id/map/divide` and `…/map/divide/:spid/apply`
(docs/api.md § Start from the map).

## Not built (and why)

- **Place search**: decided against for now (#326 D-C3).
- **Catchments larger than about 100 km across**: refused, as delineation
  is (followups.md, the worker-job path).
- **Dividing without an elevation model**: there is nothing to divide by;
  the sheet says so, and the Network and the per-feature tools stay.
