-- 170_water_source — where each demand of a unit takes its water: the dam, or
-- a river abstraction of its own beside it (engine 1.65.0, issue #344,
-- docs/model.md §2.7j).
--
-- A unit's crops (on node) and each demand object draw either on the dam side
-- under the unit's supply rule ('dam', every row before this: the run is the
-- same) or on the river through their own pump, with an optional pool at the
-- pump ('river').
--
-- node.crop_water_source: the crops' source. 'dam' (the default).
-- node.crop_river_pump_m3_day: the crops' river pump capacity (m3/day); NULL =
--   no limit. Read only under 'river'.
-- node.crop_river_pool_m3: a pool at that pump (m3; it starts a run full, its
--   area is estimated from the capacity); NULL or 0 = none. Read only under
--   'river'.
-- demand_object.water_source: the object's source; NULL = the dam (every
--   object saved before it).
-- demand_object.river_pump_m3_day, demand_object.river_pool_m3: as the crops'.
--
-- That only a unit's crops have a source is a model rule (the engine's
-- modelRuleIssues, cropSourceKind), checked by the API on save as the supply
-- rule's kind is (060); the CHECKs here hold what is true of every row: a
-- known source and sizes of 0 or more, finite.
--
-- Columns on existing project tables (001's node, 088's demand_object): their
-- RLS policies, same-project triggers and the table grants to water_app
-- already cover them, and they add no foreign key, so no index. No view,
-- function or trigger lists either table's columns (the model store,
-- backend/src/model/store.ts, is the one place that does). Expand only: every
-- existing row reads the dam, which is what every engine before 1.65.0 ran,
-- so no stored run changes meaning.

ALTER TABLE node
	ADD COLUMN crop_water_source text NOT NULL DEFAULT 'dam'
		CONSTRAINT node_crop_water_source_known CHECK (crop_water_source IN ('dam', 'river')),
	ADD COLUMN crop_river_pump_m3_day double precision
		CONSTRAINT node_crop_river_pump_size CHECK (crop_river_pump_m3_day IS NULL OR (crop_river_pump_m3_day >= 0 AND crop_river_pump_m3_day < 'Infinity'::double precision)),
	ADD COLUMN crop_river_pool_m3 double precision
		CONSTRAINT node_crop_river_pool_size CHECK (crop_river_pool_m3 IS NULL OR (crop_river_pool_m3 >= 0 AND crop_river_pool_m3 < 'Infinity'::double precision));

ALTER TABLE demand_object
	ADD COLUMN water_source text
		CONSTRAINT demand_object_water_source_known CHECK (water_source IS NULL OR water_source IN ('dam', 'river')),
	ADD COLUMN river_pump_m3_day double precision
		CONSTRAINT demand_object_river_pump_size CHECK (river_pump_m3_day IS NULL OR (river_pump_m3_day >= 0 AND river_pump_m3_day < 'Infinity'::double precision)),
	ADD COLUMN river_pool_m3 double precision
		CONSTRAINT demand_object_river_pool_size CHECK (river_pool_m3 IS NULL OR (river_pool_m3 >= 0 AND river_pool_m3 < 'Infinity'::double precision));

COMMENT ON COLUMN node.crop_water_source IS
	'Where the unit''s crops take their water: dam (the dam side under the supply rule, the default) or river (a river abstraction of their own beside the dam). Engine >= 1.65.0, docs/model.md 2.7j.';
COMMENT ON COLUMN node.crop_river_pump_m3_day IS
	'The crops'' river pump capacity (m3/day) under crop_water_source river; NULL = no limit. Engine >= 1.65.0.';
COMMENT ON COLUMN node.crop_river_pool_m3 IS
	'A pool at the crops'' river pump (m3; starts full, area estimated) under crop_water_source river; NULL or 0 = none. Engine >= 1.65.0.';
COMMENT ON COLUMN demand_object.water_source IS
	'Where the object takes its water: dam (NULL, the default) or river (a river abstraction of its own beside the dam). Engine >= 1.65.0, docs/model.md 2.7j.';
COMMENT ON COLUMN demand_object.river_pump_m3_day IS
	'Its river pump capacity (m3/day) under water_source river; NULL = no limit. Engine >= 1.65.0.';
COMMENT ON COLUMN demand_object.river_pool_m3 IS
	'A pool at its river pump (m3; starts full, area estimated) under water_source river; NULL or 0 = none. Engine >= 1.65.0.';
