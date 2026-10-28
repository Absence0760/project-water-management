-- 258_reference_load_dws — a production load of DWS verified daily flow
-- records its file too (issue #618 step 6b; docs/deployment.md § DWS gauge
-- records, Loading DWS's records in production).
--
-- In this file:
--  * reference_load (192, latest 248) takes the kind 'dws': the migrate
--    Lambda's reference load (geo/referenceLoad.ts REFERENCE_KINDS) now
--    writes one river gauge's DWS daily flow table into the gauge record
--    store (247, gauge_record_write, source dws-request, origin dws), allowed
--    since the client's hydrologist obtained DWS's permission to store it
--    (2026-10-28, #618 step 6a; docs/data-sources.md § dws-flow). Each load
--    records the bucket file it read and its SHA-256 under the operator's
--    label for that file, in the same transaction as the rows, as the other
--    kinds' loads do. No new table, column or grant: reference_load stays
--    owner-only, and gauge_record keeps its own writers' functions.
--  * The list also names 'waterbodies', the kind PR #606 adds (its own
--    migration widens this constraint too), so whichever of the two runs
--    last keeps both. A later migration that redefines the constraint must
--    keep every allowed kind: referenceLoad.db.test.ts inserts a row of each
--    REFERENCE_KINDS kind production allows.

ALTER TABLE reference_load DROP CONSTRAINT reference_load_kind_check;
ALTER TABLE reference_load ADD CONSTRAINT reference_load_kind_check
	CHECK (kind IN ('land-cover', 'evaporation', 'rivers', 'gazetteer', 'map-grid', 'tiles', 'waterbodies', 'dws'));
