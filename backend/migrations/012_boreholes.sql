-- 012_boreholes — groundwater abstraction and stream depletion (engine 0.23.0,
-- roadmap WP-1.34, docs/model.md §2.7d).
--
-- A farm or other water user may pump from boreholes: up to
-- borehole_capacity_m3_day, by a rule (supplemental after the dam and river,
-- primary before them, or drought: supplemental while the farm dam holds less
-- than borehole_trigger_pct of its capacity). A share stream_depletion_frac of
-- what is pumped is eventually taken from the river's flow at the node,
-- lagged through a linear reservoir with time constant
-- stream_depletion_lag_days (0 = the same day).
--
-- borehole_capacity_m3_day NULL (every existing row) = no boreholes, and the
-- other four columns are then inert, so no stored result changes meaning.
-- New columns on an existing table: the table-level grants to water_app in 001
-- and its RLS policies already cover them; no foreign key, so no index.

ALTER TABLE node
	ADD COLUMN borehole_capacity_m3_day double precision CHECK (borehole_capacity_m3_day >= 0),
	ADD COLUMN borehole_rule text NOT NULL DEFAULT 'supplemental'
		CHECK (borehole_rule IN ('supplemental', 'primary', 'drought')),
	ADD COLUMN borehole_trigger_pct double precision NOT NULL DEFAULT 0.3
		CHECK (borehole_trigger_pct BETWEEN 0 AND 1),
	ADD COLUMN stream_depletion_frac double precision NOT NULL DEFAULT 0
		CHECK (stream_depletion_frac BETWEEN 0 AND 1),
	ADD COLUMN stream_depletion_lag_days double precision NOT NULL DEFAULT 0
		CHECK (stream_depletion_lag_days BETWEEN 0 AND 36500);

COMMENT ON COLUMN node.borehole_capacity_m3_day IS
	'Most that can be pumped per day (m3/day); NULL = no boreholes. Farms and other users. Engine >= 0.23.0.';
COMMENT ON COLUMN node.borehole_rule IS
	'supplemental (after dam and river), primary (first) or drought (supplemental while the dam is below the trigger). Engine >= 0.23.0.';
COMMENT ON COLUMN node.borehole_trigger_pct IS
	'drought rule: boreholes run while dam storage at the start of the day < this fraction of capacity. Engine >= 0.23.0.';
COMMENT ON COLUMN node.stream_depletion_frac IS
	'Share (0-1) of the pumped volume eventually taken from the river at this node. Engine >= 0.23.0.';
COMMENT ON COLUMN node.stream_depletion_lag_days IS
	'Time constant (days) of the linear-reservoir lag between pumping and stream depletion; 0 = same day. Engine >= 0.23.0.';
