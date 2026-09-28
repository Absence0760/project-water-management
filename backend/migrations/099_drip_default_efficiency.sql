-- 099_drip_default_efficiency — a new farm's irrigation efficiency defaults to
-- drip (0.9) instead of 0.8. Latest definition of the column: 006_farm_dam_ops
-- (NOT NULL DEFAULT 0.8, CHECK 0 < e <= 1; the CHECK is unchanged).
--
-- Why: the client chose drip as the default irrigation system (issue #90,
-- answering issue #54 Q10), at SABI 2021 Table 4's drip value, 0.90 (engine
-- IRRIGATION_SYSTEMS). The app always writes the efficiency when it saves a
-- node (model/store.ts), so the column default only reaches a row inserted
-- without it; it matches the engine's NEW_FARM_IRRIGATION so the two can't
-- disagree. Only the default changes: every stored row keeps its value, so no
-- saved project or run changes.
ALTER TABLE node ALTER COLUMN irrigation_efficiency SET DEFAULT 0.9;
COMMENT ON COLUMN node.irrigation_efficiency IS
	'Irrigation application efficiency e (0 < e <= 1): abstraction demand = crop requirement / e. Engine >= 0.16.0. Default 0.9, drip (095).';
