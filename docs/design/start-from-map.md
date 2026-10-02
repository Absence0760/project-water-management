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
   gauging station (Settings → Data feeds), each dam's capacity from the
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
parcels carry "Sub-catchment delineated from … (start-1)".

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
   with the unit below it, since a user has no land.
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

## Not built (and why)

- **Place search**: decided against for now (#326 D-C3).
- **Intermediate gauges** splitting the network: a gauge other than the
  outlet is *not in the model* here; add it on the Network afterwards.
  Units in this model drain to gauges through `downstreamNodeId` as any
  node does, so this is a later step if hydrologists want it.
- **Catchments larger than about 100 km across**: refused, as delineation
  is (followups.md, the worker-job path).
- **Applying to a model that has nodes** (re-partitioning an existing
  network): it would overwrite typed areas and the order, which this flow
  never does silently. The per-feature tools (Delineate → Accept as an area
  → Use this area) cover one unit at a time.
