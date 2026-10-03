# Design: delineating a catchment from a clicked outlet

Design for #326 **B-delineate** and #342 map item 4: click an outlet (or a
dam wall) on the Map tab and the app proposes the catchment upstream of it,
which the editor accepts or rejects. Decision **D-B6** asks for this
document before the build; it was written first and then built to it.
Where the build had to differ, the section says so. Status: **built**
(migration 175, `backend/src/delineation/`, the Map tab's
**Delineate**; 176, reserved for this work, wasn't needed), on the synthetic DEM fixture and on the Copernicus DEM that
`pnpm dev:tiles:terrain` fetches.

## What the user sees

1. On the Map tab an editor picks **Delineate** (beside Draw and Place).
   It is only there when the server has an elevation model (below); a
   viewer never sees it.
2. They click the river at the outlet, or just below a dam wall, or type
   the point's coordinates (the non-pointer path, as Place has). They say
   which it is (outlet or dam wall); it changes the proposal's name and
   nothing in the method.
3. The server delineates (a second or two locally) and the map shows the
   proposed polygon, dashed, with the snapped outlet, beside a card: its
   area, how far the click moved to reach the channel, the cell size, the
   dataset and method, and the caveats (§ Accuracy).
4. **Accept as the catchment boundary** saves it as the project's boundary.
   If the project has one already, the card says so and the editor must
   tick **Replace the current boundary**; the server refuses otherwise
   (409), the same rule as a GeoJSON import (D2). Nothing is ever replaced
   silently. **Accept as an area** saves it as an *other* polygon instead
   (for a dam's upstream area, which the editor may then link to a unit).
   **Reject** closes the proposal. Either way the proposal stays on record
   with its decision.
5. A new click replaces an open proposal (the old one is marked
   superseded), so there is one open proposal per project at a time.

Accepting never changes the model: a unit's area still enters it only
through "Use this area" (`area-from-map`), as before.

## The DEM

**Source: the Copernicus GLO-30 DEM that PR #339 already fetches** for the
Relief layer (`pnpm dev:tiles:terrain`: Mapterhorn's planet build,
Terrarium-encoded lossless WebP tiles in one PMTiles file, cut to South
Africa). Its licence was checked for #339 (docs/maps.md § Sources):
free, worldwide, reproduction, distribution and **adaptation** allowed,
with no restriction on commercial use, so deriving flow directions and
catchment polygons from it passes D-B. A delineated polygon is adapted
data under its Art. 6(b), so the proposal card and the accepted feature's
provenance carry the Copernicus notice (§ Attribution).

Alternatives considered:

| Option | Licence (read 2026-10-01) | Why not |
| --- | --- | --- |
| HydroSHEDS v1 flow direction (3″, about 90 m, conditioned from SRTM) | Its product page: "freely available for scientific, educational and commercial use", under the HydroSHEDS licence agreement in its technical documentation (the site's own terms of use are non-commercial, but they cover the website, not the data products) | Passes D-B, but a third of GLO-30's resolution, built from 2000-era SRTM, and a second large download to host. Pre-conditioned rivers (stream burning) would help in flat land; noted under § Accuracy as the upgrade if GLO-30's flats prove a problem |
| MERIT Hydro | Dual: CC BY-NC 4.0, or ODbL 1.0 with derived data released under the ODbL (its page, read 2026-10-01) | Non-commercial, or share-alike on our output (the delineated polygons): both fail D-B |
| A client's own DEM | the client's | #288's original plan; still possible (any Terrarium PMTiles is read), but no longer waited for |

So no pre-conditioned flow-direction dataset is used: **flow direction is
derived from the DEM on the server**, with depression filling.

**Configuration** (backend env, never the frontend):

- `DEM_URL` empty (the committed default): delineation is **off**, the
  Delineate tool is absent and the routes answer that it is off. A fresh
  clone and CI download nothing.
- `DEM_URL=http://localhost:9002/tiles/terrain.pmtiles` (what
  `pnpm dev:tiles:env` prints, after `pnpm dev:tiles:terrain`): the local
  MinIO copy of the operator-fetched DEM, read by ranged GETs.
- `DEM_URL=backend/fixtures/dem/synthetic-dem.pmtiles` (or any file path,
  `file:` URL): the **committed synthetic fixture**, invented terrain (an
  elliptical valley with a river, a dam and its reservoir, a closed pit),
  220–360 KB, PNG Terrarium tiles. The tests and the e2e use it.
- `DEM_URL=s3://<bucket>/tiles/terrain.pmtiles`: production, ranged S3
  GetObject (the API Lambda reaches S3 through the VPC's S3 interface
  endpoint; `delineation_dem = true` in the tfvars sets it and the role's
  read of that one key, infra/map_data.tf, deployment.md § Map tiles).
- `DEM_LABEL` names the dataset on proposals (default: the archive's own
  name and version from its metadata, else its attribution).

**Reading it** needs no new dependency: a PMTiles v3 reader
(`pmtiles.ts`, directories and ranged reads), a lossless WebP (VP8L)
decoder (`webp.ts`, RFC 9649; lossy tiles are refused, since their
elevations would be off by an unknown amount) and a PNG decoder
(`png.ts`, Node's zlib). A native image library (sharp/libvips) was
rejected: a platform binary in the API Lambda for one feature. The WebP
decoder is checked pixel for pixel against libwebp's output
(`webp.test.ts`, synthetic images covering every transform) and was
checked the same way against real Mapterhorn tiles locally.

## Where it runs

**On the backend, in the API request**, never in the engine (the engine
stays pure: no I/O, and delineation is map tooling, not the model) and
never in the browser (the DEM is gigabytes; the browser only gets the
polygon).

- One request reads the tiles it needs (ranged reads, decoded tiles cached
  in the process), computes, and stores a proposal row. Measured on this
  laptop against the real DEM: a 1 024-cell window (about 34 km a side)
  takes 0.5–1.8 s, 2 048 cells about 2.3 s with the smaller window first,
  the 3 072-cell cap about 4 s and 460 MB resident.
- **Lambda limits**: the API Lambda has 1 024 MB and a 30 s timeout (under
  CloudFront's 35 s); with `delineation_dem` on, Terraform refuses a plan
  that lowers them under 1 024 MB or 25 s. The request keeps a **20 s budget**: before growing
  the window it estimates the next window's cost from the last one and
  hands the click to the worker (below) rather than run into the timeout.
  The cap (3 072 cells) keeps
  memory near 0.5 GB. A request is one CPU-bound call per click; the
  project is limited to 30 delineations an hour (429 beyond), so a
  script can't keep a Lambda busy.
- **The worker, for a large catchment** (`191_delineation_request`,
  `backend/src/delineation/requests.ts`, `jobs/handlers/delineate.ts`): a
  catchment still at the edge of the request's 3 072-cell window, or one
  whose next window would break the 20 s, is handed to a `delineate` job
  instead of refused. The job runs the same `delineate()` with the
  worker's windows (`JOB_WINDOWS`: 4 096 and 6 144 cells, about 135 and
  200 km at zoom 11), from the one after where the request stopped, within
  a 150 s budget under the worker's 300 s timeout. Measured on an invented
  valley (this laptop, 2026-10-03): 4 096 cells about 4.5 s and 530 MB, 6 144
  cells about 11 s and 1.05 GB peak (8 192 would be about 21 s and 1.8 GB,
  hence the cap); the pans' copy of the elevations (§ Pans) adds 4 bytes a
  cell, so 6 144 cells now peak at about 1.2 GB (the real DEM around
  Bultfontein, 2026-10-03). With `delineation_dem` on, Terraform gives the worker at
  least 2 048 MB (`infra/jobs.tf`), which also buys it more CPU.
  **Why only then, not every click**: most catchments are proposed in a
  few seconds by the request, and locally the worker runs only with `pnpm
  dev:full`; a click that always waited on a worker would be slower and,
  locally, wait for nothing. The editor can still send a point straight to
  the worker (`background`) when they know it is large, which also spares
  the API the 20 s it would spend first.
  **Cost**: one waiting or running `delineate` job per account (under a
  per-account lock; the job's dedupe key names the account), a new click
  in the same project superseding the waiting one; each request still
  counts against the account's hourly elevation-model cap, and the
  worker's reserved concurrency bounds the rest. The DEM is read while the
  job's transaction is open (as `pack_reproduce` reads its bundle), bounded
  by the budget.
  **The outcome** is a row of `delineation_request`: the proposal it made
  (stored, superseding and audited exactly as the request's, so it is
  accepted or rejected the same way) or the refusal in the request's own
  words, which the Map polls for. A refusal is an outcome, not a job
  failure; only a DEM read that fails twice kills the job.
  No method version changes: the job proposes what a request with those
  windows would.

## Method

All in `backend/src/delineation/`, pure functions over typed arrays
(`flow.ts`, `outline.ts`) driven by `delineate.ts`.

1. **Zoom.** The DEM is read at Web Mercator zoom min(11, the archive's
   max zoom). With 512 px tiles, zoom 11 is about 31–35 m a cell over
   South Africa, GLO-30's own resolution; zoom 12 (16 m) would only be
   upsampled data at four times the cost. Cells are square in the
   projection, so D8's distances hold locally.
2. **Window.** A square of 1 024 cells centred on the click. If the
   catchment reaches a cell beside the window's edge it may continue
   beyond, so the window grows (2 048, then 3 072 cells, and on the worker
   4 096 and 6 144, § Where it runs). A catchment still at the edge at the
   worker's cap is **refused, never cut off**.
   - **Placed over the catchment** (since `delineate-6`): each larger
     window is placed by the catchment the last one cut (`windowOrigin`).
     On an axis where it was cut at one end only, the window starts just
     short of the catchment's other end, so the whole window lies the way
     it runs; cut at both ends or neither, it is centred on the
     catchment's box. The click always stays 6.5 km inside (the junction's
     match and its path downhill, `junction.ts`), so the outlet's placement
     sees what it would in a centred window. Centred, the 3 072-cell cap
     held only about 50 km upstream of the outlet and half the window lay
     downstream: A62H's outlet (DWS 873 km², a long catchment running
     east-south-east) was refused at every window, while placed it is
     890 km² in the 3 072-cell window (persona-hydrologist finding 6).
   - **A river the window cuts** (since `delineate-6`): when a river
     reach gives the click an expected area and no channel matches it
     (step 6), but a channel within the match radius is cut by the window
     with less than twice that area, its area here is only a lower bound,
     so the window grows (placed over that channel's catchment) instead of
     falling back to the snap. In a 1 024-cell window (about 1 150 km²)
     a river of a few hundred km² carries only its in-window share, so no
     cell matched it and the click went into a gully or was refused beside
     a "much larger channel" quoted at its window-local area: D17D's
     outlet (DWS 750 km²) gave 134 km², N22D's and C51D's were refused
     (persona-hydrologist finding 1); grown, they are 747, 344 and
     869 km². It looks as far as `place()` matches (2.5 km for a river
     picked at a confluence or from a gully, else 1 km). Not when the point
     is kept (`keepPoint`: the editor chose the small channel), not when a
     channel matching the reach is already offered (place.ts rules 3 and
     4), not for a reach larger than the worker's cap's
     whole square (the Orange: no window can match it), and at the
     worker's cap the snap and its guard apply as before. The request's
     last window hands such a click to the worker like any other
     (`too_large` with its window, `capCells`).
3. **Depression filling: Priority-Flood+ε** (Barnes, Lehman & Mulla 2014,
   *Computers & Geosciences* 62, Algorithm 3), seeded from the window's
   border and from the cells beside no data, each at its own elevation
   (no-data cells have none and seed nothing; step 9). Every pit and flat is raised to just above
   its spill point (the next float64 up, so the raise is invisible), which
   gives every cell a strictly lower neighbour: D8 then drains every cell
   to an edge with no cycles, and flats drain towards their outlet.
4. **Flow direction: D8**, steepest drop over distance to one of the eight
   neighbours, on the filled surface.
5. **Accumulation**: upstream cell counts, in topological order.
6. **Placing the outlet** (`place.ts`, since `delineate-2`; the evidence is
   [delineation-snapping.md](./delineation-snapping.md), issue #374). River
   lines sit off the channel the DEM routes along (a median 150–260 m from
   HydroRIVERS on South African reaches, over 1.2 km at the 90th
   percentile), so the old rule alone, the most-drained cell within 150 m,
   put about half of the clicks on a river line into a gully.
   - **Matched**: with a river reach within 1 km of the click
     (`river_reference`, `reach.ts`), the cell within 1 km whose upstream
     area best matches the reach's, by Lehner's (2012) station allocation:
     cells within 50 % of the area, ranked by area misfit plus twice the
     scaled distance. The reach's area is taken **at the click** (since
     `delineate-5`): its upper end's area (what flows in, or HydroRIVERS'
     10 km² threshold for a head reach) plus the rest in proportion to how
     far down the line the click lies, so a click near the top of a long
     reach no longer slides down it to the lower end's area. A click on
     the DEM's own channel (1 km² or more within a cell and a half) more
     than 150 m from the reach's line, whose own area is outside the 50 %
     band, is **not moved** past the snap radius by the match: it snaps,
     and the reach's matching channel is offered as below (a farm dam's
     stream beside a river stays the stream unless the editor says
     otherwise). A click on a channel *larger* than the band stays on it
     wherever the line is (a gauge on a river whose nearest mapped line is a
     tributary's, beside a junction), the tributary's channel offered. None passing falls through to:
   - **Snapped**: the cell with the most upstream cells within **150 m**
     (about five cells) of the click, measured from the exact click to
     each cell's centre, so the distance moved never exceeds it (since
     `delineate-4`, issue #387: the radius used to be counted in whole cells
     from the clicked cell, which reached up to 160–180 m on GLO-30's cells
     and 200 m on the synthetic DEM's), the nearest of equals;
     the clicked cell itself always counts; and the **larger-channel
     guard**: when a channel with 100× its upstream cells runs within 1 km,
     the click is refused (422 `larger_channel`) naming that channel's
     nearest cell, its distance and both areas, and the sheet offers **Use
     that channel** or **Keep my point** (`keepPoint`). It is never moved
     there silently: near a confluence the bigger channel is the wrong
     river. When nothing within 1 km matched a nearby reach and the snap
     landed in a gully (under a tenth of the reach's area), the match is
     tried again out to 2.5 km and that channel offered the same way (since
     `delineate-5`): that far off it can be another river, so it is never
     taken silently.
   The distance moved is shown. Fewer than 9 upstream cells is refused
   ("click on the river itself").
7. **Upstream cells**: every cell whose D8 path passes the snapped outlet.
8. **Polygon**: the cells' outline traced along their edges, one ring
   (cells that touch only at a corner, which D8 joins, stay one piece,
   the ring passing a quarter-cell off the corner so it never touches
   itself), holes dropped, simplified with **Douglas–Peucker at one cell**
   (about 33 m), retried at half a cell and then not at all if the
   simplified ring would cross itself. It is then checked by the same
   `checkGeometry` every map polygon passes, and its area computed on the
   ellipsoid (`geo/area.ts`). Typical outlines are tens to hundreds of
   vertices (a 600 km² catchment: about 650).
9. **No data**: a catchment that reaches the data's edge (a cell beside a
   missing tile: the edge of the operator's extract) is refused, since what
   lies beyond is unknown; so is a click whose river reach is cut there
   with no channel matching it (step 2). The sea is data (elevation 0 or
   below), not no data. The cells beside no data are edges like the
   window's border (`flow.ts` `edgeMask`, `NO_DATA_EDGE`): water leaves
   there only where that is the lowest way out. Until `delineate-6` no
   data flooded as lower than any elevation (RichDEM's convention, for a
   DEM whose no data is the sea), so every cell beside it drained into it,
   no catchment could reach it, and the refusal never fired: at 29.92° E,
   22.01° S, two cells from the extract's northern edge, a river of
   1 941 km² was proposed as 154.9 km² (persona-hydrologist finding 2).

**Recorded on every proposal** (`delineation_proposal`): the click, the
snapped outlet and the distance, the polygon and its area, the cell count,
cell size, zoom and window, the dataset label and the archive's
**fingerprint** (SHA-256 of its header and root directory, so two extracts
are never confused), the method sentence and `methodVersion`
(`delineate-1`, then `delineate-2` for the matched outlet and the
larger-channel guard, `delineate-3` for asking the river at a confluence,
`delineate-4` for the snap radius measured from the exact click,
`delineate-5` for a click on the DEM's own channel staying on it, a gully
snap offering the reach's channel out to 2.5 km and the reach's area taken
at the click, `delineate-7` for keeping a click beside a confluence on its
river's side of the DEM's junction (issue #390), `delineate-6` for windows
placed over the catchment, grown for a river they cut, and no data as the
data's edge, `delineate-8` for 5 and 7 together, `delineate-9` for the pans
reported beside the catchment (§ Pans), `delineate-10` for 6 and 9
together; bumped whenever the method changes what a click
proposes), and the pans' report (193).

## Pans

Built for the hydrologist's review, finding 8 (delineate-9, start-11,
migration 193; the research, thresholds and sources in
[pans-research.md](./pans-research.md)). Priority-Flood fills every closed
depression so that D8 can route it to the outlet; in the interior many of
those depressions are pans, whose catchments WR2012 counts as
non-contributing ("endoreic areas"). `backend/src/delineation/pans.ts`
reads the fill's output (the elevations before it, a Float32 copy, and
after it) and reports, beside the catchment:

- **Non-contributing (pans)**: the area of the catchment that drains into a
  pan, the pans' floors included, with **the effective area** (the
  catchment less it), the pans' count and the largest five (the floor's
  deepest point, its area, its depth below the spill, what drains into it
  and what it holds over that, in mm).
- **A pan** is a closed depression of the filled DEM at least **1 m** deep
  below its spill, at least **0.1 km²** in floor, and holding at least
  **100 mm** of its own catchment's runoff below the spill (over twice
  South Africa's mean annual runoff, so an average year doesn't fill it:
  the PFRA's effective-area test). The last rule keeps out a dam drawn
  down below its spillway and the pond behind an embankment, which hold a
  few millimetres over their catchments. A depression holding the outlet
  (or, in Start and Divide, a unit's point), or spilling into it within
  the snap radius, is that point's own basin, never a pan.
- **The catchment is not changed.** It stays the gross one (as WR2012's
  quaternary areas are), routed through the filled pans as before, so the
  polygon and its area are what they were; the figure is reported, and the
  hydrologist decides whether to model the pans as non-contributing.
- **Where it shows**: the Delineate sheet's facts (*Into pans*, *Effective
  area*) and *How it was made* (the pans' method); stored on the proposal
  (`delineation_proposal.pans`). Start and Divide store it in the plan
  (`plan.pans`, each unit's `nonContributingM2` and
  `totalNonContributingM2`, `plan.rest.nonContributingM2`) and add a warning
  naming how much drains into pans and which pieces hold it. A saved
  sub-catchment from clicks says it in its description.
- **Cost** (the real DEM around Bultfontein, the whole window as the
  catchment, the worst case): 0.3 s at 2 048 cells, 0.8 s at the
  request's 3 072-cell cap, 2.7 s at the worker's 6 144 (against fills of
  0.65, 1.7 and 13 s); the copy is 4 bytes a cell, so the worker's largest
  window now peaks at about 1.2 GB (it was 1.05 GB), inside its 2 048 MB.
- **Beside missing data**: the pans read the elevations before the fill,
  where a missing cell is NaN; only the catchment's cells are looked at, and
  a catchment never holds a missing cell or one beside it (§ Method 9), so
  missing data is never a pan.
- **Tests**: `pans.test.ts` (hand-made grids: a pan and what drains into
  it, counted independently; too shallow, too small, too little storage;
  a depression at a point; nested pans), `delineate.test.ts` and
  `subcatchments.test.ts` against the synthetic DEM, whose flank now holds
  a pan (`fixture.ts` `PAN`), the DB tests for what is stored.

## Accuracy, as shown to the user

The card says, in short:

- *A proposal from a 30 m global elevation model, not a survey.* GLO-30 is
  a surface model: it includes trees and buildings, and its stated
  absolute vertical accuracy is a few metres, so in flat land the divide
  can be hundreds of metres out, and a catchment can come out joined to or
  cut from its neighbour.
- *Flat land, dams and pans.* Flats (and reservoirs, which the DEM sees as
  flat water) drain towards their outlet by construction, not by
  observation, and so do pans: the area draining into them is reported
  beside the catchment, not taken out (§ Pans). Canals, pipelines,
  culverts and inter-basin transfers are invisible to it.
- *Check it against the map* (the Relief layer, rivers, the quaternary
  outlines) before accepting, and edit the accepted polygon with Draw if
  needed.
- The snap distance and cell size are shown, so a click that snapped to
  the wrong stream is visible.

Synthetic tests can't show real-world accuracy. The fixture's checks
(`delineate.test.ts`): the outlet's catchment comes within 3 % of the
ellipse it was built from, the dam wall's lies above the wall, refusals
fire where they should.

## Attribution

The Relief layer already carries the Copernicus notice while drawn. A
delineated polygon is adapted data, so the proposal card shows the
dataset label and, for the Copernicus DEM, the Art. 6(b) notice; the
accepted feature is named "Delineated from …" and its proposal row keeps
the dataset and fingerprint. The Art. 6(c) liability sentence is the same
open follow-up as the relief's (docs/followups.md).

## Data model and API

Migration **175_delineation.sql**: `delineation_proposal` (project-scoped;
viewers read, editors propose and decide; RLS and grants in the same
file; the accepted feature linked by a same-project composite key, kept
when the feature is deleted with the link cleared; superseded and rejected
proposals pruned past the newest 50 a project). No other table changes.
Migration **193_delineation_pans.sql** adds `delineation_proposal.pans`
(jsonb: the non-contributing area, the pans' count, the largest five and
the method; NULL before delineate-9).
API in docs/api.md § Delineation:

- `GET /projects/:id/map/delineation` (viewer): whether it is on, the
  dataset, the latest proposals.
- `POST /projects/:id/map/delineation` (editor): `{ lon, lat, from }` →
  the proposal (201), or 422 with the refusal's sentence.
- `POST …/map/delineation/:pid/accept` (editor): `{ as, replaceBoundary? }`.
- `POST …/map/delineation/:pid/reject` (editor).

Each is audited (`map.delineation_proposed`, `…_accepted`, `…_rejected`).

## Not built (and why)

- **Sub-catchments at every dam and abstraction point** (the stretch):
  built with C3, start a catchment from the map
  ([start-from-map.md](./start-from-map.md) § Sub-catchments): every unit's
  incremental area and the order, from one routed window.
- **Stream burning** with a river network: none passes D-B yet (#345).
