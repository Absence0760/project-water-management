-- 158_node_pool — a pool at a run-of-river unit's pump intake (engine 1.64.0,
-- docs/model.md §2.7j, docs/data-model.md § Nodes).
--
-- pool_capacity_m3: the pool's capacity (m3), a natural pool or a weir pool
-- in the channel that the river pump draws down once the flow it may take is
-- used, refilled from the flow above what must pass the unit. NULL = no pool.
--
-- pool_initial_pct: its storage at the start of a run, fraction 0-1 of the
-- capacity. Default 1 (full).
--
-- pool_area_m2: its surface area when full (m2), for its evaporation. NULL =
-- not known: the run estimates it from the capacity and warns.
--
-- A run-of-river unit only is a model rule (engine modelRuleIssues, poolRule),
-- checked by the API on save as the supply rule's kind is (060); the table
-- checks only what holds for every row: a capacity above 0, a start in 0-1, an
-- area of 0 or more.
--
-- New columns on an existing table: the table-level grants to water_app in 001
-- and node's RLS policies already cover them; no foreign key, so no index. No
-- view, function or trigger lists node's columns (the model store,
-- backend/src/model/store.ts, is the one place that does). Expand only: every
-- existing row reads no pool, which is what every engine before 1.64.0 ran,
-- so no stored result changes meaning.

ALTER TABLE node
	ADD COLUMN pool_capacity_m3 double precision CHECK (pool_capacity_m3 IS NULL OR pool_capacity_m3 > 0),
	ADD COLUMN pool_initial_pct double precision NOT NULL DEFAULT 1 CHECK (pool_initial_pct >= 0 AND pool_initial_pct <= 1),
	ADD COLUMN pool_area_m2 double precision CHECK (pool_area_m2 IS NULL OR pool_area_m2 >= 0);

COMMENT ON COLUMN node.pool_capacity_m3 IS
	'Pool at the river pump intake (m3): drawn down once the flow the pump may take is used, refilled from the flow above what must pass; NULL = none. Run-of-river units only. Engine >= 1.64.0.';
COMMENT ON COLUMN node.pool_initial_pct IS
	'The pool''s storage at the start of a run, fraction 0-1 of its capacity. Default 1 (full). Engine >= 1.64.0.';
COMMENT ON COLUMN node.pool_area_m2 IS
	'The pool''s surface area when full (m2), for its evaporation; NULL = estimated from the capacity. Engine >= 1.64.0.';
