-- 197_return_flow_fraction — a farm's irrigation return flow as a share of
-- the water supplied (engine 1.71.0; docs/model.md §2.7, docs/engine-audit.md
-- N1).
--
-- 006 split the workbook's one return flow % into the irrigation efficiency e
-- and loss_return_fraction β, the share of the application losses
-- (1 − e) × supplied that returns to the river the same day. The client's
-- hydrologist (2026-10-03) defines the input instead as the share r of the
-- irrigation water supplied that infiltrates the soil and returns to the
-- river the same day: return flow = r × supplied. It comes out of the losses,
-- so r ≤ 1 − e; the rest of the losses leaves the catchment.
--
-- In this file:
--  * node.return_flow_fraction r, backfilled r = β × (1 − e), so every saved
--    model runs as before (to a bit or two; a unit whose crops carry their own
--    efficiency now returns r of all its supply, where β followed the crops'
--    blended losses). New farms default to 10 % (all of drip's losses at the
--    0.9 default from 099), the engine's NEW_FARM_IRRIGATION.
--  * A CHECK that r ≤ 1 − e (with float slack: 1 − 0.9 is 0.0999…98, and 10 %
--    at 90 % is all the losses), as the API's validation and the run's cap.
--  * loss_return_fraction dropped (not yet deployed, so no expand/contract
--    window; 006 did the same to return_flow_pct). Run snapshots and scenario
--    ops keep β in their JSON: the engine converts it when it reads them
--    (upgradeLegacyModel, scenario/ops.ts LEGACY_LOSS_RETURN_FIELD).
--  * No new table, policy, grant or function: the column inherits node's RLS
--    and water_app's table grants.

ALTER TABLE node
	ADD COLUMN return_flow_fraction double precision NOT NULL DEFAULT 0.1
		CHECK (return_flow_fraction >= 0 AND return_flow_fraction <= 1);

UPDATE node SET return_flow_fraction = loss_return_fraction * (1 - irrigation_efficiency);

ALTER TABLE node
	ADD CONSTRAINT node_return_flow_within_losses CHECK (return_flow_fraction <= 1 - irrigation_efficiency + 1e-9),
	DROP COLUMN loss_return_fraction;

COMMENT ON COLUMN node.return_flow_fraction IS
	'Share r of the irrigation water supplied that infiltrates the soil and returns to the river below the farm the same day (0 <= r <= 1 - irrigation_efficiency): return flow = r x supplied. The rest of the losses leaves the catchment. Engine >= 1.71.0; 006-196 stored the share of the losses, loss_return_fraction.';
