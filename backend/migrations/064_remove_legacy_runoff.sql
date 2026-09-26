-- 064_remove_legacy_runoff — engine 1.0.0 removes the legacy b023 recession
-- runoff model (issue #16; docs/engine-audit.md H1, docs/model.md §2.4).
-- GR4J is the only runoff model.
--
-- Project settings only. Stored runs (model_run.inputs) are left as they
-- are: a run whose settings say 'legacy', or name no runoff model, ran the
-- legacy model and stays readable, badged, never re-run; the API still
-- refuses to nominate, sign or publish one. Scenario ops are left alone too:
-- they are hashed (scenario.ops_sha256), and the engine refuses an op on a
-- retired path with a reason the scenario shows.
--
-- The engine and the API do the same to settings they read
-- (engine prepare.ts mergeSettings, backend projects/settings.ts
-- mergeSettings); this makes the stored rows say what runs:
--  * settings.runoffModel 'legacy' (or anything but 'gr4j') becomes 'gr4j';
--  * settings.calibration loses the legacy model's keys (engine
--    RETIRED_CALIBRATION_KEYS), keeping the rain threshold and catchment
--    area;
--  * settings.fitRecord of another model than GR4J (a legacy fit) is
--    cleared: it describes parameters that no longer exist.

UPDATE project
SET settings = jsonb_set(settings, '{runoffModel}', '"gr4j"')
WHERE settings ? 'runoffModel' AND settings->>'runoffModel' IS DISTINCT FROM 'gr4j';

UPDATE project
SET settings = jsonb_set(
	settings,
	'{calibration}',
	(settings->'calibration') - ARRAY[
		'a', 'b', 'summerFactor', 'winterFactor', 'summerMonths', 'baseFlowInitial', 'baseResetRatio',
		'winterTodayRainMm', 'winterNextDayRainMm', 'shiftPeakIndexLo', 'shiftPeakIndexHi', 'amplitudeM3Day',
		'recessionDaysMax', 'recessionFactors', 'recessionCurveM3Day'
	]::text[]
)
WHERE jsonb_typeof(settings->'calibration') = 'object'
	AND (settings->'calibration') ?| ARRAY[
		'a', 'b', 'summerFactor', 'winterFactor', 'summerMonths', 'baseFlowInitial', 'baseResetRatio',
		'winterTodayRainMm', 'winterNextDayRainMm', 'shiftPeakIndexLo', 'shiftPeakIndexHi', 'amplitudeM3Day',
		'recessionDaysMax', 'recessionFactors', 'recessionCurveM3Day'
	]::text[];

UPDATE project
SET settings = jsonb_set(settings, '{fitRecord}', 'null'::jsonb)
WHERE jsonb_typeof(settings->'fitRecord') = 'object'
	AND settings->'fitRecord'->>'model' IS DISTINCT FROM 'gr4j';
