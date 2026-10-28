-- 270_calibration_sites — engine 1.106.0 calibrates at several gauges, upstream
-- units first (issue #555; docs/model.md §2.10n, docs/data-model.md § Project
-- settings). settings.calibrationZones lists the gauges inside the network
-- that calibrate the land units draining to them on their own record: each
-- row { nodeId, enabled, calibrationStart, calibrationEnd, calibrationFlowKind,
-- calibrationExclusions, qualityFlags, gr4j, fitRecord } (engine
-- calibrate/zones.ts CalibrationZone).
--
-- Expand half of expand/contract, and nothing to contract: the calibration
-- site's own zone (the outlet's, or Scored at's gauge, the zone of every unit
-- no ticked gauge above claims) keeps today's keys — calibrationSiteNodeId,
-- calibrationStart / calibrationEnd, calibrationFlowKind,
-- calibrationExclusions, qualityFlags, gr4j and fitRecord — which every reader
-- (runs, fits, the report, the evidence pack, the uncertainty ensemble,
-- automated calibration, the assistant's tools) still reads. So today's single
-- site and parameters ARE the new shape's one zone, and no key is retired.
-- This writes the list itself, empty (only the outlet, or the site, ticked:
-- one parameter set, exactly as before), into every project that has none,
-- so every stored project carries the new shape. The engine reads [] as no
-- zone (prepare.ts mergeSettings drops it), so no run changes: runs and fits
-- are bit-identical across it (backend/src/model/examples.zones.test.ts).
--
-- Project settings only. Stored runs (model_run.inputs) and model revisions
-- keep their JSON as records of the past (a snapshot without the key ran one
-- parameter set, and the run comparison reads [] and absent alike, engine
-- compare.ts). team.settings holds no calibration settings. Data only: no
-- table, policy, function or grant changes, so no RLS change.

UPDATE project
SET settings = jsonb_set(settings, '{calibrationZones}', '[]'::jsonb)
WHERE jsonb_typeof(settings) = 'object' AND NOT (settings ? 'calibrationZones');
