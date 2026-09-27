-- 089_ga538_property — the GN 538 groundwater volume per property (engine
-- 1.12.0, issue #46 item 7, roadmap WP-3.9, docs/model.md §2.7d).
--
-- Until engine 1.12.0 every node with boreholes showed the general
-- authorisation's 40 000 m³/a ceiling beside its modelled use. GN 538 (2016)
-- gives each property size (ha) × the Table 2 rate of its quaternary
-- catchment (0, 45, 75, 150, 275 or 400 m³/ha/a), capped at 40 000. These two
-- columns carry the inputs; the engine works out the volume. Context only:
-- the app never decides whether a use is lawful.
--
-- NULL = not known: every existing row keeps the ceiling (with a run
-- warning), so existing projects run as before apart from the warning. The
-- rate's CHECK keeps it to the gazette's six values. Farms and other users
-- carry them; a gauge's are ignored by the engine, not constrained here,
-- because a save clears the nodes' topology part-way (model/store.ts).
--
-- New columns on an existing table: the table-level grants to water_app in
-- 001 and its RLS policies already cover them; no foreign key, so no index.

ALTER TABLE node
	ADD COLUMN ga_property_area_ha double precision
		CHECK (ga_property_area_ha >= 0 AND ga_property_area_ha <= 10000000),
	ADD COLUMN ga_rate_m3_ha_year integer
		CHECK (ga_rate_m3_ha_year IN (0, 45, 75, 150, 275, 400));

COMMENT ON COLUMN node.ga_property_area_ha IS
	'Size of the property the groundwater is taken on, ha (GN 538: land registered separately in a Deeds Office). NULL = unknown: the run shows the 40 000 m3/a ceiling. Engine >= 1.12.0.';
COMMENT ON COLUMN node.ga_rate_m3_ha_year IS
	'GN 538 Table 2 (Appendix B) abstraction rate for the property''s quaternary catchment, m3/ha/a: 0, 45, 75, 150, 275 or 400. NULL = not looked up. Engine >= 1.12.0.';
