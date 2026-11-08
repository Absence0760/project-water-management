-- 316_evaporation_span_kind — an evaporation grid of Symons-pan (S-pan)
-- evaporation, stored and shown as a cross-check, never fed to the model
-- (issue #738; docs/maps.md § Evaporation from the map, § The evaporation
-- grid).
--
-- The client asked for CCWR's S-pan grid beside its MAP and A-pan grids. The
-- model's crop demand (A-pan × crop factor) and dam evaporation (A-pan × lake
-- factor) are calibrated on Class-A pan values, and turning S-pan into A-pan
-- needs a conversion the hydrologist picks (#738 step 2), so an S-pan grid is
-- proposed into nothing: Calibration → Evaporation from the map shows its
-- monthly S-pan over the boundary and the saved A-pan ÷ S-pan per month, and
-- POST …/evaporation-from-map refuses it.
--
-- In this file:
--  * evaporation_dataset.kind's CHECK (180, inline, so named
--    evaporation_dataset_kind_check) admits 'span' beside 'et0' and 'apan'.
--    Expand only: every stored row passes the new check, and a backend that
--    never writes 'span' is unaffected.
--  * evaporation_accepted (181) is unchanged: its kind stays 'et0' or 'apan'
--    and its target 'pe' or 'apan', so no S-pan value can be recorded as
--    accepted into a project.
--  * Nothing else changes: no new table or column, no policy and no grant.
--    The grid stays global reference data, read by any signed-in user and
--    written only by the operator as the schema owner (180's policies and
--    water_app's SELECT cover it).

ALTER TABLE evaporation_dataset DROP CONSTRAINT evaporation_dataset_kind_check;
ALTER TABLE evaporation_dataset ADD CONSTRAINT evaporation_dataset_kind_check CHECK (kind IN ('et0', 'apan', 'span'));

COMMENT ON COLUMN evaporation_dataset.kind IS
	'et0: FAO-56 reference ET, proposed as GR4J''s monthly PE; apan: Class-A pan, proposed as the A-pan row; span: Symons pan, shown as a cross-check against the saved A-pan only, never proposed or converted (316, issue #738).';
