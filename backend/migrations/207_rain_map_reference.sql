-- 207_rain_map_reference — the mean annual precipitation (MAP) grids the
-- catchment map shows as a layer of labelled grid points (docs/maps.md § MAP
-- grid, docs/data-model.md § Catchment map).
--
-- In this file:
--  * rain_map_dataset: one row per loaded MAP grid: its label, the source
--    line, version, the attribution its licence asks for, and its grid
--    (cell size and the origin of the cells' south-west corners). A provincial
--    surface at about 100 m and a national one at 1 arc minute (~1.7 km) are
--    two datasets, each read on its own; the map never mixes two in a view.
--  * rain_map_cell_reference: per dataset, the grid cells with a value and
--    their MAP, mm/yr. Cell (row_idx, col_idx) is the square with south-west
--    corner (origin_lon + col_idx × cell_deg, origin_lat + row_idx × cell_deg),
--    as evaporation_cell_reference (180). A cell that isn't listed has no
--    value (sea, outside the surface, or outside the loaded box).
--  * Loaded by the operator with `pnpm import:map-grid` from an ESRI ASCII
--    grid any GIS writes (the app reads no raster); a load replaces its
--    dataset. Global, not per project, like the other reference grids: any
--    signed-in user reads them; water_app never writes them. The repo ships
--    only an invented grid (dataset 'synthetic').
--  * Production loads are refused until the grids' licences are confirmed
--    (geo/referenceLoad.ts, docs/maps.md § Sources).

CREATE TABLE rain_map_dataset (
	-- 'synthetic' (the repo's invented fixture) or the operator's label ('Lynch-2004').
	dataset      text PRIMARY KEY CHECK (char_length(dataset) BETWEEN 1 AND 50),
	source       text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 500),
	version      text NOT NULL CHECK (char_length(version) BETWEEN 1 AND 100),
	attribution  text NOT NULL CHECK (char_length(attribution) BETWEEN 1 AND 500),
	cell_deg     double precision NOT NULL CHECK (cell_deg > 0 AND cell_deg <= 1),
	origin_lon   double precision NOT NULL CHECK (origin_lon >= 0 AND origin_lon < cell_deg),
	origin_lat   double precision NOT NULL CHECK (origin_lat >= 0 AND origin_lat < cell_deg),
	-- How many cells the load wrote: the layer lists it with each grid, and counting a 100 m grid's millions of rows on every request would be a scan.
	cell_count   integer NOT NULL CHECK (cell_count > 0),
	loaded_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rain_map_cell_reference (
	dataset  text NOT NULL REFERENCES rain_map_dataset(dataset) ON DELETE CASCADE,
	row_idx  integer NOT NULL,
	col_idx  integer NOT NULL,
	-- Mean annual precipitation, mm/yr (South Africa's wettest point is about 3 200).
	map_mm   real NOT NULL CHECK (map_mm >= 0 AND map_mm <= 20000),
	-- Also the covering index of the dataset key, and a view's lookup: one dataset, a range of rows, a range of columns.
	PRIMARY KEY (dataset, row_idx, col_idx)
);

COMMENT ON TABLE rain_map_dataset IS
	'Mean annual precipitation grids loaded for the Map tab''s MAP grid layer (207): source, version, attribution, grid. Loaded by the operator (pnpm import:map-grid), read-only to the app. The repo ships a synthetic grid only.';
COMMENT ON TABLE rain_map_cell_reference IS
	'Per dataset, the grid cells with a value and their mean annual precipitation, mm/yr (207). A cell not listed has none.';

ALTER TABLE rain_map_dataset ENABLE ROW LEVEL SECURITY;
ALTER TABLE rain_map_cell_reference ENABLE ROW LEVEL SECURITY;
-- Public reference data: anyone signed in reads it; the app never writes it.
CREATE POLICY rain_map_dataset_select ON rain_map_dataset FOR SELECT USING (app_current_user_id() IS NOT NULL);
CREATE POLICY rain_map_cell_reference_select ON rain_map_cell_reference FOR SELECT USING (app_current_user_id() IS NOT NULL);

GRANT SELECT ON rain_map_dataset, rain_map_cell_reference TO water_app;
