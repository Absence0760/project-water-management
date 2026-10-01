-- 137_allocation_water_use — which NWA s21 water use an allocation registers
-- (issue #72, docs/allocations.md § Importing), forward from 038_allocations
-- and 136_allocation_authorisation.
--
-- WARMS registers water per s21 water use, per property: a dam's storage
-- (s21(b)) is its own row, and that row's "registered volume" is the dam's
-- capacity, not a volume taken per year. Read as a take, it would have been
-- compared with abstraction, and a cap run would have held the farm to it.
--
-- In this file:
--  * `allocation.water_use`: '21a' (taking water: the volume is m³ a year
--    taken) or '21b' (storing water: only the storage counts). Existing rows
--    are takes, the only kind the app stored before (DEFAULT '21a').
--  * A '21b' row is storage only: volume 0, a storage stated, surface water
--    (a dam stores surface water). The engine never counts it as a take
--    (AllocationEntry.waterUse, engine 1.59.0); the storage comparison does.
--
-- Expand only: the column has a default, so code from before this migration
-- still writes valid rows (as takes). A new column on an existing table: RLS,
-- the policies (038) and `GRANT … TO water_app` (table-level, 038) already
-- cover it; restated below so this file reads on its own.

ALTER TABLE allocation ADD COLUMN water_use text NOT NULL DEFAULT '21a'
	CHECK (water_use IN ('21a', '21b'));
ALTER TABLE allocation ADD CONSTRAINT allocation_storage_only_check
	CHECK (water_use = '21a' OR (volume_m3_year = 0 AND storage_m3 IS NOT NULL AND water_source = 'surface'));

COMMENT ON COLUMN allocation.water_use IS
	'NWA s21 water use: 21a taking water (volume_m3_year is a take per year) or 21b storing water (storage only: volume 0, storage_m3 stated, surface). Issue #72, 137.';

-- Unchanged from 038; restated for this file's reader.
GRANT SELECT, INSERT, UPDATE, DELETE ON allocation TO water_app;
