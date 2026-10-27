-- 244_allocation_irrigated_area — the irrigated area an allocation registers
-- (docs/allocations.md § What is stored), forward from 038_allocations and
-- 142_allocation_water_use.
--
-- A WARMS registration of irrigation states the area irrigated beside the
-- volume taken, and a licence often does too. The app stored only the
-- volume, so the area a unit is registered to irrigate couldn't be put next
-- to the area the model irrigates.
--
-- In this file:
--  * `allocation.irrigated_area_ha`: the registered irrigated area, ha, or
--    NULL when none is stated (every existing row). 0 to under 10 000 000.
--  * Only a take (21a) states one: a 21(b) row is a dam's storage, and an
--    area there would be counted twice beside the property's take.
--
-- Not a model input: the engine never reads it (runs/execute.ts
-- allocationsForRun), so a change to it leaves the latest run current.
--
-- Expand only: the column is nullable, and code from before this migration
-- never writes it, so its rows meet the check. A new column on an existing
-- table: RLS, the policies (038, 231) and `GRANT … TO water_app`
-- (table-level, 038) already cover it; restated below so this file reads on
-- its own.

ALTER TABLE allocation ADD COLUMN irrigated_area_ha double precision
	CHECK (irrigated_area_ha IS NULL OR (irrigated_area_ha >= 0 AND irrigated_area_ha < 10000000));
ALTER TABLE allocation ADD CONSTRAINT allocation_irrigated_area_take_check
	CHECK (irrigated_area_ha IS NULL OR water_use = '21a');

COMMENT ON COLUMN allocation.irrigated_area_ha IS
	'Registered irrigated area, ha (NULL = none stated). A take (21a) only; never read by the model. docs/allocations.md.';

-- Unchanged from 038; restated for this file's reader.
GRANT SELECT, INSERT, UPDATE, DELETE ON allocation TO water_app;
