-- 259_crop_type_reference — the orchard and vine grid the planted-areas
-- drawer proposes crop areas from, beside the land-cover cropland grid
-- (issue #604 R5-D; docs/maps.md § Orchards and vines from SANLC,
-- docs/data-model.md § Catchment map).
--
-- In this file:
--  * crop_type_dataset: one row per loaded crop-type product (South African
--    National Land Cover, SANLC): its label, source line, version, the
--    earlier edition new plantings are counted against (null when loaded
--    without one), the counting method in words, the attribution, the grid's
--    cell size, and the class codes counted as orchards and as vines.
--    Proposals quote it, as cropland_dataset's are quoted (173).
--  * crop_type_cell_reference: per dataset, the grid cells with any orchard
--    or vine, and per cell the share that is orchard, the share that is vine,
--    and the shares that are orchard or vine now but were neither in the
--    earlier edition (new plantings). Pre-summarised by the operator from the
--    raster with `pnpm import:crop-types` (geo/loadCropTypes.ts), never by
--    the app. Cell (row_idx, col_idx) is the square with south-west corner
--    (col_idx × cell_deg, row_idx × cell_deg); an unlisted cell has neither.
--  * Global, not per project, like cropland_dataset (173): any signed-in user
--    reads them; water_app never writes them. The repo ships only an invented
--    grid (dataset 'synthetic'). SANLC's terms are not yet recorded, so a
--    production load is refused (geo/referenceLoad.ts, kind 'crop-types';
--    docs/maps.md § Sources): production holds no rows until they are.
--  * crop_area_land_cover (174) gains `layer`: which crop-type layer an
--    accepted planted area came from ('orchard' or 'vine'), null for the land
--    cover's cultivated area, so the drawer's provenance line says which. A
--    nullable column with a CHECK: every existing row is the land cover's and
--    stays valid; the table's policies, trigger and grant already cover it.
--  * No function, no trigger. The cells' foreign key is the leading column
--    of their primary key, which covers it.

CREATE TABLE crop_type_dataset (
	-- 'synthetic' (the repo's invented fixture) or the operator's label ('SANLC-2022').
	dataset          text PRIMARY KEY CHECK (char_length(dataset) BETWEEN 1 AND 50),
	source           text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 500),
	version          text NOT NULL CHECK (char_length(version) BETWEEN 1 AND 100),
	-- The earlier edition new plantings are counted against ('2018'); null: loaded without one, so no new plantings.
	baseline_version text CHECK (baseline_version IS NULL OR char_length(baseline_version) BETWEEN 1 AND 100),
	method           text NOT NULL CHECK (char_length(method) BETWEEN 1 AND 1000),
	attribution      text NOT NULL CHECK (char_length(attribution) BETWEEN 1 AND 500),
	cell_deg         double precision NOT NULL CHECK (cell_deg > 0 AND cell_deg <= 1),
	-- The product's class codes for each (SANLC: 32 permanent orchards, 33 permanent vines).
	orchard_classes  integer[] NOT NULL CHECK (cardinality(orchard_classes) BETWEEN 1 AND 50),
	vine_classes     integer[] NOT NULL CHECK (cardinality(vine_classes) BETWEEN 1 AND 50),
	loaded_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE crop_type_cell_reference (
	dataset     text NOT NULL REFERENCES crop_type_dataset(dataset) ON DELETE CASCADE,
	row_idx     integer NOT NULL,
	col_idx     integer NOT NULL,
	orchard     real NOT NULL CHECK (orchard >= 0 AND orchard <= 1),
	vine        real NOT NULL CHECK (vine >= 0 AND vine <= 1),
	-- Orchard (vine) now that was neither orchard nor vine in the earlier edition; 0 without one.
	new_orchard real NOT NULL DEFAULT 0 CHECK (new_orchard >= 0 AND new_orchard <= orchard),
	new_vine    real NOT NULL DEFAULT 0 CHECK (new_vine >= 0 AND new_vine <= vine),
	CHECK (orchard + vine > 0 AND orchard + vine <= 1.000001),
	-- Also the covering index of the dataset key, and a polygon's lookup: one dataset, a range of rows, a range of columns.
	PRIMARY KEY (dataset, row_idx, col_idx)
);

COMMENT ON TABLE crop_type_dataset IS
	'Crop-type products (SANLC) loaded for the orchard and vine proposals (259, issue #604 R5-D): source, version, baseline edition, method, attribution, grid, classes. Loaded by the operator (pnpm import:crop-types), read-only to the app. The repo ships a synthetic grid only; production loads are refused until SANLC''s terms are recorded.';
COMMENT ON TABLE crop_type_cell_reference IS
	'Per dataset, the grid cells with orchards or vines: the share of each that is orchard, vine, and orchard or vine new since the baseline edition (0-1), pre-summarised from the raster at import (259). A cell not listed has none.';

ALTER TABLE crop_type_dataset ENABLE ROW LEVEL SECURITY;
ALTER TABLE crop_type_cell_reference ENABLE ROW LEVEL SECURITY;
-- Public reference data: anyone signed in reads it; the app never writes it.
CREATE POLICY crop_type_dataset_select ON crop_type_dataset FOR SELECT USING (app_current_user_id() IS NOT NULL);
CREATE POLICY crop_type_cell_reference_select ON crop_type_cell_reference FOR SELECT USING (app_current_user_id() IS NOT NULL);

GRANT SELECT ON crop_type_dataset, crop_type_cell_reference TO water_app;

ALTER TABLE crop_area_land_cover ADD COLUMN layer text CHECK (layer IS NULL OR layer IN ('orchard', 'vine'));
COMMENT ON COLUMN crop_area_land_cover.layer IS
	'The crop-type layer an accepted area came from (259): orchard or vine; null for the land cover''s cultivated area.';
