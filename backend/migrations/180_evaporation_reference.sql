-- 180_evaporation_reference — the evaporation grid the catchment map proposes
-- a project's evaporation input from (issue #326 Part B, "B-evap";
-- docs/maps.md § Evaporation from the map, docs/data-model.md § Catchment map).
--
-- In this file:
--  * evaporation_dataset: one row per loaded evaporation product: its label,
--    what it measures (`kind`), the source line, version, the summarising
--    method in words, the attribution its licence asks for, the period its
--    monthly means cover, and its grid. Proposals quote it, so an accepted
--    value (and through its model revision, an evidence pack) names the
--    product, version and method.
--      - kind 'et0': FAO-56 Penman-Monteith reference evapotranspiration.
--        It is proposed as GR4J's monthly PE (settings.pe = { kind:
--        'monthly' }, docs/model.md §2.4a) as it stands, never converted to
--        A-pan: ET₀ isn't pan evaporation, and turning it into one needs a
--        pan coefficient, which is the modeller's call.
--      - kind 'apan': Class-A pan evaporation, proposed as settings.apanMm.
--    A Symons-pan (S-pan) product, WR2012's kind, is no kind here: it needs
--    the modeller's S-pan → A-pan factors, so a loader refuses it.
--  * evaporation_cell_reference: per dataset, the grid cells with a value and
--    their 12 mean monthly totals, mm, in water-year order (Oct … Sep), like
--    settings.apanMm. Pre-summarised by the operator from the daily product
--    with `pnpm import:evaporation` (never by the app, which reads no
--    NetCDF). Cell (row_idx, col_idx) is the square with south-west corner
--    (origin_lon + col_idx × cell_deg, origin_lat + row_idx × cell_deg): a
--    grid of cell centres on whole multiples of 0.1° (dPET's) has its
--    corners half a cell off them, which the origin carries. A cell that
--    isn't listed has no value (sea, or outside the loaded box).
--  * A grid, not a value per quaternary: a per-quaternary summary would need
--    the DWS quaternary outlines, whose licence is unconfirmed (docs/maps.md
--    § Sources), and the boundary's own cells are a closer average anyway.
--  * Global, not per project, like quaternary_reference (152) and the
--    cropland grid (173): any signed-in user reads them; water_app never
--    writes them. The repo ships only an invented grid (dataset
--    'synthetic'); real data is the operator's own download.
--  * No PostGIS: a polygon's cells are a range on the primary key here, and
--    the clipping is in the backend (geo/gridShares.ts).

CREATE TABLE evaporation_dataset (
	-- 'synthetic' (the repo's invented fixture) or the operator's label ('dPET-1991-2020').
	dataset      text PRIMARY KEY CHECK (char_length(dataset) BETWEEN 1 AND 50),
	kind         text NOT NULL CHECK (kind IN ('et0', 'apan')),
	source       text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 500),
	version      text NOT NULL CHECK (char_length(version) BETWEEN 1 AND 100),
	method       text NOT NULL CHECK (char_length(method) BETWEEN 1 AND 1000),
	attribution  text NOT NULL CHECK (char_length(attribution) BETWEEN 1 AND 500),
	-- The calendar years the monthly means average, inclusive.
	first_year   integer NOT NULL CHECK (first_year BETWEEN 1900 AND 2200),
	last_year    integer NOT NULL CHECK (last_year BETWEEN 1900 AND 2200),
	cell_deg     double precision NOT NULL CHECK (cell_deg > 0 AND cell_deg <= 1),
	origin_lon   double precision NOT NULL CHECK (origin_lon >= 0 AND origin_lon < cell_deg),
	origin_lat   double precision NOT NULL CHECK (origin_lat >= 0 AND origin_lat < cell_deg),
	loaded_at    timestamptz NOT NULL DEFAULT now(),
	CHECK (first_year <= last_year)
);

CREATE TABLE evaporation_cell_reference (
	dataset    text NOT NULL REFERENCES evaporation_dataset(dataset) ON DELETE CASCADE,
	row_idx    integer NOT NULL,
	col_idx    integer NOT NULL,
	-- Oct … Sep, mean monthly total, mm.
	monthly_mm real[] NOT NULL CHECK (cardinality(monthly_mm) = 12 AND 0 <= ALL (monthly_mm) AND 1000 >= ALL (monthly_mm)),
	-- Also the covering index of the dataset key, and a polygon's lookup: one dataset, a range of rows, a range of columns.
	PRIMARY KEY (dataset, row_idx, col_idx)
);

COMMENT ON TABLE evaporation_dataset IS
	'Evaporation products loaded for the evaporation proposals (180, issue #326 B-evap): kind (et0 = FAO-56 reference ET, proposed as GR4J''s PE; apan = Class-A pan, proposed as the A-pan row), source, version, method, attribution, period, grid. Loaded by the operator (pnpm import:evaporation), read-only to the app. The repo ships a synthetic grid only.';
COMMENT ON TABLE evaporation_cell_reference IS
	'Per dataset, the grid cells with a value and their mean monthly totals, mm, Oct … Sep, pre-summarised from the daily product at import (180). A cell not listed has none.';

ALTER TABLE evaporation_dataset ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaporation_cell_reference ENABLE ROW LEVEL SECURITY;
-- Public reference data: anyone signed in reads it; the app never writes it.
CREATE POLICY evaporation_dataset_select ON evaporation_dataset FOR SELECT USING (app_current_user_id() IS NOT NULL);
CREATE POLICY evaporation_cell_reference_select ON evaporation_cell_reference FOR SELECT USING (app_current_user_id() IS NOT NULL);

GRANT SELECT ON evaporation_dataset, evaporation_cell_reference TO water_app;
