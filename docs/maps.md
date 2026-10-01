# Catchment map

The **Map** tab (`?tab=map`, opened from the Network header's **Map** link,
not a sidebar row; not the Network's
schematic, whose card is also called "Catchment map") draws a
project's catchment boundary, farm parcels, dams, gauges and rivers over a
self-hosted basemap, and proposes values from them that the hydrologist
accepts one by one. Issue #288, phases 1–2 of roadmap
[WP-3.12](./roadmap/step-3-licensing.md#wp-312-catchment-map). This page
covers the tiles, uploads, areas, the quaternary lookup and its dataset, and
the CSP. The screen is in [ui.md § Map](./ui.md#map-tabmap),
the API in [api.md § Catchment map](./api.md#catchment-map) and the tables in
[data-model.md § Catchment map](./data-model.md#catchment-map-152_catchment_mapsql).

Two rules hold throughout:

- **The map proposes, the modeller decides.** Nothing on the map changes the
  model by itself. A polygon's area enters a hydrological unit only through
  **Use … km²** and a confirmation (a model revision naming the feature); a
  quaternary's values enter the WR2012 check only through **Use**, value by
  value, and then **Save**.
- **The map is never the only way.** Everything it shows is in the feature
  list and table beside it, every action works from there, points can be
  placed by typing coordinates, and areas can still be typed on the Network.

## Basemap

The basemap is one [PMTiles](https://docs.protomaps.com/pmtiles/) file of the
[Protomaps](https://protomaps.com) vector schema (OpenStreetMap data), read by
the browser over HTTP Range with the `pmtiles` protocol in MapLibre. No tile
server and no tile CDN: the file is served from the app's own storage.

- `PUBLIC_TILES_URL` (frontend env) is the file's URL. **Empty** (the
  committed default in `frontend/.env.development` and `.env.production`):
  no basemap, the map is a plain background with the features drawn on it, so
  a fresh clone and CI work with no tiles and never download any. When the
  URL is set but unreadable, the map drops the basemap and says so; the
  features stay.
- The style (`frontend/src/lib/components/map/mapStyle.ts`) draws land,
  water, land use, roads and boundaries with **no labels**, so it needs no
  glyphs or sprites and fetches nothing else. Attribution ("© Protomaps ©
  OpenStreetMap contributors") stays visible whenever the basemap is drawn.
- **Locally**: `pnpm dev:s3:up`, then `pnpm dev:tiles:fetch`
  (`bin/tiles-dev.sh fetch`). It needs the `pmtiles` CLI
  ([go-pmtiles](https://github.com/protomaps/go-pmtiles/releases), one static
  binary on `PATH`), extracts South Africa (`16.3,-35.0,33.0,-22.0`) from the
  Protomaps daily build at maxzoom 13 into
  `~/.cache/water-management-tiles/south-africa.pmtiles` (reading only that
  bbox's byte ranges), and uploads it to the MinIO bucket `tiles`, readable by
  anyone (MinIO is loopback-only), with `backend/scripts/tiles-upload.ts`.
  `pnpm dev:tiles:env >> frontend/.env.development.local` sets the URL
  (`http://localhost:9002/tiles/south-africa.pmtiles`); restart `pnpm dev`.
  `pnpm dev:tiles:status` says what is cached and served.
  `TILES_MAXZOOM`, `TILES_BBOX` and `TILES_BUILD` (a build date) override the
  defaults. **Size: measure before choosing** (decision D7): maxzoom 13 is
  enough to recognise farm dams; expect hundreds of MB at 12–13 and a few GB
  at 15.
- **Production**: not deployed yet. The plan (WP-3.12) is the same file in
  S3 under a `tiles/` prefix behind a same-origin CloudFront behaviour
  `/tiles/*` (Range and `ETag` forwarded, long cache), and
  `PUBLIC_TILES_URL=/tiles/south-africa.pmtiles` in the web release. Until
  then production shows the plain background. Tracked in
  [followups.md § Catchment map](./followups.md#catchment-map-issue-288).

### Colours, theme and the picked name

- **Colours** (`overlayColours` in `mapStyle.ts`, issue #326 E7): the
  catchment boundary amber-brown (dark: amber), long-dashed and thickest;
  **farm parcels green** (the app's `--success`), solid outline and a light
  fill; **water blue** for rivers (3.5 px, thicker than any outline, on a
  6 px casing), dam polygons (a denser blue fill, 45% against a parcel's 18%,
  so a dam reads as water and never as a parcel) and gauge and dam points;
  other features grey and dotted; the picked feature magenta. Every stroke
  has a contrasting casing and is at least 3:1 against the basemap's
  background, land, water and land cover in both themes, parcel green and
  water blue are at least ΔE 60 apart (CIE76; the old blues were 38 light,
  23 dark), and every pair of stroke colours at least ΔE 40
  (`mapStyle.test.ts`). The `*Fill` entries are CSS `rgba()` values, so the
  map's key can draw its swatches from the same function and can't drift.
  Point markers take their colours from the same function, as custom
  properties on the map's box: the component has no hex of its own.
- **Results colouring (A1, prepared):** `CatchmentMap` takes an optional
  `fills` (feature id → CSS colour). A polygon named there is filled with
  that colour at 75% (`RESULT_FILL_OPACITY`) instead of its kind's
  (`overlayData` carries it as a `fill` property; the fill layer's
  `to-color` falls back to the kind's colour when it is missing or doesn't
  parse). Nothing passes it yet.
- **Theme:** the map follows the app's theme, not only the OS's
  (`appTheme.ts`: `<html data-theme>` when set, else
  `prefers-color-scheme`), and redraws when either changes: one style holds
  the basemap and the overlay (`mapStyle()`), so `setStyle` swaps both and
  the features, the pick and the click handlers carry over. A basemap that
  failed to load stays dropped.
- **The picked feature's name** shows in a small box over the map's top-left
  corner (its kind, then its name), until the basemap has labels (A6). It is
  hidden from assistive technology (`aria-hidden`): the ways to pick that it reaches are
  the list's buttons and the point markers' buttons, which already say which
  is pressed, so announcing it again would say everything twice.

### CSP and bundle

- MapLibre and the PMTiles reader are **dynamic imports**:
  `MapTab.svelte` loads `CatchmentMap.svelte` lazily, and that imports
  `lib/components/map/maplibre.ts` (MapLibre, its CSS) when it mounts; the
  `pmtiles` chunk loads only with a tiles URL. The workspace's first load and
  every other tab are unchanged. The bundle guard measures them against a
  ceiling of their own, `mapKb` (decision D8 (b);
  `scripts/guards/check_web_bundle_budget.mjs`), outside the total, and fails
  if MapLibre lands in the workspace page's or a tab's chunk.
- MapLibre's **worker** is an entry of the page build
  (`frontend/vite.config.ts` `workerChunks`, `virtual:maplibre-worker-url`),
  served from the app's origin and passed to `setWorkerUrl`. The existing
  `worker-src 'self'` holds: no `blob:` worker, no `'unsafe-eval'`, no CSP
  change. The guard checks the worker imports MapLibre's shared code from
  `chunks/` rather than carrying a second copy.
- Tiles are fetched with `connect-src`: same-origin in production
  (`/tiles/*`), so `connect-src 'self'` holds. Locally there is no CSP header
  (only SvelteKit's meta policy, which sets `script-src`).
- The app loads **no third-party script, style, font or tile**: MapLibre is
  bundled, the basemap is self-hosted, and there are no glyphs.

## Uploads

`POST /projects/:id/map/import` takes a **GeoJSON** file's text; the server
parses and checks it (`backend/src/geo/geojson.ts`), whatever the browser
did, and refuses the whole file on any problem, listing them per feature:

- **WGS84 longitude/latitude only** (RFC 7946). A `crs` member naming
  anything else, or any coordinate outside ±180 / ±90 (a projected file: a Lo
  zone, UTM), is refused with "reproject it to WGS84 (EPSG:4326)". Nothing is
  ever guessed.
- **2D only**: a third coordinate (elevation) is refused.
- **Types**: Point, LineString, MultiLineString, Polygon, MultiPolygon.
  GeometryCollection, MultiPoint and null geometries are refused. Each kind
  takes the types that fit it (a boundary or parcel is polygons, a gauge a
  point, a river lines; a dam a point or polygon).
- **Rings**: closed, at least 4 positions, with an area, not crossing or
  touching themselves, each hole starting inside its outer ring, not across
  the antimeridian. The self-crossing check is a sweep with a budget of 5
  million segment comparisons per ring, past which the ring is refused as too
  complex, so a hostile file can't cost quadratic time.
- **Limits**: 5 MB of text, 500 features, 50 000 positions per feature. The
  route has its own body limit (app.ts exempts it from the general 4 MB).
- **Properties**: only `name` (or `Name`, `NAME`, `label`, `title`) as the
  feature's name, and `description` and `ref`, trimmed and capped. Everything
  else is dropped: an attribute table can carry owners' names or ID numbers,
  and the map has no use for them.
- The file's SHA-256 is kept with its name (`geo_source`); the same file
  can't be imported twice into a project.
- A **catchment boundary** file's polygons become one boundary (a
  MultiPolygon if several), replacing the project's current one. A parcel,
  dam or gauge named like a node of a fitting kind is linked to it; the
  editor can change the link.

**Shapefiles are not read yet** (WP-3.12 plans `shpjs` and proj4 in the
browser, with Hartebeesthoek94 Lo projections from the `.prj`); the form
says to export the layer as GeoJSON in EPSG:4326 (QGIS: *Export → Save
Features As*). See followups.

## Areas

Every area is computed **on the server** (`backend/src/geo/area.ts`), never
taken from the client: the geodesic area on the **WGS84 ellipsoid**. Each
vertex goes to Lambert's cylindrical equal-area projection of the ellipsoid
(longitude and authalic latitude, on the authalic radius), where areas are
exact, and the ring's area is its shoelace sum there: the Chamberlain &
Duquette (2007) formula `@turf/area` uses, on the ellipsoid instead of a
mean-radius sphere (which is up to ~0.5 % off at South African latitudes),
with no dependency. `area.test.ts` checks a 1 km² square at 22°, 30° and
34.5° S (within 0.01 %) and a quarter of the ellipsoid against WGS84's
published surface area.

**Use … km²** on a farm parcel's (or an `other` polygon's) row sets a hydrological unit's area
(`node.area_km2`) to it after a confirmation, and records a model revision
whose reason names the feature ("Area of Upper farm from the map: “Upper
farm” (9.257 km², computed from its polygon)"), which the History tab and the
run comparison's input diff show. The unit's `area_source` is then `map`
(with the feature), until its area is typed over (back to `typed`) or the
feature is deleted (the area stays; the link goes). The area is the farm's
**catchment area** (runoff), so the polygon to use is the farm's
sub-catchment, not its irrigated land. Only farm nodes take one, and only from a farm parcel or an `other` polygon: a dam's water surface and the catchment boundary are never offered, and the server refuses them (`AREA_KINDS`, `backend/src/geo/routes.ts`). While the
model has unsaved edits the button waits: the change is saved straight away.

## Checks

The Map tab's **Checks** (issue #326 A4) list what looks inconsistent
between the map and the model: a one-line count under the feature list, and
the warnings in the **Map checks** side sheet (`checks=1`, `MapChecks.svelte`;
`cap` folds a long list behind "Show all", unused in the sheet). They are **warnings
only**: nothing stops a save or a run. Each warning names its features as
buttons that select them on the map and in the list; "No problems found"
when there are none. The checks are pure and in the browser
(`lib/components/map/mapChecks.ts`, no dependency; `mapChecks.test.ts`), the
thresholds named constants there:

- **Units with no parcel**: a hydrological unit (farm node) that no farm
  parcel is linked to.
- **Outside the boundary** (only with a boundary): a parcel, dam, point or
  line with any vertex outside the catchment boundary (a hole in it counts as
  outside). A vertex within `OUTSIDE_TOLERANCE_M` (10 m) of the boundary's
  line counts as on it. The warning says how many of the feature's points are
  out.
- **Overlapping parcels**: two farm parcels whose interiors overlap, found
  without a geometry library: a vertex of one inside the other, two edges
  crossing, or a point just inside one edge's middle lying inside the other
  (which catches a parcel imported twice). Within `OVERLAP_TOLERANCE_M`
  (5 m) nothing counts, so shared edges, touching corners and rounding
  slivers don't.
- **Units against the boundary**: the units' areas (as the model has them)
  added up, against the boundary's server-computed area. Flagged when they
  differ by more than `UNITS_VS_BOUNDARY_TOLERANCE` (10 %), giving both:
  "The units add up to 184.0 km², 12 % less than the boundary's 210.2 km²"
  (the seeded Sandspruit example, whose boundary has a margin round its
  farms).
- **Typed area against the parcel**: a unit whose area was typed (not taken
  from the map) and differs from its linked parcel's area (the parcels'
  sum, if several) by more than `TYPED_VS_PARCEL_TOLERANCE` (10 %).
- **Gauges off the rivers** (only with river lines): a gauge further than
  `GAUGE_RIVER_DISTANCE_M` (100 m) from every river line, measured to the
  nearest point of any segment (great-circle distance), with how far it is.

Geometry is in metres on a local equirectangular projection around the
features (well under 1 % off over a catchment); people read haversine
distances and the server's areas.

## Results on the map (data)

Issue #326 A1 (decision D-A1) colours each parcel by one run's figures. This
section is the data layer, `frontend/src/lib/components/map/mapStatus.ts`
(pure, `mapStatus.test.ts`). **Not wired to the page yet:** the map's
colours, measure picker, legend and the table beside it are the next round
of #326, and nothing on the Map tab calls this module today.

- **No new route.** Every figure is in the run's summary, which
  `GET /projects/:id/runs/:runId` already returns (`api.runs.get`), with the
  run's model snapshot for the dams' capacities. No series is downloaded:
  the same summary feeds the Hydrological units page and the Network's
  colours. A parcel reaches its figure through `map_feature.node_id`.
- **Which run** (`chooseMapRun`, `mapRuns`): the current publication's run
  (`RunMeta.published`) for everyone by default. An editor or owner may pick
  any run (`from: 'picked'`), and sees their newest run when nothing is
  published; anyone below editor gets the published run only, and nothing
  when nothing is published. This is a choice of view, not an access rule:
  viewers can already read every run on the Runs page. Farmers can't read
  runs at all (`403`); their farm map (A3, [§ The farmer's map](#the-farmers-map)) reads the farm view instead.
- **Measures** (`unitStatuses`), per hydrological unit and water user, each
  as `{ nodeId, measure, value, band, label }` with `band` one of `ok`,
  `watch`, `short` or `none` (no figure), and `label` the figure in words so
  a colour is never the only cue. The bands reuse the app's thresholds rather
  than new ones:
  - **Days short** (the default): demand days in the reporting window not
    fully met (`supplyAssurance.reliability`, as the Hydrological units
    cards count them), banded by the share of demand days met with the
    supply bands' thresholds (`supplyColour.ts`: 95 % and 70 %).
  - **Curtailment**: the cut the curtailment table asks of a unit
    (`curtailment.farms`, `totalChangeM3Day` below 0), banded by the share of
    demand left with the same thresholds; no cut is `ok`. Water users are not
    in that table, so they are `none`.
  - **Dam level**: the end-of-run level, banded exactly as the Network's
    **Colour by dam level** (`farmColour.ts` `damColouring`: 60 % full or
    more, 30–60 %, under 30 % or at its minimum), from `damLevelsFromSummary`
    or, for a run before engine 1.2.0, `loadDamLevels`.
  - **Use against allocation**: per water source, *above registered* when
    any whole water year was, else the engine's `allocationStatus` of the
    mean whole year with the run's tolerance (the Allocations page's rule,
    `allocations.ts` `unitRows`); a unit with both sources shows the worse.
    Above registered is `short`, use with no registered volume `watch`,
    within the band or below it `ok`. A run with no whole water year, or no
    allocations, is `none`.
- **Gauges and EWR sites** (`ewrStatuses`): met or missed over the reporting
  window from `curtailment.ewrSites` (outlet first, then gauges); a gauge
  that isn't a site in the run is `none`.
- **Colours** (`bandFills`): `Record<featureId, colour>` for CatchmentMap's
  fills, from the band's design token (`ok` `--success`, `watch`
  `--warning`, `short` `--danger`, `none` `--text-muted`, the schematic's and
  the node card's family), read from `<html>`'s computed style so it follows
  the app's theme at the time of the call. The caller must call it again on
  `watchAppTheme` and pass the new `fills`: CatchmentMap redraws a theme
  change with the `fills` it was given, so stale ones keep the old theme's
  colours. The boundary and rivers are never filled.

## The farmer's map

Issue #326 A3 (decision D-A1/A3): the farm view (`/farm/[projectId]`) shows
a small map of the farmer's **own** land (parcels) and dam, with the
boundary, rivers and gauges for orientation, from
`GET /projects/:id/farm/:nodeId/map` ([api.md § Farm](./api.md#farm)); never
a neighbour's parcel or status. Farmers can't read runs, so the land is
coloured by the farm view's own published band (the "Model: …" chip,
`FarmProjection.river.band`) with the same tokens as `mapStatus.ts`
`BAND_TOKEN` (`farm/farmMap.ts`, `farmMap.test.ts` keeps them one). The card
says everything in words first (the land with its area, the dam, the streams
and gauges by name, the place in degrees, and that no other unit is shown),
and is left out when the farm has nothing of its own on the map. The map
reuses `CatchmentMap.svelte` in a chunk of its own (`farm/FarmMapCanvas.svelte`),
passing its words in the reader's language (`words`, `farmMap.ts`
`mapWords`), since the shared component imports no catalogue. The screen is
in [ui.md § Farmer view](./ui.md#farmer-view-farm).

## Quaternary lookup

Settings → WR2012 check → **Propose from the map** looks up the quaternary
catchment that contains a point (the boundary's centre, a gauge, or typed
coordinates; `GET /projects/:id/map/quaternary`) and lists its reference
values (code, area, MAP, naturalised MAR, reference period, monthly means,
source) beside what the form holds, each with **Use**. A used value goes into
the form only; **Save** keeps it. The source shown is the dataset's own,
with the quaternary and the point appended. Nothing fills itself, and a
proposal from the synthetic dataset is marked "Synthetic test data … never
use them for a real catchment".

### Quaternary dataset

The lookup reads `quaternary_reference` (152), which the **operator** loads
as the schema owner; the app never writes it.

- **Committed: synthetic only.** `backend/fixtures/geo/quaternaries.synthetic.geojson`
  is six invented 0.25° cells in drainage region **Z** (DWS has none), codes
  `Z01A`–`Z02C`, with invented MAP, MAR and monthly means (the monthly means
  add up to the MAR, the MAR is below the rain on the area). Every source
  says "SYNTHETIC". `pnpm import:quaternaries` with no argument loads it
  (`pnpm setup` does), as dataset `synthetic`. The repo is public: no real
  quaternary values are committed.
- **Seeded example map.** `pnpm seed:examples` gives the Sandspruit example
  an invented map inside those cells (`backend/scripts/examples/map.ts`,
  recorded as the file `sandspruit-map.synthetic.geojson`): a boundary, a
  parcel and a dam per farm linked to its node, two gauges and four streams.
  Parcels are drawn to the model's areas, so the map proposes nothing new
  until someone edits it; `map.test.ts` holds the layout to the model.
- **Real data: the operator's own download.**
  1. Boundaries: the DWS quaternary catchments (open data; the DWS/WR2012
     GIS layers). Convert the shapefile to GeoJSON in WGS84:
     `ogr2ogr -t_srs EPSG:4326 -f GeoJSON quaternaries.geojson <file>.shp`.
     The loader reads the code from `code`, `QUATERNARY`, `QUATERN`,
     `Quaternary`, `QUAT` or `QCODE`.
  2. Values: the WR2012 tables (WRC; a free registered download),
     transcribed to a CSV keyed by code:
     `code,area_km2,map_mm,mar_mm3,oct,nov,dec,jan,feb,mar,apr,may,jun,jul,aug,sep,period_start,period_end`
     (monthly means in Mm³, October first; the period in water years). Or put
     the same values on each feature's properties (`areaKm2`, `mapMm`,
     `marMm3`, `monthlyMm3`, `periodStart`, `periodEnd`, `source`).
  3. `pnpm import:quaternaries quaternaries.geojson --dataset WR2012 --source "WR2012 (WRC 2015), <volume, table>" --values wr2012.csv`.
     A load replaces every row of its dataset in one transaction; features it
     can't take are listed as skipped. Without an area, the polygon's own is
     used.
- **Decision to check: WR2012's licence terms.** The WR2012 site requires a
  registration and its redistribution terms are not published (roadmap
  Step 4 D5). Until the WRC confirms them, the values are loaded only into
  the operator's database from their own download, never committed or
  shipped, and whether a client-facing deployment may show them is the
  operator's call. The DWS quaternary boundaries are open data.
- **Production loading** has no path yet: the database is in a private VPC
  and the loader runs as the schema owner from a workstation. A follow-up
  (followups.md) adds one (a migrate-Lambda-style one-off, or a job reading the
  operator's file from the private bucket).
