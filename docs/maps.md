# Catchment map

The **Map** tab (`?tab=map`, opened from the Network header's **Map** link,
not a sidebar row; not the Network's
schematic, whose card is also called "Catchment map") draws a
project's catchment boundary, farm parcels, dams, gauges and rivers over a
self-hosted basemap, and proposes values from them that the hydrologist
accepts one by one. Issue #288, phases 1–2 of roadmap
[WP-3.12](./roadmap/step-3-licensing.md#wp-312-catchment-map). This page
covers the tiles and labels, measuring, the GeoJSON download, uploads, areas, the quaternary lookup, outlines and dataset, the
nearest gauging stations, the dam proposals from the register of dams and the map, delineating a
catchment from the DEM, the sources table and the CSP. The screen is in [ui.md § Map](./ui.md#map-tabmap),
the API in [api.md § Catchment map](./api.md#catchment-map) and the tables in
[data-model.md § Catchment map](./data-model.md#catchment-map-152_catchment_mapsql).

Two rules hold throughout:

- **The map proposes, the modeller decides.** Nothing on the map changes the
  model by itself. A polygon's area enters a hydrological unit only through
  **Use … km²** and a confirmation (a model revision naming the feature); a
  quaternary's values enter the WR2012 check only through **Use**, value by
  value, and then **Save**; a dam's capacity (from the register of dams) or
  full-supply area (from its polygon) enters the model only through **Use**
  on the Dams page and a confirmation; a delineated catchment reaches the
  map only through **Accept** (and replaces a boundary only with a tick).
- **The map is never the only way.** Everything it shows is in the feature
  list and table beside it, every action works from there, points can be
  placed by typing coordinates, shapes made by pasting GeoJSON or WKT, and
  areas can still be typed on the Network.

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
  water, land use, roads and boundaries, and place and water names only when
  glyphs are configured ([§ Labels](#labels)); it uses no sprites.
  Attribution ("© Protomaps © OpenStreetMap contributors") stays visible
  whenever the basemap is drawn.
- **Locally**: `pnpm dev:tiles:up` (`bin/tiles-dev.sh up`) does it all and
  is safe to re-run: it starts MinIO, uploads the cached extract and fonts
  when MinIO doesn't serve them (its volume wiped, or a new MinIO), runs `fetch` only when nothing is cached, and sets both
  URLs (and the relief's, when its DEM is cached, [§ Relief](#relief)) in `frontend/.env.development.local` (`tiles-upload.ts --env`, every
  other line kept); restart `pnpm dev` after. `pnpm dev:tiles:fetch`
  (`bin/tiles-dev.sh fetch`) re-downloads. It needs the `pmtiles` CLI
  ([go-pmtiles](https://github.com/protomaps/go-pmtiles/releases), one static
  binary on `PATH`), extracts South Africa (`16.3,-35.0,33.0,-22.0`) from the
  Protomaps daily build at maxzoom 15 into
  `~/.cache/water-management-tiles/south-africa.pmtiles` (reading only that
  bbox's byte ranges), and uploads it to the MinIO bucket `tiles`, readable by
  anyone (MinIO is loopback-only), with `backend/scripts/tiles-upload.ts`.
  `pnpm dev:tiles:env` prints the URL
  (`http://localhost:9002/tiles/south-africa.pmtiles`) that `up` sets.
  `pnpm dev:tiles:status` says what is cached and served.
  `TILES_MAXZOOM`, `TILES_BBOX` and `TILES_BUILD` (a build date) override the
  defaults. **Maxzoom 15** (#326 D5, decision D7 revisited): placing a dam
  or tracing a parcel (drawing, below) needs a closer zoom than 13. Measured
  2026-10-01 with `pmtiles extract … --dry-run` (go-pmtiles 1.31.2, the
  Protomaps build of 2026-09-30, the bbox above), which reads only the
  archive's directories, not the tiles:

  | maxzoom | tiles | archive |
  | --- | --- | --- |
  | 13 | 130,243 | 250 MB |
  | 14 | 443,416 | 490 MB |
  | 15 | 1,408,748 | 1.0 GB |

  15 is under the ~2 GB the decision allowed, and is the Protomaps build's
  deepest zoom (MapLibre overzooms past it), so it is the default.
  `TILES_MAXZOOM=13` keeps a laptop's cache small.
- **Production**: not deployed yet. The plan (WP-3.12) is the same file in
  S3 under a `tiles/` prefix behind a same-origin CloudFront behaviour
  `/tiles/*` (Range and `ETag` forwarded, long cache), and
  `PUBLIC_TILES_URL=/tiles/south-africa.pmtiles` in the web release. Until
  then production shows the plain background. Tracked in
  [followups.md § Catchment map](./followups.md#catchment-map-issue-288).

### Labels

Place and water names (#326 A6) are drawn with **self-hosted glyphs**: the
PBF glyph ranges MapLibre reads (`{fontstack}/{range}.pbf`, 256 code points
a file), never a font CDN.

- **The fonts**: Noto Sans Regular, Medium and Italic as glyph ranges, from
  the Protomaps [basemaps-assets](https://github.com/protomaps/basemaps-assets)
  repository at a pinned commit (`028c18f7`, 2025-10-31; `bin/tiles-dev.sh`
  `FONTS_REF`), SIL Open Font License 1.1 ([§ Sources](#sources)). The
  licence file (`OFL.txt`) is uploaded beside them.
- `PUBLIC_TILES_GLYPHS_URL` (frontend env) is the URL template. **Empty**
  (the committed default in `frontend/.env.development` and
  `.env.production`): no labels and no glyph requests, the behaviour before
  A6, so a fresh clone and CI fetch nothing. A path starting `/` is made
  absolute on the page's origin (`glyphsUrl`), braces kept.
- **Locally**: `pnpm dev:tiles:fetch` fetches the fonts after the tiles;
  `pnpm dev:tiles:fonts` fetches only the fonts (no `pmtiles` CLI; about
  14 MB, 768 ranges). Both download the commit's archive once into
  `~/.cache/water-management-tiles/`, unpack the three fonts into `fonts/`,
  and upload them to the MinIO bucket `tiles` under `fonts/<fontstack>/<range>.pbf`
  (`backend/scripts/tiles-upload.ts --fonts`, which takes only files named
  as ranges, and the licence). `pnpm dev:tiles:env` prints
  `PUBLIC_TILES_GLYPHS_URL=http://localhost:9002/tiles/fonts/{fontstack}/{range}.pbf`.
- **Production** (not deployed yet, with the tiles): the same files in S3
  under `tiles/fonts/`, served by the same-origin `/tiles/*` behaviour, and
  `PUBLIC_TILES_GLYPHS_URL=/tiles/fonts/{fontstack}/{range}.pbf`. Tracked
  with the basemap's follow-up.
- **What is labelled** (`labelLayers`): towns, regions and suburbs from the
  Protomaps `places` layer (the name in English when the tiles carry one,
  else the local name; towns that show from far out in the medium weight),
  named rivers and streams along their lines from zoom 11, and named water
  bodies, in italic. Labels sit above every feature layer, so a results
  fill never hides a name, and go with the basemap when its tiles fail.
  With glyphs and the quaternary layer on, each quaternary's code is a
  label too (even with no tiles).
- **Contrast**: each label has a 1.5 px halo of the opposite lightness, and
  its text is at least 4.5:1 against the halo *and* against every basemap
  colour (background, land, water, land cover) in both themes
  (`labelColours`, `mapStyle.test.ts`).
- A glyph range that fails to load leaves those characters out; nothing else
  breaks.

### Relief

The **Relief** layer shades the land from a digital elevation model, so
valleys, ridges and drainage lines read on the map. It is visual only:
nothing the model uses comes from it. Delineation reads the same DEM on the
server ([§ Delineation](#delineation)).

- **The data**: [Mapterhorn](https://mapterhorn.com)'s planet build, a
  global PMTiles archive of Terrarium-encoded 512 px elevation tiles
  (WebP). Over South Africa its only source is **Copernicus GLO-30**, the
  30 m global DEM, to zoom 12 (about 16 m a pixel there with 512 px tiles,
  so zoom 12 is upsampled; zoom 11, about 33 m, is the DEM's own
  resolution); the archive's finer national sources are all elsewhere
  (checked 2026-10-01 against its `download_urls.json`: none of its zoom
  13+ files touches the bbox). Licence in [§ Sources](#sources).
- `PUBLIC_TERRAIN_URL` (frontend env) is the file's URL. **Empty** (the
  committed default in `frontend/.env.development` and `.env.production`):
  the Layers box offers no Relief toggle and no DEM is fetched, so a fresh
  clone and CI download nothing. Set, the box has a **Relief** checkbox,
  off by default, in the URL with the other layers (`layers=relief`).
- **The style** (`mapStyle.ts` `terrainSource`, `reliefLayer`): a
  `raster-dem` source read through the `pmtiles` protocol and a `hillshade`
  layer over the land and land cover, under the water, roads, quaternary
  outlines, features and names (`reliefBeforeId`), with no basemap, on the
  plain background. The shadows and highlights are translucent and the
  exaggeration low, so the land colours and the overlay's strokes keep
  their contrast. MapLibre overzooms past zoom 12. Turning the layer on or
  off changes the live map without reloading the style. A DEM that can't be
  read drops the relief and says so in the Layers box; the basemap and
  features stay. The relief is not a basemap layer, so the basemap failing
  leaves it drawn.
- **Attribution**: while the relief is drawn, the map's attribution carries
  "© Mapterhorn" and the notice the Copernicus licence requires for adapted
  data (Art. 6(b), word for word; `TERRAIN_ATTRIBUTION`, checked by
  `mapStyle.test.ts`).
- **Locally**: `pnpm dev:s3:up`, then `pnpm dev:tiles:terrain`
  (`bin/tiles-dev.sh terrain`, the same `pmtiles` CLI as the basemap). It
  extracts the basemap's bbox from the planet build into
  `~/.cache/water-management-tiles/terrain.pmtiles` and uploads it to the
  MinIO bucket `tiles` as `terrain.pmtiles`
  (`backend/scripts/tiles-upload.ts --terrain`). Then `pnpm dev:tiles:up`
  sets `PUBLIC_TERRAIN_URL=http://localhost:9002/tiles/terrain.pmtiles` in
  `frontend/.env.development.local` beside the basemap's URLs (`pnpm
  dev:tiles:env` prints it); restart `pnpm dev`. `up` re-uploads a cached
  DEM when MinIO doesn't serve it but never downloads one, and sets the URL
  only when MinIO serves it, so without it the Layers box offers no Relief toggle. `TERRAIN_MAXZOOM` and `TERRAIN_SOURCE` (the archive's
  URL) override the defaults. Measured 2026-10-01 with
  `pmtiles extract … --dry-run` (go-pmtiles 1.31.2, the planet build of
  Mapterhorn 0.0.13):

  | maxzoom | archive |
  | --- | --- |
  | 10 | 197 MB |
  | 11 | 570 MB |
  | 12 | 2.2 GB |

  12 is the default because it is the DEM's own resolution; a lower zoom
  is upsampled by MapLibre and looks softer up close. `TERRAIN_MAXZOOM=11`
  keeps a laptop's cache small.
- **Production** (not deployed yet, with the basemap): the same file in S3
  under `tiles/terrain.pmtiles`, served by the same-origin `/tiles/*`
  behaviour, and `PUBLIC_TERRAIN_URL=/tiles/terrain.pmtiles`. The
  Copernicus licence (Art. 6(c)) also asks for its liability sentence in a
  legal notice covering the distribution; that goes in before production
  serves the relief. Tracked with the basemap's follow-up.

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
  `pmtiles` chunk loads only with a tiles or terrain URL. The workspace's first load and
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
- Tiles and glyphs are fetched with `connect-src` (MapLibre `fetch`es glyph
  ranges; they are not CSS fonts, so `font-src` is not involved):
  same-origin in production (`/tiles/*`, `/tiles/fonts/*`), so
  `connect-src 'self'` holds and **the CSP is unchanged** by the labels.
  The relief's DEM is the same: one more PMTiles file under `/tiles/`,
  read with `fetch`, decoded in MapLibre's worker (no `blob:`, no
  `img-src` change).
  Locally there is no CSP header (only SvelteKit's meta policy, which sets
  `script-src`).
- The app loads **no third-party script, style, font or tile**: MapLibre is
  bundled, and the basemap and its glyphs are self-hosted.

## Drawing

Editors draw, place and reshape features on the map itself (issue #326 C1,
D1, D4; the screen is in [ui.md § Map](./ui.md#map-tabmap)). Nothing is sent
until a sheet's confirm, and every save goes through the same
`POST`/`PATCH /projects/:id/map/features` as before, so the server's checks
(`checkGeometry`: closed, non-crossing rings, the vertex limits, a kind's
geometry types) and the audit events are unchanged. Viewers get no tools.

- **What can be drawn** (`draw/shape.ts` `DRAW_CHOICES`): a polygon for a
  catchment boundary (it replaces the current one, and the save sheet says
  so), a farm parcel, a dam's water's edge or an "other" area; a line for a
  river or an "other" line; a point (Place a point) for a gauge, a dam or
  "other".
- **Pointer.** A click adds a corner; a click on the first corner (or
  **Finish**) closes a polygon, a second click on the last point (or a double
  click, or Finish) ends a line; a dashed line runs from the last corner to
  the pointer. Once drawn: drag a corner (or the point) to move it, click an
  edge's middle to add a corner, click a corner to pick it and press Delete
  (or **Remove the picked corner**) to remove it, never below three corners
  (two points for a line). **Undo** steps back through every change (a drag
  is one step; up to 200); **Cancel** drops the drawing at once. **Escape**
  does too while there is nothing to lose (one corner, a placed point, an
  edit not yet changed), but with two corners or more, a finished or pasted
  shape, or a changed edit it asks first (the app's confirmation dialog,
  "Discard this drawing?" / "Discard your changes?", **Keep drawing** first
  and taking the focus; `Draft.escape`), since a key can be a slip and a
  named button can't, the way a half-typed note asks before its sheet
  closes. While
  drawing, clicks shape the drawing rather than picking what is under them,
  and point markers let clicks through.
- **Keyboard** (WCAG 2.1.1): from the map's focus (entering a drawing mode
  puts it there), a crosshair marks the map's middle; the arrow keys pan the
  map under it (MapLibre's own keyboard pan), **Enter** adds a corner there
  (places or moves the point), **Backspace** removes the last corner while
  drawing, **Delete** the picked one after, Escape cancels (asking first, as
  above; focus comes back to the map either way). With the mouse over the
  map (moved there since the map took the focus, the last arrow key and the
  last touch), **Enter** adds at the mouse pointer instead, where a click
  would, and the crosshair hides; an arrow key, the mouse leaving the map,
  the focus arriving (a Tab with the mouse resting there) or a touch (and
  the mouse events a browser makes up after a tap) brings the crosshair back
  (`draw/attachDrawing.ts`, tested in `attachDrawing.test.ts` and
  `e2e/tests/map-draw.spec.ts`). The canvas's
  accessible name says which keys do what in each phase, and the draw bar
  names the last change in a polite live region ("Corner 3 at 33.6100° S,
  21.3400° E.").
- **Paste a shape** (`draw/parseShape.ts`; WCAG 2.1.1, 2.5.7: the
  non-pointer way to make or replace a shape, and the way in for coordinates
  copied from QGIS or a survey): GeoJSON (a geometry, a Feature, or a
  FeatureCollection of one) or WKT (`POINT`, `LINESTRING`, `POLYGON`,
  `MULTILINESTRING`, `MULTIPOLYGON`, an optional `SRID=4326;`), longitude
  first, WGS84. An outline left open is closed; 3D, another SRID or a named
  projected CRS, coordinates outside longitude/latitude ("looks projected"),
  several features and unsupported types are refused with a sentence. The
  pasted shape must be the shape being drawn (a line for River), replaces the
  drawing, and is framed; one of several parts (or with holes) is kept whole:
  it saves as it is but has no corners to drag.
- **Points (D1).** Click to place is the main way: the point is drawn as a
  draft, can be dragged (or clicked elsewhere to move it), and **Save…**
  opens the Place sheet with its position; the coordinates are behind
  **Enter coordinates** there, filled in from the click so a published
  position can be typed exactly. **Use my location** (on a phone: a coarse
  pointer or a window under 700 px, with `navigator.geolocation`) asks the
  browser only when tapped; the position becomes the draft point and goes
  nowhere else until the point is saved.
- **Editing a saved feature:** the picked card's **Edit the shape** (a
  single line, or a polygon of one ring) or **Move the point**; the feature
  is drawn as the draft and saved with **Save the shape** (`PATCH` with the
  geometry; the server recomputes its area). A unit whose area was taken from
  it keeps that area until **Use** is pressed again (the card then offers
  it, since the areas differ). Shapes of several parts or with holes are
  replaced by uploading or pasting, not reshaped.
- **Without WebGL** the draw bar leads with Paste a shape and Enter
  coordinates; both work with no map.
- **Why our own drawing mode, not a library.** Both candidates were
  measured on 2026-10-01 (esbuild, minified, gzip -9, MapLibre external):
  [Terra Draw](https://github.com/JamesLMilner/terra-draw) 1.35.0 with
  `terra-draw-maplibre-gl-adapter` 1.4.1 is MIT, actively maintained
  (MapLibre ≥ 4 peer, so 6.10 works), has undo, and no `eval`, but is
  **36 KB** gzipped with the modes this needs; `@mapbox/mapbox-gl-draw` 1.5.2
  is ISC and 18 KB plus its CSS, but is written for Mapbox GL (MapLibre needs
  class-name shims) and its keyboard support is Escape/Enter/Delete only.
  Neither lets keyboard placement add a corner to the shape being drawn
  (WCAG 2.1.1 needs that to share one drawing with the pointer), and both
  keep layers a theme switch's `setStyle` drops. The mode here
  (`draw/attachDrawing.ts` on MapLibre's own events, `draw/drawLayers.ts`
  for one `draft` GeoJSON source and its layers, re-added after every style
  load, `draw/draft.svelte.ts` for the state) is a few KB in the map's own
  chunk, adds no dependency, and needs no CSP change: no `blob:`, no
  `eval`, no new origin.

## Measure

**Measure** in the Map tab's header (#326 A7; anyone who can see the map)
puts the map in the drawing mode (`draw/attachDrawing.ts`) with a
`MeasureDraft` (`measure/measureDraft.svelte.ts`, a `Draft` that is never
saved): a click, or Enter at the keyboard crosshair, adds a point;
Backspace removes the last; a click on the first point (or **Close the
shape**, or a double click) closes it; once closed the points can be dragged,
added and removed as a drawing's. Escape ends it at once, without asking
(nothing is lost). The result is written in the measure bar's live region,
never only on the canvas, with the points by coordinates beside it:

- **Distance** while open: the path's length along its points, great-circle
  (haversine, mean Earth radius, as the checks measure), in m under 1 km,
  then km (2 decimals under 100 km).
- **Area** once closed, with the **perimeter**: on the WGS84 ellipsoid by
  the server's own method ([§ Areas](#areas), repeated in
  `measure/measure.ts` and pinned to the same reference squares), so a
  shape measured and the same shape saved give the same area; in ha under
  1 km², then km² with the hectares.

Nothing is sent to the server and nothing is kept: a measurement is not in
the URL and ends with the tab.

## Download GeoJSON

**Download GeoJSON** in the Map tab's header (#326 A7, data portability;
anyone who can see the map, with features) saves the project's features as
one RFC 7946 FeatureCollection (`mapExport.ts`): built in the browser from
the list the tab already loaded, **no route**. WGS84 longitude/latitude as
stored, no `crs` member. Each feature's properties are `name`, `kind` (the
API's: `catchment_boundary`, `farm_parcel`, `dam`, `gauge`, `river`,
`other`), `node` (the node it stands for, by name, or null) and `areaKm2` /
`areaHa` (the server's area of a polygon, null for points and lines);
nothing else (no ids, files, users or imported properties). The file is
`<project>-map-<day>.geojson` (`application/geo+json`). Uploaded again, the
review reads each row's kind from its `kind` property and its node from its
name.

## Uploads

`POST /projects/:id/map/import` (and its review,
`POST /projects/:id/map/import/preview`) takes a **GeoJSON** file's text; the server
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
  can't be imported twice into a project (409). Two identical imports at
  once both pass the duplicate check; the unique index `geo_source_sha_idx`
  stops the second, which gets the same 409, never a bare "already exists".
- **A file may mix kinds** (issue #326 D2). `POST …/map/import/preview`
  reads and checks the file as the import will, saves nothing, and proposes
  each feature's kind (`proposeKinds` in `geojson.ts`):
  - from a `kind`, `type` or `layer` property (the key's case ignored), when
    its value names a kind that fits the feature's geometry. Case,
    `_`/`-`/spaces and a plural `s` are ignored, with synonyms: boundary,
    catchment → catchment boundary; parcel, farm, field → farm parcel;
    reservoir → dam; gage, weir, station → gauge; stream → river. The
    property is read for this only, never kept;
  - else from the shape: a line is a river, a point a gauge, a polygon a
    farm parcel, and the largest polygon whose inside holds every other
    feature's centre the catchment boundary. A lone polygon is the boundary
    only while the project has none. A property that names no kind, or one
    the shape can't be, falls back to the shape with a note saying so.

  Each feature is also proposed the node of the same name (case-insensitive)
  of a kind it can stand for. The editor reviews every row (kind, name,
  Stands for) in the upload sheet, then `POST …/map/import` sends
  `features: [{ index, kind, name, nodeId }]` for every feature of the file.
  The server checks it all again: each kind fits its geometry, each node is
  the project's and of a kind the feature can stand for, and **a file holds
  at most one boundary**, which replaces the project's current one. Any
  problem refuses the whole file (422, per feature).
  **Replacing the boundary is never silent:** the preview names the
  project's current boundary (`currentBoundary`), and while a row is marked
  as the boundary and one exists, the review shows "Importing replaces the
  current catchment boundary “X”: it goes from the map." with a **Replace
  the current boundary** tick, off for every file, that Import waits for.
  The server holds the same line: a reviewed boundary row with a boundary
  in place and no `replaceBoundary: true` is refused (409) and nothing is
  imported. The import's audit
  event records the count of each kind (`kind: 'mixed'` when there are
  several).
- The one-kind import (`kind` instead of `features`, kept for API callers):
  every feature that kind; a **catchment boundary** file's polygons become
  one boundary (a MultiPolygon if several), replacing the project's current
  one without the flag: naming the whole file the boundary is the intent,
  and the seeding scripts and API callers rely on it (the app's upload sheet
  always sends `features`). A parcel, dam or gauge named like a node of a fitting kind is linked
  to it; the editor can change the link.

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

## Results on the map

Issue #326 A1 (decision D-A1) colours each parcel, and each dam polygon
through its node, by one run's figures. The data layer is
`frontend/src/lib/components/map/mapStatus.ts` (pure, `mapStatus.test.ts`);
the page's side is `mapResults.ts` (the `measure=` words, the legend's rows,
a feature's figure, the "no figure" fill for unlinked areas;
`mapResults.test.ts`), `mapResults.svelte.ts` (the run's record through the
Runs cache, its dam levels, the fills) and `MapKeyRow.svelte` (the pickers and
the legend). What the page shows is in [ui.md § Map](./ui.md#map-tabmap).

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
  colours. The boundary and rivers are never filled. The tab does: its band
  colours are derived from the theme it watches, so CatchmentMap's
  `setStyle` on a switch reads the new `fills`. Areas with no figure (not
  linked, or no status) get the `none` colour (`resultFills`), so a parcel's
  own green never reads as OK.
- **Contrast.** `RESULT_FILL_OPACITY` (0.75) is not held to 3:1 against the
  basemap: the fill isn't what marks the shape out. Every parcel keeps its
  cased outline (`ov-casing` under `ov-parcel-line`, ≥ 3:1 against the
  basemap, `mapStyle.test.ts`), and the fill's meaning is also in words (the
  legend, the card, Every feature's Result and Band), so WCAG 1.4.1 and
  1.4.11 rest on the outline and the words, not the fill.
- **Gauges' markers are not yet coloured** met or missed: the markers are
  CatchmentMap's DOM buttons, which don't read `fills`. The EWR is in the
  card, the table and the legend's count line meanwhile.

## In an evidence pack

The licensing evidence report prints a site locality map at the top of § 1
(report format `evidence-12`, issue #326 A5), and an evidence pack freezes it.
It is not this map: no basemap and no MapLibre, but one SVG the engine draws
from the map features (`packages/engine/src/geo/localityMap.ts`, a local
equirectangular projection about the features' centre), with a scale bar, a
north arrow, coordinate ticks, a legend and the features' date, so the PDF
renderer and `pnpm reproduce:pack` produce the same bytes and the pack's
manifest names their SHA-256. It reads the features when the report is built,
under the reader's RLS; `other` features aren't drawn, and another unit's
parcel or dam is drawn without its name. Any module that needs a plain
locality figure can import the same builder. Details:
[evidence-pack.md § The locality map](./evidence-pack.md#the-locality-map).

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

## Rain from the boundary

Issue #326 B-rain (WP-2.10 × WP-3.12): the catchment's CHIRPS rain feed set
up from the map's boundary in one action, averaging the rain over the
boundary itself rather than over a box around it.

- **Where.** Settings → Data feeds → **Use the catchment boundary**
  (`feeds/BoundaryRain.svelte`), for editors and owners. The Map tab shows one
  line, for editors, while a boundary exists and no CHIRPS feed reads it, or
  one read it before it was redrawn (`map/MapRainLink.svelte`); its link
  opens the proposal (`?tab=settings&rain=boundary#set-feeds`).
- **The proposal** (`GET /projects/:id/feeds/chirps/from-boundary`, editor):
  the boundary (name, area, when it was last changed), the CHIRPS v3 cells
  it covers with how much of them lies inside, the method ("area-weighted
  over N CHIRPS v3 cells (0.05°), each by the share of it inside the
  boundary"), the source, what Apply will do, and each cell (latitude,
  longitude, share inside, weight) in a table.
- **Apply** (`POST …/from-boundary`, owner, as every feed change): attaches a
  CHIRPS daily feed into the CHIRPS reference series (`rain_chirps_mm`), or
  gives the cells to a CHIRPS feed whose series holds no days yet. It names
  the boundary version it was shown (`updatedAt`), so a boundary redrawn in
  between is refused (409) instead of applied unseen. The feed's config keeps
  the boundary it came from (`config.boundary`: id, name, version, area),
  which only this route writes; the History says "Set up the CHIRPS feed …
  from the catchment boundary “…” (N cells)".
- **No splicing.** A feed's existing days were averaged over its old cells,
  so new cells never go to a feed whose series already holds a record (409),
  nor while a fetch for that feed is still out (409 `feed_fetching`): its
  answer was asked for with the old cells, so the save waits for it.
  The proposal then attaches a new feed into a separate series ("CHIRPS
  boundary") to compare beside the old one. Switch the old feed off once
  satisfied.
- **The weights** (`backend/src/feeds/boundaryCells.ts`, pure). Each 0.05°
  cell gets *share of the cell inside the boundary × cos(cell-centre
  latitude)*, the weighting `bboxCells` gives a box, so a rectangle gets
  exactly a box's cells and weights. Holes are subtracted and the parts of a
  MultiPolygon add up. The share is computed by **exact clipping**, not
  sampling: each ring is clipped to its row of cells, then to each cell
  (Sutherland–Hodgman; clipping to a convex cell is exact in area even for a
  concave ring), and the share is the clipped area over the cell's in degrees.
  Exact to floating point, and cheaper than a sampling grid fine enough to
  match it; the degree-space share and the ellipsoidal one differ by under
  1e-4 within a cell. A cell with under 0.1 % of its area inside is left out
  (its weight moves the mean by less than that share of one cell's rain).
- **Limits.** One feed reads at most 100 cells in 25 grid rows (the box's
  limits, now also the limit for listed cells), about 2,500 km² at South
  African latitudes; a larger boundary is refused with its cell count, and
  feeds for parts of it are attached by hand.
- **The engine is unchanged.** The cells only change which CHIRPS values the
  feed averages into its series; runs read the series as before.
- **Local-first.** With `FEED_SOURCE=fixtures` the synthetic CHIRPS and
  CHIRPS-GEFS files cover 21.0–25.4° E, 20.0–34.0° S (the invented 8 × 6 grid
  repeated around it, with no sea), so a feed over the seeded Sandspruit
  boundary fetches offline (`boundaryCells.test.ts`, `fromBoundary.db.test.ts`).

The rain feed's licence (CHIRPS) is in [§ Sources](#sources).

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

### Quaternary outlines

The Map tab's **Quaternary catchments** layer (#326 A6; `layers=quaternaries`
in the URL) draws the loaded `quaternary_reference` polygons around the
project as dashed outlines (`quaternaryColour`: purple, at least 3:1 on
the basemap and ΔE ≥ 40 from every feature stroke), under the features, and
lists their codes beside the map ([ui.md § Map](./ui.md#map-tabmap)).

- `GET /projects/:id/map/quaternaries?bbox=` (`backend/src/geo/quaternaryLayer.ts`,
  viewer; [api.md § Catchment map](./api.md#catchment-map)) returns the
  codes and outlines whose bounding box meets the bbox, by code, at most
  `QUATERNARY_LAYER_MAX` (100) with `truncated` past it, and refuses a
  bbox over `QUATERNARY_BBOX_MAX_DEG` (5°) a side: real outlines run to
  thousands of vertices. No MAP, MAR or monthly values: proposing those
  stays with the lookup.
- The tab asks for the features' bounds padded by half their size (at least
  0.1°) each way (`mapLayers.ts` `quaternaryBbox`), once per bbox, and draws
  nothing with no features.
- A code is a label on the map only with glyphs; without them the codes are
  in the list, and a click inside a quaternary on the map (where no feature
  is) or on its code in the list draws it heavier.
- The synthetic dataset's outlines say so in the list ("Synthetic test data,
  never real outlines.").

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

## Gauging stations

Settings → Data feeds → **Attach a feed** → source **DWS gauge flow** shows
**Nearest gauging stations** above the station field (issue #326 Part B,
"B-gauge"; `NearestGauges.svelte`, `GET /projects/:id/map/stations`): the
river gauges within 50 km of the catchment's outlet, nearest first, at most
ten, each with its code and name, river, distance, record (first and last
year, and the years it spans; an open record runs to today) and its source.
**Use** fills the station field and moves focus to it; nothing else happens
until the owner presses **Attach feed**, so a station is chosen one at a
time, by a person, with its source in view. The feed records the station
code, which names its source.

- **Where it measures from.** The point is chosen by one rule
  (`backend/src/geo/stations.ts` `outletPoint`), and the panel says which
  applied:
  1. the map gauge linked to the model's **outflow gauge** (the node that
     drains into nothing);
  2. else the **centre** (area centroid) of the catchment boundary. The map
     has no elevations, so its lowest point can't be told; placing the
     outflow gauge on the map (Map tab) makes the proposal measure from the
     outlet itself;
  3. else nothing: the panel asks for the boundary or the outflow gauge on
     the map. The API also takes a point (`?lon=&lat=`) and a radius
     (`?within=`, up to 200 km).
- **Distance** is the great-circle distance on a sphere (haversine, mean
  Earth radius 6 371 km): within about 0.5 % of the ellipsoid, plenty to rank
  stations. A bounding box around the point narrows the table first (an
  index on lat, lon); no PostGIS.
- **River gauges only.** DWS codes carry the station type in their third
  character (`A2H012`: H a river gauge, R a reservoir). The DWS feed reads
  river gauges only (feeds/config.ts `DWS_RIVER_GAUGE`), so reservoirs and
  other types in the list are never proposed.
- **Who sees it.** A viewer's read (the outlet comes from the project's map);
  a farmer gets 403 and a non-member 404. The form itself is the owner's.

### Gauging-station dataset

The proposal reads `gauge_station_reference` (156), which the **operator**
loads as the schema owner; the app never writes it.

- **Committed: synthetic only.** `backend/fixtures/geo/gauge-stations.synthetic.geojson`
  holds six invented stations in drainage region **Z** (DWS has none),
  codes `Z1H001`–`Z1H005` and a reservoir `Z1R001`, round the seeded
  Sandspruit map's outlet (21.31° E, 33.79° S): four river gauges within
  20 km, one about 40 km off. Every source says "SYNTHETIC".
  `pnpm import:gauge-stations` with no argument loads it (`pnpm setup` does),
  as dataset `synthetic`, and the panel marks it **Sample stations**.
- **Real data: the operator's own download, once its licence allows it**
  (see Sources: blocked today). The DWS station catalogue
  (Hydrological Services → Verified data → Station catalogue) lists each
  station's code, place, river, latitude, longitude, catchment area and the
  dates its record spans. Transcribed to a CSV
  (`code,name,river,lat,lon,catchment_km2,record_start,record_end`, any
  column order, decimal degrees, dates `YYYY-MM-DD`) or a GeoJSON
  FeatureCollection of points (`code`/`station`, `name`, `river`,
  `catchmentKm2`, `recordStart`, `recordEnd`, `source`), it loads with
  `pnpm import:gauge-stations stations.csv --dataset "DWS 2026-10" --source "DWS Hydrological Services station catalogue, <URL>, downloaded <date>"`.
  Several files load as one dataset; a load replaces every row of its
  dataset in one transaction, and stations it can't take are listed as
  skipped. Never commit the real file.
- **Production loading** has the quaternary dataset's gap: no path yet into
  the private database (followups.md).

## Dams from the register and the map

Dams → **Proposed from the register and the map** (issue #326 Part B,
"B-dams"; the box under the dam cards, [ui.md § Dams](./ui.md#dams))
proposes two values for a hydrological unit's dam, each with its source,
from the dam on the map linked to that unit (a polygon first, else a point;
the earliest when there are several):

- **Capacity, from the register of dams.** The registered dams within
  **1 km** of the dam's place on the map (a polygon's centroid, or the
  point), nearest first, at most five, each with its register number,
  distance, capacity, wall height, completion year, river and farm, and
  the dataset's source line. Matching is by great-circle distance only:
  names on the register rarely match a farm's dam name. The wall height
  and completion year are shown for reference; the model has no field for
  them.
- **Full-supply area, from the dam polygon** (followups.md "Dam polygons →
  the area–volume curve", first half): the polygon's geodesic area
  (`map_feature.area_m2`, [§ Areas](#areas)) as the dam's area when full
  (`damAreaFullM2`), which the run uses for evaporation instead of the
  capacity ÷ 3 m estimate. A point has no area to propose.

**Use** asks first, then saves that one value to the model straight away
(`POST …/dam-capacity-from-register` with the register number, or
`POST …/dam-area-from-map` with the feature; [api.md § Catchment
map](./api.md#catchment-map)), as a model revision whose reason names the
source ("Dam capacity of Upper farm from the register of dams: Bo-dam
(Z100/07, 140000 m³, 250 m from “Upper dam”; SYNTHETIC …)", "Dam full-supply
area of Upper farm from the map: “Upper dam” (39012 m², computed from its
polygon)"), so History and the run comparison show where it came from. The
server re-derives each value: a register number that isn't within 1 km of
this unit's dam, a dam point, a dam linked to another unit, or a unit with
no dam capacity (for the area) is refused. While the model has unsaved
changes, Use waits. Viewers see the proposals but not Use.

### The register of dams

`dam_register_reference` (157) is global reference data, like the quaternary
dataset: the **operator** loads it as the schema owner and the app only
reads it.

- **Committed: synthetic only.** `backend/fixtures/geo/dam-register.synthetic.json`
  is eight invented dams with register numbers in region **Z**
  (`Z100/01`–`Z100/08`), most within a few hundred metres of the seeded
  Sandspruit dams (Bosrand's 1.5 km off, so never proposed) and one beside
  the e2e and DB tests' dam. Every source says "SYNTHETIC".
  `pnpm import:dam-register` with no argument loads it (`pnpm setup` does),
  as dataset `synthetic`, and every proposal from it carries a "Synthetic
  test data" warning.
- **Real data: the operator's own download, once the licence allows it**
  (§ Sources: blocked today). The list (XLS) has the capacities in
  thousands of m³ but no coordinates; the Google Earth overlay (KMZ) has the
  positions. Save the list as CSV, unzip the KMZ to its `doc.kml`, and
  `pnpm import:dam-register list.csv doc.kml --dataset DSO-2025-07 --source "DWS Dam Safety Office, List of Registered Dams, July 2025"`.
  The loader joins them by register number ("No of dam" / `No_of_dam`),
  converts the capacity to m³, takes a year from "Completion date", and
  lists every dam it skipped (no position, no name). A load replaces every
  row of its dataset in one transaction. Production loading has the same
  missing path as the quaternaries (followups.md).

## Delineation

**Delineate** in the Map's header (editors, only when the server has a DEM;
issue #326 B-delineate, #342 map item 4) proposes the catchment that drains
to a point on a river. The design, the method and its accuracy are in
[design/delineation.md](./design/delineation.md); the screen in
[ui.md § Map](./ui.md#map-tabmap), the API in
[api.md § Delineation](./api.md#delineation).

- **Where you click.** The river at the catchment's outlet, or just below a
  dam wall (the draw bar's point; or **Enter coordinates**). The server
  moves the point to the most-drained cell within about 150 m, and says how
  far it moved.
- **What it does.** On the API, never in the engine: reads the DEM around
  the point (a 1 024-cell window, about 34 km, grown to 2 048 and 3 072
  cells while the catchment reaches its edge), fills depressions
  (Priority-Flood+ε), routes flow with D8, collects every cell upstream of
  the outlet and outlines them as one polygon, simplified to about a cell.
  A catchment still at the edge of the largest window, or reaching the edge
  of the DEM's data, is refused rather than cut off; so is a point outside
  the DEM or one almost nothing drains to.
- **The proposal** is drawn dashed in teal over the features, with its
  outlet, until it is decided; the sheet lists its area, the snap distance,
  the cells, the dataset (with its fingerprint) and the method, and the
  caveats. **Accept as the catchment boundary** (replacing the current one
  only with **Replace the current boundary** ticked; the server refuses
  otherwise), **Accept as an area** (an *other* polygon, e.g. a dam's
  upstream area, which can then be linked to a unit and Used), or
  **Reject**. A new point replaces an open proposal. Every proposal is kept
  with its decision (the last 50 superseded or rejected per project; the
  accepted ones all), and audited.
- **The DEM** (`DEM_URL`, backend env): empty (the committed default) turns
  delineation off; the Map shows no Delineate. Locally, after
  `pnpm dev:tiles:terrain` (§ Relief), put
  `DEM_URL=http://localhost:9002/tiles/terrain.pmtiles` in
  `backend/.env.development.local`; or
  `DEM_URL=fixtures/dem/synthetic-dem.pmtiles` (from `backend/`) for the
  committed synthetic DEM, invented terrain around 20.74° E, 33.54° S (the
  tests and e2e use it). Any PMTiles of Terrarium-encoded tiles works: WebP
  (lossless only) or PNG. `DEM_LABEL` names it on the proposals.
  Production: see followups.md "Production basemap".
- **Limits.** 30 delineations per project per hour (429 beyond); each takes
  one to a few seconds (measured on the real DEM: 0.5–4 s, up to about
  460 MB at the largest window) and stops before 20 s, under the API's
  30 s timeout.
- **Attribution.** A delineated polygon is adapted Copernicus data, so the
  sheet carries the licence's Art. 6(b) notice when the DEM is the GLO-30
  one; the accepted feature's description names the dataset.

## Sources

Every dataset or asset the map serves or loads, with its licence, checked on
the publisher's own page (decision D-B in #326: commercial use allowed,
attribution fine; non-commercial or share-alike-on-output terms rejected).
Real data is the operator's own download; the repo commits synthetic
fixtures only.

| Dataset | Publisher | Licence (read) | Attribution | Version | Update cadence | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Basemap tiles (Protomaps vector schema of OpenStreetMap) | Protomaps; OpenStreetMap contributors | ODbL 1.0 for the data: commercial use allowed with attribution; share-alike applies to derived *databases*, not to a map drawn from them ([openstreetmap.org/copyright](https://www.openstreetmap.org/copyright), read 2026-10-01) | "© Protomaps © OpenStreetMap contributors", always visible on the map | the daily build fetched (`TILES_BUILD`) | daily builds; refreshed when the operator re-fetches | allowed (in use) |
| Relief DEM: Copernicus GLO-30, as Terrarium tiles ([Mapterhorn](https://mapterhorn.com) planet build) | Copernicus DEM: DLR e.V. and Airbus Defence and Space, provided under COPERNICUS by the European Union and ESA; tiles compiled by Mapterhorn ([attribution](https://mapterhorn.com/attribution), code BSD-3) | The Copernicus WorldDEM-30 licence: free of charge, worldwide, with the rights of reproduction, distribution, communication to the public and adaptation (Art. 4), no restriction on commercial use ([License COPDEM 30](https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/DEM/resources/license/License-COPDEM-30.pdf), read 2026-10-01) | "produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved" (Art. 6(b)), on the map while the relief is drawn, with "© Mapterhorn"; the liability sentence (Art. 6(c)) in a legal notice before production serves it | Mapterhorn 0.0.13 (GLO-30 accessed 2025) | when Mapterhorn rebuilds; refreshed when the operator re-fetches | allowed (in use locally) |
| Delineation DEM: the Relief DEM above (Copernicus GLO-30, Mapterhorn's Terrarium tiles), read by the API | as above | as above: Art. 4 allows adaptation, which deriving flow directions and catchment polygons is | the Art. 6(b) notice on the delineation sheet; the dataset label and fingerprint on every proposal | as above | as above | allowed (in use locally; production with the basemap) |
| HydroSHEDS v1 flow direction (3″, conditioned from SRTM), considered for delineation, not used | WWF / McGill University ([hydrosheds.org](https://www.hydrosheds.org/products/hydrosheds)) | "freely available for scientific, educational and commercial use" under the HydroSHEDS licence agreement in its technical documentation (product page read 2026-10-01; the site's own terms of use are non-commercial but cover the website) | per its licence agreement | v1 | none | not used: passes D-B, but 90 m against GLO-30's 30 m and a second download (design/delineation.md § The DEM) |
| MERIT Hydro, considered for delineation | University of Tokyo ([MERIT Hydro](https://global-hydrodynamics.github.io/MERIT_Hydro/)) | dual: CC BY-NC 4.0 (non-commercial) or ODbL 1.0, under which data derived from it in a commercial product must be released under the ODbL (read 2026-10-01) | – | – | – | rejected: non-commercial, or share-alike on our output (D-B) |
| Synthetic DEM fixture (`backend/fixtures/dem/synthetic-dem.pmtiles`) | this repo (invented terrain, `pnpm -C backend gen:dem-fixture`) | the repo's own | none | 1 | when the generator changes | in use (tests, e2e) |
| Label glyphs: Noto Sans Regular, Medium, Italic (PBF glyph ranges) | The Noto Project Authors; packaged by Protomaps ([basemaps-assets](https://github.com/protomaps/basemaps-assets), `fonts/OFL.txt`) | SIL Open Font License 1.1: use, embedding and redistribution with software allowed, commercially too; the fonts may not be sold on their own, and copies keep the OFL and its notice ([openfontlicense.org](https://openfontlicense.org/open-font-license-official-text/), read 2026-10-01) | the OFL notice, uploaded beside the glyphs (`tiles/fonts/OFL.txt`) | basemaps-assets commit `028c18f7` (2025-10-31) | when the pin is moved | allowed (in use) |
| Quaternary catchment outlines | DWS (Department of Water and Sanitation) | open data per [§ Quaternary dataset](#quaternary-dataset); the commercial-use terms are not yet confirmed on DWS's own page | DWS | the operator's download | per DWS release | blocked: licence unconfirmed for anything but the operator's own database; the committed synthetic fixture is used everywhere else |
| WR2012 reference values (MAP, MAR, monthly flows) | WRC | redistribution terms unpublished ([§ Quaternary dataset](#quaternary-dataset)) | WR2012 (WRC 2015) | the operator's download | none (a 2012 study) | blocked: licence unconfirmed; operator's own database only |
| Hydrological station catalogue (station code, name, river, lat/lon, catchment area, record start/end): the nearest-gauge proposal | Department of Water and Sanitation (DWS), National Hydrological Services, `https://www.dws.gov.za/Hydrology/Verified/HyCatalogue.aspx` | **Unconfirmed.** Read 2026-10-01: the Verified data pages answer HTTP 403 outside South Africa, so no terms could be read from the publisher's own page. A web search (2026-10-01) surfaced DWS's information-page wording (NIWIS pages on `dws.gov.za`): "copyright … remains with the Department of Water and Sanitation", data "may not be sold to third parties", and "the use of information data is restricted to use for academic, research or personal purposes". If that wording covers the hydrological catalogue, it is a non-commercial restriction and fails D-B | "Department of Water and Sanitation" named as the copyright owner, if allowed | the operator's download date | DWS updates the catalogue as stations open and close | **Blocked: licence unconfirmed.** Built and tested against the synthetic fixture only. To unblock: written confirmation from DWS Hydrological Services that the station metadata may be reused in a commercial service, recorded here with the date |
| DWS verified daily flow (the DWS feed, `feeds/sources/dws.ts`) | DWS, `HyData.aspx` | Same pages, same open question (deployment.md § Sources' terms; followups.md, Terms of use) | as above | per fetch | daily | Built before D-B; its terms are the same open decision, tracked in followups.md |
| CHIRPS v3 daily rainfall (`sat`, `rnl`) and CHIRPS-GEFS v3 forecast: the rain feed, and the rain from the boundary | Climate Hazards Center, UC Santa Barbara | Public domain, registered with Creative Commons, and licensed CC BY 4.0 ("CHIRPS3 is in the public domain … licensed under a Creative Commons Attribution 4.0 International License"), [chc.ucsb.edu/data/chirps3](https://www.chc.ucsb.edu/data/chirps3), read 2026-10-01 | "Climate Hazards Center Infrared Precipitation with Stations version 3 (CHIRPS3) Data Repository: https://doi.org/10.15780/G2JQ0P (2025). Data was accessed on [date]." Or Funk, C. et al., *Sci Data* 13, 718 (2026) | v3.0 | Daily: preliminary two days after each pentad, final monthly (about three weeks after the month); GEFS one issue a day | Allowed (fetched live by the feeds; fixtures offline) |
| List of Registered Dams (the register of dams) | DWS Dam Safety Office ([publications page](https://www.dws.gov.za/DSO/Publications.aspx)) | None stated on the page or in its "Explanation and Legend for List of Registered Dams" PDF (read 2026-10-01). DWS's data terms elsewhere (the NIWIS pages): copyright stays with DWS, data "may not be sold to third parties", use "restricted to use for academic, research or personal purposes" | "Department of Water and Sanitation" as the copyright proprietor (the NIWIS terms) | July 2025 (XLS, no coordinates) and October 2024 (XLS) | A few times a year, irregular | **Blocked: licence unconfirmed** (and DWS's general data terms are non-commercial). Built against the synthetic fixture; ask DWS for written permission before a client deployment loads it |
| Google Earth Overlay for Registered Category 1, 2 and 3 Dams (the register's positions) | DWS Dam Safety Office (same page) | As above: none stated | As above | October 2024 (KMZ) | With the list, irregular | **Blocked: licence unconfirmed**, as above |
