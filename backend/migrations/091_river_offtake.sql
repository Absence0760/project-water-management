-- 091_river_offtake — a transfer rule can be a river off-take (engine 1.14.0,
-- issue #54, docs/model.md §2.6a).
--
-- source: where the rule takes its water. 'dam' (the default, every existing
-- row) is what every engine before 1.14.0 did: from the source farm's dam, out
-- of yesterday's storage. 'river' takes from the flow leaving the source unit
-- today and carries it to the destination, which meets its demand with it
-- first. Its capacity is the rule's own month's rate (090) or max rate, capped
-- by the daily cap, as a dam rule's; min_storage_pct is inert on it.
--
-- The rest apply to 'river' only and default to what changes nothing:
--   hands_off_m3_day  a flow (m3/day) left in the river below the source
--                     before anything is taken; NULL = none.
--   hands_off_ewr     also leave the EWR at the source in the river.
--   loss_pct          conveyance losses, a share 0 <= l < 1 of what is taken,
--                     lost from the catchment on the way.
--   sizing            'demand': only what the destination needs (its demand,
--                     plus its dam's room with top_up_dam); 'capacity': up to
--                     capacity, the rest flowing on down the destination's river.
--   top_up_dam        what is left once the destination's demand is met fills
--                     its dam instead of flowing on.
-- The API refuses an off-take that isn't unit to unit or whose destination
-- drains into its source (engine modelRuleIssues).
--
-- New columns on an existing table: the table-level grants to water_app in
-- 001 and transfer's RLS policies already cover them; no foreign key, so no
-- index.

ALTER TABLE transfer
	ADD COLUMN source text NOT NULL DEFAULT 'dam' CHECK (source IN ('dam', 'river')),
	ADD COLUMN hands_off_m3_day double precision CHECK (hands_off_m3_day >= 0),
	ADD COLUMN hands_off_ewr boolean NOT NULL DEFAULT false,
	ADD COLUMN loss_pct double precision NOT NULL DEFAULT 0 CHECK (loss_pct >= 0 AND loss_pct < 1),
	ADD COLUMN sizing text NOT NULL DEFAULT 'demand' CHECK (sizing IN ('demand', 'capacity')),
	ADD COLUMN top_up_dam boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN transfer.source IS
	'dam (default: from the source farm''s dam, yesterday''s storage) or river (a river off-take: from the flow leaving the source unit today). Engine >= 1.14.0.';
COMMENT ON COLUMN transfer.hands_off_m3_day IS
	'river: flow (m3/day) left in the river below the source before the off-take takes anything; NULL = none. Engine >= 1.14.0.';
COMMENT ON COLUMN transfer.hands_off_ewr IS
	'river: also leave the EWR at the source in the river. Engine >= 1.14.0.';
COMMENT ON COLUMN transfer.loss_pct IS
	'river: conveyance losses, share (0 <= l < 1) of what is taken that never arrives. Engine >= 1.14.0.';
COMMENT ON COLUMN transfer.sizing IS
	'river: demand (only what the destination needs) or capacity (up to capacity, the rest flows on). Engine >= 1.14.0.';
COMMENT ON COLUMN transfer.top_up_dam IS
	'river: what is left after the destination''s demand fills its dam instead of flowing on. Engine >= 1.14.0.';
