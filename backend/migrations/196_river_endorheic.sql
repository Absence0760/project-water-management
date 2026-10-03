-- 196_river_endorheic — whether a river reach drains to the sea, for the
-- pans' cross-check (the follow-up "Cross-check a pan against the river
-- network"; backend/src/delineation/pans.ts, panReference.ts;
-- docs/design/pans-research.md § Storage on a river, docs/maps.md § River
-- network).
--
-- A closed depression of the DEM that holds over 100 mm of its catchment's
-- runoff is reported as a pan (193). A large dam low in a small catchment can
-- pass that test, so a candidate a mapped river flows through and out of is
-- storage on a river instead. HydroRIVERS is traced on HydroSHEDS' filled
-- DEM, so its lines run through most pans too; what tells them apart is
-- HydroSHEDS' own ENDORHEIC flag: a reach in a basin that drains to an inland
-- sink (a pan) is 1, one that reaches the sea is 0. Measured around
-- Bultfontein (2026-10-03), every reach counted cut the depressions flagged
-- from 68 of 179 to 19; counting only those that reach the sea is the
-- defensible rule.
--
-- In this file:
--  * river_reference.endorheic: the reach's ENDORHEIC flag as loaded
--    (loadRivers.ts reads ENDORHEIC or `endorheic`); NULL when the source
--    doesn't give it, and for every row loaded before this migration, which
--    the cross-check doesn't use until the operator loads the network again
--    (`pnpm dev:tiles:rivers`, or a production reference load).
--  * No new table, policy, grant or function: the column inherits 171's RLS
--    (anyone signed in reads it) and water_app's SELECT grant.

ALTER TABLE river_reference ADD COLUMN endorheic boolean;

COMMENT ON COLUMN river_reference.endorheic IS
	'HydroSHEDS'' ENDORHEIC flag: true in a basin draining to an inland sink, false when the reach reaches the sea; NULL when the source gave none (and before 196). Read by the pans'' cross-check (panReference.ts), which counts only false.';
