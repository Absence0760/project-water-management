-- 203_reach_loss — river bed (channel transmission) losses in the reach below
-- a node (engine 1.75.0, issue #444, docs/model.md §2.6b).
--
-- node.reach_loss_frac: the share f (0 <= f <= 0.5) of the flow the node
--   passes downstream that is lost in the reach between it and the next node,
--   into the river bed; loss = MIN(cap, f x outflow), and the lost water
--   leaves the catchment. 0 (the default, every existing row) = none, so
--   every stored model runs as before. Any kind of node; on the outlet the
--   engine ignores it (no reach below it in the model) and warns.
-- node.reach_loss_max_m3_day: the reach's loss at most, m3/day; NULL = no
--   cap. Read only with reach_loss_frac > 0.
--
-- Columns on an existing project table (001's node): its RLS policies,
-- same-project trigger and the table grants to water_app already cover them,
-- and they add no foreign key, so no index. No view, function or trigger
-- lists node's columns (the model store, backend/src/model/store.ts, is the
-- one place that does). Expand only.

ALTER TABLE node
	ADD COLUMN reach_loss_frac double precision NOT NULL DEFAULT 0
		CONSTRAINT node_reach_loss_frac_range CHECK (reach_loss_frac >= 0 AND reach_loss_frac <= 0.5),
	ADD COLUMN reach_loss_max_m3_day double precision
		CONSTRAINT node_reach_loss_max_size CHECK (reach_loss_max_m3_day IS NULL OR (reach_loss_max_m3_day >= 0 AND reach_loss_max_m3_day < 'Infinity'::double precision));

COMMENT ON COLUMN node.reach_loss_frac IS
	'Bed losses: share (0 <= f <= 0.5) of the flow this node passes downstream lost in the reach to the next node, MIN(reach_loss_max_m3_day, f x outflow), out of the catchment; 0 = none. Ignored on the outlet. Engine >= 1.75.0, docs/model.md 2.6b.';
COMMENT ON COLUMN node.reach_loss_max_m3_day IS
	'Bed losses: the reach''s loss at most, m3/day; NULL = no cap. Read only with reach_loss_frac > 0. Engine >= 1.75.0.';
