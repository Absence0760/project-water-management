-- 060_supply_rules — a farm's supply rule and river pump (engine 0.42.0,
-- roadmap WP-3.8, issue #54 item 2c, docs/model.md §2.7e).
--
-- supply_rule: where a farm's irrigation water comes from. 'damFirst' (the
-- default, every existing row) is what every engine before 0.42.0 did: the
-- dam only, never a pump on the river. 'riverFirst' pumps from the flow below
-- the dam first, 'trigger' switches to the river while the dam is low
-- (supply_trigger_pct … supply_stop_pct of capacity), 'runOfRiver' has no dam
-- (the API refuses it with a dam capacity above 0).
--
-- pump_capacity_m3_day: the river pump's capacity (m3/day; pumps x m3/h x 24
-- in the form). NULL = no limit; inert under 'damFirst'. Stored as m3/day,
-- not as pumps and m3/h, so one number can't disagree with itself.
--
-- supply_trigger_pct / supply_stop_pct: the trigger rule's switch levels,
-- fractions of dam capacity (defaults 0.4 and 0.6, a neutral starting band;
-- set per unit). The API refuses a stop below the trigger.
--
-- New columns on an existing table: the table-level grants to water_app in 001
-- and its RLS policies already cover them; no foreign key, so no index.

ALTER TABLE node
	ADD COLUMN supply_rule text NOT NULL DEFAULT 'damFirst'
		CHECK (supply_rule IN ('damFirst', 'riverFirst', 'trigger', 'runOfRiver')),
	ADD COLUMN pump_capacity_m3_day double precision CHECK (pump_capacity_m3_day >= 0),
	ADD COLUMN supply_trigger_pct double precision NOT NULL DEFAULT 0.4
		CHECK (supply_trigger_pct BETWEEN 0 AND 1),
	ADD COLUMN supply_stop_pct double precision NOT NULL DEFAULT 0.6
		CHECK (supply_stop_pct BETWEEN 0 AND 1);

COMMENT ON COLUMN node.supply_rule IS
	'damFirst (default: the dam only), riverFirst, trigger or runOfRiver (no dam). Farms only. Engine >= 0.42.0 (WP-3.8).';
COMMENT ON COLUMN node.pump_capacity_m3_day IS
	'River pump capacity (m3/day); NULL = no limit; inert under damFirst. Engine >= 0.42.0.';
COMMENT ON COLUMN node.supply_trigger_pct IS
	'trigger rule: switch to the river when the dam holds less than this share (0-1) of capacity. Default 0.4. Engine >= 0.42.0.';
COMMENT ON COLUMN node.supply_stop_pct IS
	'trigger rule: switch back to the dam once it holds at least this share (0-1, >= the trigger). Default 0.6. Engine >= 0.42.0.';
