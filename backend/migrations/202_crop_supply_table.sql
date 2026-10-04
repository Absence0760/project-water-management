-- 202_crop_supply_table — a unit's crop demand in shares of three sources: its
-- own dam side, the river at the unit, and the dam of another unit (engine
-- 1.73.0, issue #408, docs/model.md §2.7k).
--
-- node.crop_share_dam, node.crop_share_river, node.crop_share_remote: the
--   share (0 to 1) of the crop demand asked of each source. All three NULL
--   (every row before this) = no table: the crops take crop_water_source
--   (170), so every stored model runs as before. That set shares add up to
--   100 %, and that only a unit has a table, are model rules (the engine's
--   modelRuleIssues: cropShareSum, cropShareKind), checked by the API on save.
-- node.crop_remote_node_id: the unit whose dam supplies the remote share; a
--   unit with a dam that this unit doesn't drain into (cropRemoteNode,
--   cropRemoteDam, cropRemoteLoop). Deleting that node sets it NULL; a model
--   save can't get there, since the model it saves must not name a node it
--   drops (the remote share is then refused until another unit is named).
-- node.crop_remote_cap_m3_day: the pipe or canal's capacity from that dam
--   (m3/day); NULL = no limit.
--
-- New columns on an existing table: node's RLS policies and the table grants
-- to water_app (001) already cover them. The new foreign key gets its covering
-- index (catalogue guard), and the same-project trigger now checks it too, so
-- a unit can't name another project's node as its remote dam. No view or
-- function lists node's columns (the model store, backend/src/model/store.ts,
-- is the one place that does). Expand only.

ALTER TABLE node
	ADD COLUMN crop_share_dam double precision
		CONSTRAINT node_crop_share_dam_range CHECK (crop_share_dam IS NULL OR (crop_share_dam >= 0 AND crop_share_dam <= 1)),
	ADD COLUMN crop_share_river double precision
		CONSTRAINT node_crop_share_river_range CHECK (crop_share_river IS NULL OR (crop_share_river >= 0 AND crop_share_river <= 1)),
	ADD COLUMN crop_share_remote double precision
		CONSTRAINT node_crop_share_remote_range CHECK (crop_share_remote IS NULL OR (crop_share_remote >= 0 AND crop_share_remote <= 1)),
	ADD COLUMN crop_remote_node_id uuid REFERENCES node(id) ON DELETE SET NULL,
	ADD COLUMN crop_remote_cap_m3_day double precision
		CONSTRAINT node_crop_remote_cap_size CHECK (crop_remote_cap_m3_day IS NULL OR (crop_remote_cap_m3_day >= 0 AND crop_remote_cap_m3_day < 'Infinity'::double precision));

CREATE INDEX node_crop_remote_node_idx ON node (crop_remote_node_id);

DROP TRIGGER node_same_project ON node;
CREATE TRIGGER node_same_project BEFORE INSERT OR UPDATE ON node
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('downstream_node_id', 'crop_remote_node_id');

COMMENT ON COLUMN node.crop_share_dam IS
	'Crop supply table: share (0-1) of the crop demand asked of the unit''s own dam side; all three shares NULL = no table (crop_water_source). Engine >= 1.73.0, docs/model.md 2.7k.';
COMMENT ON COLUMN node.crop_share_river IS
	'Crop supply table: share (0-1) of the crop demand asked of the river at the unit, through the crops'' river abstraction (crop_river_pump_m3_day, crop_river_pool_m3). Engine >= 1.73.0.';
COMMENT ON COLUMN node.crop_share_remote IS
	'Crop supply table: share (0-1) of the crop demand asked of the dam of crop_remote_node_id. Engine >= 1.73.0.';
COMMENT ON COLUMN node.crop_remote_node_id IS
	'Crop supply table: the unit whose dam supplies crop_share_remote, after its own unit, the same day. Engine >= 1.73.0.';
COMMENT ON COLUMN node.crop_remote_cap_m3_day IS
	'Crop supply table: the pipe or canal''s capacity (m3/day) from crop_remote_node_id''s dam; NULL = no limit. Engine >= 1.73.0.';
