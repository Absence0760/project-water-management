-- 061_crop_irrigation_efficiency — a crop's own irrigation efficiency
-- (issue #54 item 1, engine 0.43.0; docs/model.md §2.3, docs/data-model.md
-- § Crops).
--
-- Expand-only:
--
--   crop.irrigation_efficiency double precision, NULL by default: the
--   application efficiency of the irrigation system the crop is under
--   (drip, micro-sprinkler, pivot …), 0 < e ≤ 1. NULL = the farm's own
--   node.irrigation_efficiency, so every existing crop keeps running exactly
--   as before. The engine combines a farm's crops' efficiencies, weighted by
--   each crop's annual water requirement (packages/engine/src/demand.ts
--   farmIrrigationEfficiency). The CHECK matches the node column's bound
--   (006) and the API's validation (backend/src/model/validate.ts).
--
-- Access is unchanged: the crop policies (001, and crop_select_farmer, 020)
-- cover the whole row, and water_app's table-level grant on crop (001)
-- covers the new column.

ALTER TABLE crop
	ADD COLUMN irrigation_efficiency double precision CHECK (irrigation_efficiency > 0 AND irrigation_efficiency <= 1);
