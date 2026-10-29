-- 269_gr4j_donors — the calibrated donor basins the regional GR4J prior is
-- built from (issue #622 step 3; docs/model.md §2.10m, docs/deployment.md §
-- Reference datasets, GR4J donors; docs/data-model.md § Catchment map).
--
-- In this file:
--  * gr4j_donor_dataset: one row per loaded donor set: its label, the source
--    line (GRDC-Caravan's flow, HydroATLAS's attributes, our forcing), the
--    version, the fit's method in words (forcing, objective, bounds, the
--    donor criteria), the attribution the licences ask for (both CC BY 4.0,
--    docs/data-sources.md § grdc-caravan and § hydroatlas), the engine
--    version the donors were fitted with, and the SHA-256 of the set's
--    canonical form (engine donorSetCanonical), which a prior's fit record
--    will name.
--  * gr4j_donor: per dataset, each donor basin: its GRDC-Caravan gauge id,
--    outlet, the HydroATLAS attributes the prior compares (engine
--    PRIOR_ATTRIBUTES, converted to plain units: aridity as P/PET, slope in
--    degrees) and its degree of regulation, its soil water capacity when the
--    soil grid (268) covers it, the years of flow it was fitted on, the
--    parameters x1–x4 fitted by `backend/scripts/fit-donors.ts` on the app's
--    own forcing (CHIRPS v3 from our copy, dPET PE; never Caravan's ERA5-Land),
--    and its KGE′ over the fit and, when the record allowed a split, over the
--    validation half. No flow is stored: only what was fitted from it.
--  * Every number is double precision, so the donors read back are the
--    values the SHA-256 was taken of (a real would round them).
--  * Global, not per project, like the other reference datasets: any signed-in
--    user reads them; water_app never writes them. The repo ships only
--    invented donors (dataset 'synthetic'); the real set is the operator's,
--    loaded, never committed.
--  * reference_load (192, latest 268) takes the kind 'gr4j-donors'; the list
--    keeps every earlier kind.

CREATE TABLE gr4j_donor_dataset (
	-- 'synthetic' (the repo's invented donors) or the operator's label ('Caravan-D1-2026').
	dataset          text PRIMARY KEY CHECK (char_length(dataset) BETWEEN 1 AND 50),
	source           text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 500),
	version          text NOT NULL CHECK (char_length(version) BETWEEN 1 AND 100),
	method           text NOT NULL CHECK (char_length(method) BETWEEN 1 AND 1000),
	attribution      text NOT NULL CHECK (char_length(attribution) BETWEEN 1 AND 500),
	engine_version   text NOT NULL CHECK (engine_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
	donor_set_sha256 text NOT NULL CHECK (donor_set_sha256 ~ '^[0-9a-f]{64}$'),
	loaded_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gr4j_donor (
	dataset         text NOT NULL REFERENCES gr4j_donor_dataset(dataset) ON DELETE CASCADE,
	basin_id        text NOT NULL CHECK (basin_id ~ '^[A-Za-z0-9_-]{1,40}$'),
	lon             double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
	lat             double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
	area_km2        double precision NOT NULL CHECK (area_km2 > 0),
	-- HydroATLAS's, in plain units (null: not given).
	aridity         double precision CHECK (aridity >= 0),
	map_mm          double precision CHECK (map_mm >= 0),
	slope_deg       double precision CHECK (slope_deg >= 0 AND slope_deg <= 90),
	clay_pct        double precision CHECK (clay_pct BETWEEN 0 AND 100),
	sand_pct        double precision CHECK (sand_pct BETWEEN 0 AND 100),
	forest_pct      double precision CHECK (forest_pct BETWEEN 0 AND 100),
	-- Degree of regulation, % (HydroATLAS dor_pc_pva ÷ 10): a donor is under 5.
	dor_pct         double precision NOT NULL CHECK (dor_pct >= 0 AND dor_pct < 5),
	pawc_mm         double precision CHECK (pawc_mm >= 0 AND pawc_mm <= 1000),
	-- Years of observed flow inside the fit window: a donor has at least 8.
	flow_years      double precision NOT NULL CHECK (flow_years >= 8),
	-- GR4J_PARAMS' hard bounds (engine runoff/params.ts).
	x1              double precision NOT NULL CHECK (x1 BETWEEN 10 AND 3000),
	x2              double precision NOT NULL CHECK (x2 BETWEEN -5 AND 3),
	x3              double precision NOT NULL CHECK (x3 BETWEEN 1 AND 1000),
	x4              double precision NOT NULL CHECK (x4 BETWEEN 0.5 AND 10),
	kge_fit         double precision NOT NULL CHECK (kge_fit <= 1),
	kge_validation  double precision CHECK (kge_validation <= 1),
	-- Also the covering index of the dataset key.
	PRIMARY KEY (dataset, basin_id)
);

COMMENT ON TABLE gr4j_donor_dataset IS
	'Donor sets for the regional GR4J prior (269, issue #622): source, version, the fit''s method, attribution, the engine that fitted them and the set''s SHA-256. Loaded by the operator (pnpm import:gr4j-donors, from fit-donors.ts''s file), read-only to the app. The repo ships synthetic donors only.';
COMMENT ON TABLE gr4j_donor IS
	'Per donor set, each gauged basin: outlet, HydroATLAS attributes, regulation, PAWC, years of flow, GR4J x1–x4 fitted on CHIRPS v3 + dPET, KGE′ fit and validation (269). No flow is stored.';

ALTER TABLE gr4j_donor_dataset ENABLE ROW LEVEL SECURITY;
ALTER TABLE gr4j_donor ENABLE ROW LEVEL SECURITY;
-- Public reference data: anyone signed in reads it; the app never writes it.
CREATE POLICY gr4j_donor_dataset_select ON gr4j_donor_dataset FOR SELECT USING (app_current_user_id() IS NOT NULL);
CREATE POLICY gr4j_donor_select ON gr4j_donor FOR SELECT USING (app_current_user_id() IS NOT NULL);

GRANT SELECT ON gr4j_donor_dataset, gr4j_donor TO water_app;

ALTER TABLE reference_load DROP CONSTRAINT reference_load_kind_check;
ALTER TABLE reference_load ADD CONSTRAINT reference_load_kind_check
	CHECK (kind IN ('land-cover', 'evaporation', 'rivers', 'gazetteer', 'map-grid', 'tiles', 'waterbodies', 'dws', 'soils', 'gr4j-donors'));
