-- 011_other_water_users — other water users (engine 0.22.0, roadmap WP-1.33,
-- docs/model.md §2.7c): a town or municipal scheme, industry, or an unlisted
-- irrigator that takes water from the river at its position in the network.
--
-- A node of kind 'user' has a monthly demand, a share returned downstream the
-- same day (treated wastewater) and a priority against the farms. It has no
-- area, dam, crops or rain of its own; the engine ignores those columns on it
-- and the API refuses crop areas and transfers on it.
--
-- Existing rows are unchanged: they are farms and gauges, for which the new
-- columns are inert (demand NULL, return 0, priority 'senior'), so no stored
-- result changes meaning. New columns sit on an existing table, so the
-- table-level grants to water_app in 001 and its RLS policies already cover
-- them; no new foreign key, so no new index.
--
-- ALTER TYPE … ADD VALUE runs inside the migration's transaction (Postgres
-- ≥ 12); the new value is not used in this file, which that requires.

ALTER TYPE node_kind ADD VALUE IF NOT EXISTS 'user';

ALTER TABLE node
	ADD COLUMN user_demand_m3_day double precision[]
		CHECK (user_demand_m3_day IS NULL OR (cardinality(user_demand_m3_day) = 12 AND 0 <= ALL (user_demand_m3_day))),
	ADD COLUMN user_return_pct double precision NOT NULL DEFAULT 0
		CHECK (user_return_pct BETWEEN 0 AND 1),
	ADD COLUMN user_priority text NOT NULL DEFAULT 'senior'
		CHECK (user_priority IN ('senior', 'junior'));

COMMENT ON COLUMN node.user_demand_m3_day IS
	'Kind user only: demand from the river, m3/day per water-year month (index 1 = October). NULL = none. Engine >= 0.22.0.';
COMMENT ON COLUMN node.user_return_pct IS
	'Kind user only: share (0-1) of what it takes that returns below it the same day. Engine >= 0.22.0.';
COMMENT ON COLUMN node.user_priority IS
	'Kind user only: senior (its demand is passed down by the farms upstream, not curtailed for the EWR) or junior. Engine >= 0.22.0.';
