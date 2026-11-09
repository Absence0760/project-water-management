-- 319_monthly_losses — bed losses and a unit's base-flow loss and gain by
-- water-year month (engine 1.116.0, docs/model.md §2.6b, docs/data-model.md
-- § Nodes).
--
-- node.reach_loss_frac_monthly: the bed losses' share of the flow by
--   water-year month (Oct-Sep, 12 values in [0, 1]). When set it replaces
--   reach_loss_frac, which is then inert; 0 in a month = no loss that month.
-- node.reach_loss_max_monthly_m3_day: the bed losses' cap (m3/day) by month
--   (12 values >= 0); replaces reach_loss_max_m3_day when set.
-- node.baseflow_loss_monthly_m3_day / baseflow_gain_monthly_m3_day: a unit's
--   base-flow loss and gain (m3/day) by month (12 values >= 0); each replaces
--   its one value (baseflow_loss_m3_day, baseflow_gain_m3_day) when set.
-- NULL (the default, every existing row) = the one value all year, so every
-- stored model runs as before.
--
-- Units only for the base flow and not on the outlet for the bed losses are
-- model rules (engine modelRuleIssues), checked by the API on save as for the
-- one values (203, 222); the table checks only what holds for every row: 12
-- values, none NULL, in range (the arrays' pattern of 114, with the NULL
-- element check, since a comparison with NULL is unknown and a CHECK passes
-- unknown; 'Infinity' refused as in 222).
--
-- Columns on an existing project table (001's node): its RLS policies,
-- same-project trigger and the table grants to water_app already cover them,
-- and they add no foreign key, so no index. No view, function or trigger
-- lists node's columns (the model store, backend/src/model/store.ts, is the
-- one place that does). Expand only.

ALTER TABLE node
	ADD COLUMN reach_loss_frac_monthly double precision[]
		CONSTRAINT node_reach_loss_frac_monthly_range CHECK (reach_loss_frac_monthly IS NULL OR (cardinality(reach_loss_frac_monthly) = 12 AND array_position(reach_loss_frac_monthly, NULL) IS NULL AND 0 <= ALL (reach_loss_frac_monthly) AND 1 >= ALL (reach_loss_frac_monthly))),
	ADD COLUMN reach_loss_max_monthly_m3_day double precision[]
		CONSTRAINT node_reach_loss_max_monthly_size CHECK (reach_loss_max_monthly_m3_day IS NULL OR (cardinality(reach_loss_max_monthly_m3_day) = 12 AND array_position(reach_loss_max_monthly_m3_day, NULL) IS NULL AND 0 <= ALL (reach_loss_max_monthly_m3_day) AND 'Infinity'::double precision > ALL (reach_loss_max_monthly_m3_day))),
	ADD COLUMN baseflow_loss_monthly_m3_day double precision[]
		CONSTRAINT node_baseflow_loss_monthly_size CHECK (baseflow_loss_monthly_m3_day IS NULL OR (cardinality(baseflow_loss_monthly_m3_day) = 12 AND array_position(baseflow_loss_monthly_m3_day, NULL) IS NULL AND 0 <= ALL (baseflow_loss_monthly_m3_day) AND 'Infinity'::double precision > ALL (baseflow_loss_monthly_m3_day))),
	ADD COLUMN baseflow_gain_monthly_m3_day double precision[]
		CONSTRAINT node_baseflow_gain_monthly_size CHECK (baseflow_gain_monthly_m3_day IS NULL OR (cardinality(baseflow_gain_monthly_m3_day) = 12 AND array_position(baseflow_gain_monthly_m3_day, NULL) IS NULL AND 0 <= ALL (baseflow_gain_monthly_m3_day) AND 'Infinity'::double precision > ALL (baseflow_gain_monthly_m3_day)));

COMMENT ON COLUMN node.reach_loss_frac_monthly IS
	'Bed losses: share of the flow lost by water-year month (Oct-Sep, 12 values in [0, 1]); replaces reach_loss_frac when set; NULL = that one share all year. Engine >= 1.116.0, docs/model.md 2.6b.';
COMMENT ON COLUMN node.reach_loss_max_monthly_m3_day IS
	'Bed losses: cap (m3/day) by water-year month (12 values >= 0); replaces reach_loss_max_m3_day when set; NULL = that one cap (or none) all year. Engine >= 1.116.0.';
COMMENT ON COLUMN node.baseflow_loss_monthly_m3_day IS
	'Base-flow loss (m3/day) by water-year month (12 values >= 0); replaces baseflow_loss_m3_day when set; NULL = that one value all year. Units only. Engine >= 1.116.0.';
COMMENT ON COLUMN node.baseflow_gain_monthly_m3_day IS
	'Base-flow gain (m3/day) by water-year month (12 values >= 0); replaces baseflow_gain_m3_day when set; NULL = that one value all year. Units only. Engine >= 1.116.0.';
