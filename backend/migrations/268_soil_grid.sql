-- 268_soil_grid — the soil water capacity grid the regional GR4J prior reads
-- (issue #622 step 2; docs/maps.md § Soil water capacity, docs/model.md
-- §2.10m, docs/data-model.md § Catchment map).
--
-- In this file:
--  * soil_dataset: one row per loaded soil water capacity grid: its label,
--    the source line, version, the method in words, the attribution its
--    licences ask for (SoilGrids 2.0 and iSDAsoil, both CC BY 4.0,
--    docs/data-sources.md § soilgrids and § isdasoil), and its grid.
--  * soil_cell_reference: per dataset, the grid cells with a value and their
--    root-zone plant-available water capacity, mm:
--        PAWC = Σ over SoilGrids' six layers to 200 cm (wv0033 − wv1500) ×
--               the layer's thickness inside the root zone,
--    the root zone ending at min(200 cm, iSDAsoil's depth to bedrock).
--    `root_depth_cm` is that depth. Pre-computed by the operator with
--    `ingest/soils.py` (never by the app, which reads no raster), keyed like
--    the evaporation grid (180): cell (row_idx, col_idx) is the square with
--    south-west corner (origin_lon + col_idx × cell_deg, origin_lat + row_idx
--    × cell_deg). A cell that isn't listed has no value.
--  * Global, not per project, like the evaporation grid (180) and the MAP
--    grid (207): any signed-in user reads them; water_app never writes them.
--    The repo ships only an invented grid (dataset 'synthetic').
--  * reference_load (192, latest 261) takes the kind 'soils': a production
--    load (load-reference.yml, geo/referenceLoad.ts) records the bucket file
--    it read and its SHA-256 in the replace's transaction. The list keeps
--    every earlier kind (referenceLoad.db.test.ts inserts one of each).

CREATE TABLE soil_dataset (
	-- 'synthetic' (the repo's invented fixture) or the operator's label ('SoilGrids2-iSDA-D1').
	dataset      text PRIMARY KEY CHECK (char_length(dataset) BETWEEN 1 AND 50),
	source       text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 500),
	version      text NOT NULL CHECK (char_length(version) BETWEEN 1 AND 100),
	method       text NOT NULL CHECK (char_length(method) BETWEEN 1 AND 1000),
	attribution  text NOT NULL CHECK (char_length(attribution) BETWEEN 1 AND 500),
	cell_deg     double precision NOT NULL CHECK (cell_deg > 0 AND cell_deg <= 1),
	origin_lon   double precision NOT NULL CHECK (origin_lon >= 0 AND origin_lon < cell_deg),
	origin_lat   double precision NOT NULL CHECK (origin_lat >= 0 AND origin_lat < cell_deg),
	loaded_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE soil_cell_reference (
	dataset        text NOT NULL REFERENCES soil_dataset(dataset) ON DELETE CASCADE,
	row_idx        integer NOT NULL,
	col_idx        integer NOT NULL,
	-- Root-zone plant-available water capacity, mm (water at field capacity, 33 kPa, less at wilting point, 1500 kPa).
	pawc_mm        real NOT NULL CHECK (pawc_mm >= 0 AND pawc_mm <= 1000),
	-- Where the root zone ends: min(200 cm, the depth to bedrock).
	root_depth_cm  real NOT NULL CHECK (root_depth_cm > 0 AND root_depth_cm <= 200),
	-- Also the covering index of the dataset key, and a polygon's lookup: one dataset, a range of rows, a range of columns.
	PRIMARY KEY (dataset, row_idx, col_idx)
);

COMMENT ON TABLE soil_dataset IS
	'Soil water capacity grids loaded for the regional GR4J prior (268, issue #622): source, version, method, attribution, grid. Loaded by the operator (pnpm import:soils, from ingest/soils.py''s file), read-only to the app. The repo ships a synthetic grid only.';
COMMENT ON TABLE soil_cell_reference IS
	'Per dataset, the grid cells with a value: root-zone plant-available water capacity, mm (SoilGrids 2.0 wv0033 − wv1500 over the layers to min(200 cm, iSDAsoil depth to bedrock)), and that depth (268). A cell not listed has none.';

ALTER TABLE soil_dataset ENABLE ROW LEVEL SECURITY;
ALTER TABLE soil_cell_reference ENABLE ROW LEVEL SECURITY;
-- Public reference data: anyone signed in reads it; the app never writes it.
CREATE POLICY soil_dataset_select ON soil_dataset FOR SELECT USING (app_current_user_id() IS NOT NULL);
CREATE POLICY soil_cell_reference_select ON soil_cell_reference FOR SELECT USING (app_current_user_id() IS NOT NULL);

GRANT SELECT ON soil_dataset, soil_cell_reference TO water_app;

ALTER TABLE reference_load DROP CONSTRAINT reference_load_kind_check;
ALTER TABLE reference_load ADD CONSTRAINT reference_load_kind_check
	CHECK (kind IN ('land-cover', 'evaporation', 'rivers', 'gazetteer', 'map-grid', 'tiles', 'waterbodies', 'dws', 'soils'));
