-- 126_offtake_loss_return — canal seepage back to the river (engine 1.42.0,
-- docs/model.md §2.6a). A river off-take's conveyance losses (091 loss_pct)
-- left the catchment; a share of them may now seep back to the river the same
-- day, like a dam's seepage return (041 dam_seepage_return_pct).
--
--   loss_return_pct      the share 0 <= r <= 1 of the losses that returns;
--                        0 (the default, every existing row) returns none,
--                        so every stored off-take runs as before.
--   loss_return_node_id  the unit whose outflow the returned seepage joins:
--                        NULL = the source itself (just below the off-take),
--                        otherwise a farm downstream of the source along the
--                        river (the API refuses any other, engine
--                        modelRuleIssues). Deleting that node sets it NULL;
--                        a model save can't get there, since the model it
--                        saves must not name a node it drops.
--
-- New columns on an existing table: the table-level grants to water_app (001)
-- and transfer's RLS policies already cover them. The new foreign key gets its
-- covering index (catalogue guard), and the same-project trigger now checks it
-- too, so a transfer can't name another project's node as its return unit.

ALTER TABLE transfer
	ADD COLUMN loss_return_pct double precision NOT NULL DEFAULT 0 CHECK (loss_return_pct >= 0 AND loss_return_pct <= 1),
	ADD COLUMN loss_return_node_id uuid REFERENCES node(id) ON DELETE SET NULL;

CREATE INDEX transfer_loss_return_node_idx ON transfer (loss_return_node_id);

DROP TRIGGER transfer_same_project ON transfer;
CREATE TRIGGER transfer_same_project BEFORE INSERT OR UPDATE ON transfer
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('from_node_id', 'to_node_id', 'loss_return_node_id');

COMMENT ON COLUMN transfer.loss_return_pct IS
	'river: share (0 <= r <= 1) of the conveyance losses that seeps back to the river the same day; 0 = none. Engine >= 1.42.0.';
COMMENT ON COLUMN transfer.loss_return_node_id IS
	'river: the unit whose outflow the returned seepage joins; NULL = the source. A farm downstream of the source along the river. Engine >= 1.42.0.';
