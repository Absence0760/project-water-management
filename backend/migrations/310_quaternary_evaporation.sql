-- 310_quaternary_evaporation — WR2012's evaporation per quaternary: each
-- quaternary's mean annual S-pan evaporation (MAE) and evaporation zone, and
-- each zone's monthly distribution as a percentage of MAE (docs/maps.md §
-- Quaternary dataset, § WR2012 S-pan; docs/model.md §2.3a; docs/data-model.md
-- § Catchment map). Allowed in production by the operator's decision of
-- 2026-11-03, which extends the 2026-11-02 WR2012 decision to its
-- evaporation values on the same published terms (docs/maps.md § Sources).
--
-- In this file:
--  * quaternary_reference (152) gains two nullable columns, loaded with the
--    rest of a quaternary's values by `pnpm import:quaternaries` (and the
--    production load, kind `quaternaries`), never by the app:
--      - mae_mm: mean annual Symons-pan (S-pan) evaporation, mm a year.
--      - evap_zone: the WR2012 evaporation zone whose monthly distribution
--        spreads that MAE over the months.
--    Both or neither: the loader drops both when the zone has no
--    distribution in the same load, and lists the quaternary as skipped for
--    evaporation (it is loaded otherwise). Columns, not a sibling table: they
--    are one value each per quaternary, loaded, replaced and deleted with its
--    other values in the same transaction, and every reader already reads
--    quaternary_reference by code.
--  * quaternary_evap_zone: per dataset, each evaporation zone's 12 monthly
--    percentages of MAE (Oct … Sep). A zone is the dataset's own, keyed by
--    (dataset, zone): the same zone label in two loads may differ. The CHECKs
--    hold what the loader validates: 12 numbers, none missing, each 0 or
--    more, adding up to 95–105 (WR2012's tables round to whole or tenth
--    percentages, so they rarely add to exactly 100).
--  * No foreign key from quaternary_reference.evap_zone to the zones table:
--    quaternary_reference is keyed by code across datasets, and a load
--    replaces both together (loadQuaternaries.ts replaceDataset). The
--    proposal joins them on (dataset, zone).
--  * RLS: public reference data, as quaternary_reference's: anyone signed in
--    reads it; water_app never writes it (SELECT only). No foreign keys, so
--    no covering index beyond the primary key.

ALTER TABLE quaternary_reference
	ADD COLUMN mae_mm double precision CHECK (mae_mm IS NULL OR (mae_mm > 0 AND mae_mm < 5000)),
	ADD COLUMN evap_zone text CHECK (evap_zone IS NULL OR evap_zone ~ '^[A-Z0-9]{1,8}$'),
	ADD CONSTRAINT quaternary_reference_evaporation_pair CHECK ((mae_mm IS NULL) = (evap_zone IS NULL));

COMMENT ON COLUMN quaternary_reference.mae_mm IS
	'Mean annual Symons-pan (S-pan) evaporation, mm a year (WR2012; 310). With evap_zone, or neither.';
COMMENT ON COLUMN quaternary_reference.evap_zone IS
	'The WR2012 evaporation zone whose monthly distribution (quaternary_evap_zone, same dataset) spreads mae_mm over the months (310).';

CREATE TABLE quaternary_evap_zone (
	-- The load it came from, as quaternary_reference.dataset.
	dataset    text NOT NULL CHECK (char_length(dataset) BETWEEN 1 AND 50),
	zone       text NOT NULL CHECK (zone ~ '^[A-Z0-9]{1,8}$'),
	-- Each month's share of the mean annual evaporation, %, October … September.
	pct        double precision[] NOT NULL CHECK (
		cardinality(pct) = 12
		AND array_position(pct, NULL) IS NULL
		AND 0 <= ALL (pct)
		AND pct[1] + pct[2] + pct[3] + pct[4] + pct[5] + pct[6] + pct[7] + pct[8] + pct[9] + pct[10] + pct[11] + pct[12] BETWEEN 95 AND 105
	),
	loaded_at  timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (dataset, zone)
);

COMMENT ON TABLE quaternary_evap_zone IS
	'WR2012 evaporation zones: each zone''s monthly S-pan evaporation as % of MAE, Oct … Sep, per dataset; loaded with the quaternaries by the operator, read-only to the app (310).';

ALTER TABLE quaternary_evap_zone ENABLE ROW LEVEL SECURITY;
-- Public reference data: anyone signed in reads it; the app never writes it.
CREATE POLICY quaternary_evap_zone_select ON quaternary_evap_zone FOR SELECT USING (app_current_user_id() IS NOT NULL);

GRANT SELECT ON quaternary_evap_zone TO water_app;
