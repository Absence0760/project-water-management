-- 310_quaternary_evaporation — WR2012's monthly evaporation per quaternary,
-- from its WRSM2000 (Pitman) network configurations (docs/maps.md §
-- Quaternary evaporation, § WR2012 evaporation by quaternary; docs/model.md
-- §2.3a; docs/data-model.md § Catchment map). Allowed in production by the
-- operator's decision of 2026-11-03, which extends the 2026-11-02 WR2012
-- decision to its evaporation values on the same published terms
-- (docs/maps.md § Sources).
--
-- In this file:
--  * quaternary_reference (152) gains two nullable context columns, loaded
--    with the rest of a quaternary's values (`pnpm import:quaternaries`, the
--    CSV `scripts/wbt-import/wr2012_quat_info.py` writes from WR2012's
--    per-WMA spreadsheets), never by the app: `mae_mm`, the mean annual
--    Symons-pan (S-pan) evaporation, mm, and `evap_zone`, the WR2012
--    evaporation zone. Both or neither. Shown beside the monthly rows below:
--    the MAE against the S-pan row's total is a check of the two sources.
--  * quaternary_evaporation: per dataset and quaternary code, 12 monthly
--    S-pan depths (the runoff module's) and 12 monthly A-pan depths (the
--    irrigation module's), mm, October first, either missing, and their
--    provenance: how many modules named the quaternary, how many agreed
--    with the row kept (the majority), the other rows' annual totals, and the
--    module file names. Loaded by the operator (`pnpm import:quaternary-evaporation`,
--    the CSV `scripts/wbt-import/wrsm_evaporation.py` writes; in production
--    reference-load kind `quaternary-evaporation`). Keyed by (dataset, code)
--    and joined to quaternary_reference by code, with no foreign key: the two
--    are loaded and replaced separately (a reload of the outlines must not
--    delete the evaporation), and the outlines' table is keyed by code across
--    datasets.
--  * reference_load (192, latest 309) takes the kind 'quaternary-evaporation':
--    a production load records its file and SHA-256 there, as the others do.
--  * RLS: public reference data, as quaternary_reference's: anyone signed in
--    reads it; water_app never writes it (SELECT only). No foreign keys, so
--    no covering index beyond the primary key.

ALTER TABLE quaternary_reference
	ADD COLUMN mae_mm double precision CHECK (mae_mm IS NULL OR (mae_mm > 0 AND mae_mm < 5000)),
	ADD COLUMN evap_zone text CHECK (evap_zone IS NULL OR evap_zone ~ '^[A-Z0-9]{1,8}$'),
	ADD CONSTRAINT quaternary_reference_evaporation_pair CHECK ((mae_mm IS NULL) = (evap_zone IS NULL));

COMMENT ON COLUMN quaternary_reference.mae_mm IS
	'WR2012 mean annual Symons-pan (S-pan) evaporation, mm a year (310): context beside quaternary_evaporation''s monthly rows. With evap_zone, or neither.';
COMMENT ON COLUMN quaternary_reference.evap_zone IS
	'The WR2012 evaporation zone (310), shown as context.';

CREATE TABLE quaternary_evaporation (
	-- The load it came from: 'synthetic' (the repo's invented fixture) or the operator's label.
	dataset         text NOT NULL CHECK (char_length(dataset) BETWEEN 1 AND 50),
	code            text NOT NULL CHECK (code ~ '^[A-Z][0-9]{2}[A-Z]$'),
	-- Monthly S-pan (runoff module) and A-pan (irrigation module), mm, October … September.
	span_mm         double precision[] CHECK (
		span_mm IS NULL OR (cardinality(span_mm) = 12 AND array_position(span_mm, NULL) IS NULL AND 0 <= ALL (span_mm) AND 1000 > ALL (span_mm))
	),
	apan_mm         double precision[] CHECK (
		apan_mm IS NULL OR (cardinality(apan_mm) = 12 AND array_position(apan_mm, NULL) IS NULL AND 0 <= ALL (apan_mm) AND 1000 > ALL (apan_mm))
	),
	-- How many modules named the quaternary, and how many gave the row kept; the others' annual totals, mm.
	span_modules    integer NOT NULL DEFAULT 0 CHECK (span_modules >= 0),
	span_agree      integer NOT NULL DEFAULT 0 CHECK (span_agree BETWEEN 0 AND span_modules),
	span_others_mm  double precision[] NOT NULL DEFAULT '{}' CHECK (cardinality(span_others_mm) <= 50),
	span_files      text[] NOT NULL DEFAULT '{}' CHECK (cardinality(span_files) <= 50),
	apan_modules    integer NOT NULL DEFAULT 0 CHECK (apan_modules >= 0),
	apan_agree      integer NOT NULL DEFAULT 0 CHECK (apan_agree BETWEEN 0 AND apan_modules),
	apan_others_mm  double precision[] NOT NULL DEFAULT '{}' CHECK (cardinality(apan_others_mm) <= 50),
	apan_files      text[] NOT NULL DEFAULT '{}' CHECK (cardinality(apan_files) <= 50),
	-- Shown with every proposal: the study and the configurations.
	source          text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 500),
	loaded_at       timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (dataset, code),
	CHECK (span_mm IS NOT NULL OR apan_mm IS NOT NULL),
	CHECK ((span_mm IS NULL) = (span_modules = 0)),
	CHECK ((apan_mm IS NULL) = (apan_modules = 0))
);
-- The proposal reads a boundary's quaternaries by code, across datasets.
CREATE INDEX quaternary_evaporation_code_idx ON quaternary_evaporation (code);

COMMENT ON TABLE quaternary_evaporation IS
	'WR2012 monthly S-pan (runoff modules) and A-pan (irrigation modules) per quaternary, from the WRSM2000 network configurations, with their module provenance; loaded by the operator, read-only to the app (310).';

ALTER TABLE quaternary_evaporation ENABLE ROW LEVEL SECURITY;
-- Public reference data: anyone signed in reads it; the app never writes it.
CREATE POLICY quaternary_evaporation_select ON quaternary_evaporation FOR SELECT USING (app_current_user_id() IS NOT NULL);

GRANT SELECT ON quaternary_evaporation TO water_app;

ALTER TABLE reference_load DROP CONSTRAINT reference_load_kind_check;
ALTER TABLE reference_load ADD CONSTRAINT reference_load_kind_check
	CHECK (kind IN ('land-cover', 'evaporation', 'rivers', 'gazetteer', 'map-grid', 'tiles', 'waterbodies', 'dws', 'soils', 'gr4j-donors', 'quaternaries', 'quaternary-evaporation'));
