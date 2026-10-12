-- 222_unit_baseflow — a unit's base-flow loss and gain (engine 1.86.0, issue
-- #523 B1, #90 R4 (a), docs/model.md §2.6b).
--
-- node.baseflow_loss_m3_day: m3/day of the unit's own runoff lost to
--   groundwater before it reaches the river or the unit's dam, at most the
--   day's runoff (MIN(loss, runoff)); the lost water leaves the catchment.
-- node.baseflow_gain_m3_day: m3/day joining the unit's runoff every day from
--   outside the modelled catchment (a spring, a regional aquifer).
-- Both 0 (the default, every existing row) = none, so every stored model runs
-- as before. Units only: the API and the model rules refuse them on a gauge
-- or an other water user (the engine ignores them there, with a warning).
--
-- Columns on an existing project table (001's node): its RLS policies,
-- same-project trigger and the table grants to water_app already cover them,
-- and they add no foreign key, so no index. No view, function or trigger
-- lists node's columns (the model store, backend/src/model/store.ts, is the
-- one place that does). Expand only.

ALTER TABLE node
	ADD COLUMN baseflow_loss_m3_day double precision NOT NULL DEFAULT 0
		CONSTRAINT node_baseflow_loss_size CHECK (baseflow_loss_m3_day >= 0 AND baseflow_loss_m3_day < 'Infinity'::double precision),
	ADD COLUMN baseflow_gain_m3_day double precision NOT NULL DEFAULT 0
		CONSTRAINT node_baseflow_gain_size CHECK (baseflow_gain_m3_day >= 0 AND baseflow_gain_m3_day < 'Infinity'::double precision);

COMMENT ON COLUMN node.baseflow_loss_m3_day IS
	'Base-flow loss: m3/day of a unit''s own runoff lost to groundwater, MIN(this, runoff), out of the catchment; 0 = none. Units only. Engine >= 1.86.0, docs/model.md 2.6b.';
COMMENT ON COLUMN node.baseflow_gain_m3_day IS
	'Base-flow gain: m3/day joining a unit''s runoff every day from outside the catchment; 0 = none. Units only. Engine >= 1.86.0, docs/model.md 2.6b.';
