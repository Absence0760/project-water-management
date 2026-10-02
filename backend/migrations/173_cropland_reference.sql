-- 173_cropland_reference — the cropland grid the catchment map summarises a
-- parcel's, a unit's or the catchment's cultivated area from (issue #326
-- Part B, "B-landcover"; docs/maps.md § Cultivated area from land cover,
-- docs/data-model.md § Catchment map).
--
-- In this file:
--  * cropland_dataset: one row per loaded land-cover product: its label,
--    source line, version, the counting method in words, the attribution the
--    licence asks for, the grid's cell size and the classes counted as
--    cultivated. Proposals quote it, so an accepted value (and through its
--    model revision, an evidence pack) names the product, version and method.
--  * cropland_cell_reference: per dataset, the grid cells with any cropland
--    and the share of each that is cropland (0–1). Pre-summarised by the
--    operator from the 10 m raster with `pnpm import:land-cover` (never by
--    the app, which reads no raster): about 250 m cells instead of billions
--    of pixels. Cell (row_idx, col_idx) is the square with south-west corner
--    (col_idx × cell_deg, row_idx × cell_deg). A cell that isn't listed has
--    no cropland.
--  * Global, not per project, like quaternary_reference (152): any signed-in
--    user reads them; water_app never writes them. The repo ships only an
--    invented grid (dataset 'synthetic'); the real ESA WorldCover tiles are
--    the operator's own download (docs/maps.md § Sources).
--  * No PostGIS: a polygon's cells are a range on the primary key here, and
--    the clipping is in the backend (geo/gridShares.ts).

CREATE TABLE cropland_dataset (
	-- 'synthetic' (the repo's invented fixture) or the operator's label ('WorldCover-2021-v200').
	dataset     text PRIMARY KEY CHECK (char_length(dataset) BETWEEN 1 AND 50),
	source      text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 500),
	version     text NOT NULL CHECK (char_length(version) BETWEEN 1 AND 100),
	method      text NOT NULL CHECK (char_length(method) BETWEEN 1 AND 1000),
	attribution text NOT NULL CHECK (char_length(attribution) BETWEEN 1 AND 500),
	cell_deg    double precision NOT NULL CHECK (cell_deg > 0 AND cell_deg <= 1),
	-- The product's class codes counted as cultivated (WorldCover: 40, Cropland).
	classes     integer[] NOT NULL CHECK (cardinality(classes) BETWEEN 1 AND 50),
	loaded_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cropland_cell_reference (
	dataset  text NOT NULL REFERENCES cropland_dataset(dataset) ON DELETE CASCADE,
	row_idx  integer NOT NULL,
	col_idx  integer NOT NULL,
	fraction real NOT NULL CHECK (fraction > 0 AND fraction <= 1),
	-- Also the covering index of the dataset key, and a polygon's lookup: one dataset, a range of rows, a range of columns.
	PRIMARY KEY (dataset, row_idx, col_idx)
);

COMMENT ON TABLE cropland_dataset IS
	'Land-cover products loaded for the cultivated-area proposals (173, issue #326 B-landcover): source, version, method, attribution, grid. Loaded by the operator (pnpm import:land-cover), read-only to the app. The repo ships a synthetic grid only.';
COMMENT ON TABLE cropland_cell_reference IS
	'Per dataset, the grid cells with cropland and the share of each that is (0-1), pre-summarised from the raster at import (173). A cell not listed has none.';

ALTER TABLE cropland_dataset ENABLE ROW LEVEL SECURITY;
ALTER TABLE cropland_cell_reference ENABLE ROW LEVEL SECURITY;
-- Public reference data: anyone signed in reads it; the app never writes it.
CREATE POLICY cropland_dataset_select ON cropland_dataset FOR SELECT USING (app_current_user_id() IS NOT NULL);
CREATE POLICY cropland_cell_reference_select ON cropland_cell_reference FOR SELECT USING (app_current_user_id() IS NOT NULL);

GRANT SELECT ON cropland_dataset, cropland_cell_reference TO water_app;
