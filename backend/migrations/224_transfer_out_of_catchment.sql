-- 224_transfer_out_of_catchment — a transfer out of the catchment (engine
-- 1.86.0, issue #523 B5, docs/model.md §2.6). A dam rule may send its water
-- out of the catchment instead of to a unit: to_node_id NULL. It runs as any
-- dam rule (its months, rates, priority and the source dam's minimum storage)
-- and the water leaves the model, counted as leaving the catchment in the run's
-- water balance.
--
--   to_node_id  NULL = outside the catchment. Every existing row names a unit,
--               so every stored transfer runs as before.
--
-- Only a dam rule can leave the catchment: a river off-take delivers to a unit
-- (the API refuses one too, engine modelRuleIssues). The existing checks hold
-- with a NULL: from_node_id <> to_node_id is NULL, which a CHECK passes, and
-- the same-project trigger skips a NULL column. No new column or table, so the
-- grants (001) and transfer's RLS policies already cover it: a farmer sees an
-- external rule from their own unit through transfer_select_farmer's
-- from_node_id arm (020).

ALTER TABLE transfer ALTER COLUMN to_node_id DROP NOT NULL;

ALTER TABLE transfer ADD CONSTRAINT transfer_external_from_dam CHECK (to_node_id IS NOT NULL OR source = 'dam');

COMMENT ON COLUMN transfer.to_node_id IS
	'The unit the water goes to; NULL = outside the catchment (a dam rule only, engine >= 1.86.0).';
