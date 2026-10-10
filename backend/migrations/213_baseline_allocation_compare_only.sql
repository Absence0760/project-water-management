-- 213_baseline_allocation_compare_only — licence data never drives the baseline (issue #507).
--
-- The operator's principle (2026-10-10, issue #507): a project's baseline
-- abstractions come from the hydrologist's inputs only (crops and areas,
-- demand objects, pump and diversion capacities, boreholes). Registered and
-- licensed volumes are compared with the modelled use, never applied to it.
-- So `settings.allocationMode` stays 'none' (compare only) in a project's own
-- settings; the engine's 'cap' and 'fullAllocation' modes stay available to
-- scenarios (a settings.set op on allocationMode, docs/scenarios.md). From
-- this change the API refuses a save that caps or fully allocates the
-- baseline, and an import, a copy or a restore turns one into 'none'
-- (backend/src/projects/settings.ts normaliseBaselineAllocationMode).
--
-- A project stored with another mode is moved to 'none' here, and the move
-- is recorded on its History as a `settings.allocation_mode_reset` event
-- with the mode it had ({ from, to }), with no actor (a migration, not a
-- person). Its next run compares only; its earlier runs keep the mode they
-- ran with (model_run.inputs is a record of the past, as is every model
-- revision; restoring one turns its mode into 'none' on the way in).
-- Any non-'none' string is moved, an unknown one included: the engine
-- already ran an unknown mode as 'none' (resolveAllocationMode).
WITH moved AS (
	SELECT id, settings ->> 'allocationMode' AS mode
	FROM project
	WHERE jsonb_typeof(settings -> 'allocationMode') = 'string'
	  AND settings ->> 'allocationMode' <> 'none'
	FOR UPDATE
), reset AS (
	UPDATE project p
	SET settings = jsonb_set(p.settings, '{allocationMode}', '"none"')
	FROM moved
	WHERE p.id = moved.id
	RETURNING p.id
)
INSERT INTO audit_event (project_id, actor_user_id, actor_label, kind, subject)
SELECT moved.id, NULL, '', 'settings.allocation_mode_reset', jsonb_build_object('from', moved.mode, 'to', 'none')
FROM moved JOIN reset ON reset.id = moved.id;
