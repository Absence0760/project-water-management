-- 006_farm_dam_ops — farm and dam operating rules (engine 0.14.0).
--
-- Decided on persona recommendation (simulated hydrologist + licensing
-- assessor reviews, 2026-09-24), pending the real hydrologist. Each block names
-- its finding in docs/engine-audit.md; the formulas are in docs/model.md §2.6–2.7.
-- New columns sit on existing tables, so the table-level grants to water_app in
-- 001 and the existing RLS policies already cover them.

-- ---------------------------------------------------------------------------
-- Q5: node.dam_min_pct is now the dam's minimum operating level (dead
-- storage): irrigation draws only the storage above capacity × dam_min_pct,
-- and a transfer keeps at least that much in its source dam. The value the
-- workbook importer stored here was the workbook's *transfer* minimum, which
-- every transfer rule already carries as min_storage_pct, so it is reset to 0
-- (irrigation may empty the dam, as before): no stored result changes meaning.
-- ---------------------------------------------------------------------------
UPDATE node SET dam_min_pct = 0 WHERE dam_min_pct <> 0;
COMMENT ON COLUMN node.dam_min_pct IS
	'Minimum operating level (dead storage) as a fraction of capacity: irrigation draws only above it; transfers keep MAX(rule minimum, this). Engine >= 0.14.0.';
