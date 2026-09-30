-- 114_node_operating_rules — a farm's hands-off flow and River to dam by
-- month (engine 1.32.0, WP-3.8, issue #204, docs/model.md §2.7h,
-- docs/data-model.md § Nodes).
--
-- hands_off_m3_day: a flow (m3/day) by water-year month (Oct-Sep, 12 values
-- >= 0) left in the river at the farm before the river pump or River to dam
-- takes anything. NULL = none.
--
-- hands_off_ewr: also leave the EWR required at the farm (its cumulative
-- requirement) in the river, as a river off-take's transfer.hands_off_ewr
-- (091) does. Default false.
--
-- divert_monthly_m3_day: River to dam's capacity (m3/day) by water-year month
-- (12 values >= 0). When set it replaces divert_capacity_m3_day, which is then
-- inert; 0 in a month = no diversion that month. NULL = the one
-- divert_capacity_m3_day all year.
--
-- Farms only is a model rule (engine modelRuleIssues, operatingKind), checked
-- by the API on save as the supply rule's kind is (060); the table checks only
-- what holds for every row: 12 values, none NULL and none negative (the
-- arrays' pattern of 011 and 041, plus the NULL element, which 0 <= ALL lets
-- through: a comparison with NULL is unknown, and a CHECK passes unknown).
--
-- New columns on an existing table: the table-level grants to water_app in 001
-- and node's RLS policies already cover them; no foreign key, so no index. No
-- view, function or trigger lists node's columns (the model store,
-- backend/src/model/store.ts, is the one place that does). Expand only: every
-- existing row reads NULL / false, which is what every engine before 1.32.0
-- ran, so no stored result changes meaning.

ALTER TABLE node
	ADD COLUMN hands_off_m3_day double precision[]
		CHECK (hands_off_m3_day IS NULL OR (cardinality(hands_off_m3_day) = 12 AND array_position(hands_off_m3_day, NULL) IS NULL AND 0 <= ALL (hands_off_m3_day))),
	ADD COLUMN hands_off_ewr boolean NOT NULL DEFAULT false,
	ADD COLUMN divert_monthly_m3_day double precision[]
		CHECK (divert_monthly_m3_day IS NULL OR (cardinality(divert_monthly_m3_day) = 12 AND array_position(divert_monthly_m3_day, NULL) IS NULL AND 0 <= ALL (divert_monthly_m3_day)));

COMMENT ON COLUMN node.hands_off_m3_day IS
	'Hands-off flow (m3/day) by water-year month (Oct-Sep, 12 values >= 0) left in the river before the river pump and River to dam; NULL = none. Farms only. Engine >= 1.32.0 (issue #204).';
COMMENT ON COLUMN node.hands_off_ewr IS
	'Also leave the EWR required at the farm in the river before the river pump and River to dam. Default false. Farms only. Engine >= 1.32.0.';
COMMENT ON COLUMN node.divert_monthly_m3_day IS
	'River to dam capacity (m3/day) by water-year month (12 values >= 0); replaces divert_capacity_m3_day when set; NULL = that one value all year. Farms only. Engine >= 1.32.0.';
