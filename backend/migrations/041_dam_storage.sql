-- 041_dam_storage — dam survey curves, releases and the seepage destination
-- (engine 0.35.0, roadmap WP-3.5, docs/model.md §2.7a).
--
-- dam_curve: the dam's survey rows, [{levelM, areaM2, volumeM3}, …], as on
-- the DWS dam technical data form (DW789). NULL (every existing row) = the
-- power-law area of WP-1.21. Stored as jsonb on the node rather than a child
-- table: a curve is a handful of rows (at most 200), always read and written
-- with its node, never queried row by row, and so inherits the node's RLS
-- policies (members, and a farmer's own linked nodes) with no new table,
-- trigger or grant. The engine and the API check its shape and monotonicity.
--
-- dam_release_rule / dam_release_m3_day / dam_outlet_capacity_m3_day: a
-- release before irrigation ('passInflow' passes inflow up to what the river
-- below still needs, 'fixed' releases a monthly amount), per water-year month
-- (Oct–Sep), capped by the outlet (NULL = no limit). Defaults: no release.
--
-- dam_seepage_return_pct: the share of the dam's seepage that returns below
-- the dam; the rest leaves the catchment. Default 1, what every engine before
-- 0.35.0 did, so no stored result changes meaning.
--
-- New columns on an existing table: the table-level grants to water_app in 001
-- and its RLS policies already cover them; no foreign key, so no index.

ALTER TABLE node
	ADD COLUMN dam_curve jsonb
		CHECK (dam_curve IS NULL OR (jsonb_typeof(dam_curve) = 'array' AND jsonb_array_length(dam_curve) <= 200)),
	ADD COLUMN dam_release_rule text NOT NULL DEFAULT 'none'
		CHECK (dam_release_rule IN ('none', 'passInflow', 'fixed')),
	ADD COLUMN dam_release_m3_day double precision[]
		CHECK (dam_release_m3_day IS NULL OR (cardinality(dam_release_m3_day) = 12 AND 0 <= ALL (dam_release_m3_day))),
	ADD COLUMN dam_outlet_capacity_m3_day double precision CHECK (dam_outlet_capacity_m3_day >= 0),
	ADD COLUMN dam_seepage_return_pct double precision NOT NULL DEFAULT 1
		CHECK (dam_seepage_return_pct BETWEEN 0 AND 1);

COMMENT ON COLUMN node.dam_curve IS
	'Dam survey rows [{levelM, areaM2, volumeM3}], at most 200; NULL = power-law area. Engine >= 0.35.0 (WP-3.5).';
COMMENT ON COLUMN node.dam_release_rule IS
	'none, passInflow (pass inflow up to the flow still needed below the dam) or fixed (a monthly release). Engine >= 0.35.0.';
COMMENT ON COLUMN node.dam_release_m3_day IS
	'm3/day per water-year month (Oct-Sep): the fixed release, or the pass-inflow target (NULL = the EWR required at the node). Engine >= 0.35.0.';
COMMENT ON COLUMN node.dam_outlet_capacity_m3_day IS
	'Most the outlet can release per day (m3/day); NULL = no limit. Engine >= 0.35.0.';
COMMENT ON COLUMN node.dam_seepage_return_pct IS
	'Share (0-1) of dam seepage returning below the dam; the rest leaves the catchment. Default 1. Engine >= 0.35.0.';
