-- 309_reference_load_quaternaries — a production load of the quaternary
-- dataset records its file too (docs/maps.md § Quaternary dataset;
-- docs/deployment.md § Reference datasets).
--
-- In this file:
--  * reference_load (192, latest 269) takes the kind 'quaternaries': the
--    migrate Lambda's reference load (geo/referenceLoad.ts REFERENCE_KINDS)
--    now loads the DWS quaternary outlines with their WR2012 reference values
--    into quaternary_reference (152), allowed by the operator's decision of
--    2026-11-02 (docs/maps.md § Sources). Each load records the bucket file it
--    read and its SHA-256 in the replace's transaction (loadQuaternaries.ts
--    replaceDataset), as the other kinds' loads do. No new table, column or
--    grant: reference_load stays owner-only.
--  * The list keeps every earlier kind (referenceLoad.db.test.ts inserts a row
--    of each kind production allows).

ALTER TABLE reference_load DROP CONSTRAINT reference_load_kind_check;
ALTER TABLE reference_load ADD CONSTRAINT reference_load_kind_check
	CHECK (kind IN ('land-cover', 'evaporation', 'rivers', 'gazetteer', 'map-grid', 'tiles', 'waterbodies', 'dws', 'soils', 'gr4j-donors', 'quaternaries'));
