-- 238_reference_load_map_grid — a production load of a MAP grid records its
-- file too (issue #560; docs/deployment.md § Reference datasets, Which file is
-- loaded).
--
-- In this file:
--  * reference_load (192, widened by 225) takes the kind 'map-grid': the
--    Southwestern Cape MAP surface (WAAS, 2007) is the first MAP grid the
--    production loader allows (geo/referenceLoad.ts REFERENCE_KINDS, the
--    operator's decision of 2026-10-23 in docs/legal/map-data-licences.md),
--    and each load records the bucket file it read, in the replace's
--    transaction (geo/rainMap.ts replaceRainMapDataset), as the other kinds'
--    loads do. No new table, column or grant: reference_load stays owner-only.

ALTER TABLE reference_load DROP CONSTRAINT reference_load_kind_check;
ALTER TABLE reference_load ADD CONSTRAINT reference_load_kind_check CHECK (kind IN ('land-cover', 'evaporation', 'rivers', 'gazetteer', 'map-grid'));
