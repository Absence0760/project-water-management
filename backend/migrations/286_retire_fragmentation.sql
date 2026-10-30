-- 286_retire_fragmentation — engine 1.109.0 retires the Fragmentation flow
-- generation method (issue #658; docs/model.md §2.4h, docs/engine-audit.md
-- FM2). Per unit is the only method: every land unit runs GR4J on its own
-- rain. The client asked for the Fragmentation / Per unit choice to go, so
-- settings.unitRain's `catchment` mode (Fragmentation, also what an absent or
-- null setting meant) has nothing left to choose.
--
-- The forward path for a project on Fragmentation (migrations are forward
-- only, CLAUDE.md rule 2): its settings.unitRain becomes Per unit, keeping
-- whatever else it held (the gauge MAP and its source, the MAP period, the
-- reference gauge), so each land unit takes the rule its records imply
-- (§2.4h: its rainfall station, else its own gauge, else the catchment gauge
-- × unit MAP ÷ gauge MAP, else its own CHIRPS levelled to its MAP, else the
-- catchment rain, rule 4). A unit with no station, gauge, MAP or CHIRPS of
-- its own keeps running on the catchment rain, as it did, and the run names
-- it (Run readiness lists it before the run). Nothing else in the settings
-- moves. The engine runs absent, null and `catchment` as Per unit too
-- (resolveUnitRain), and the API stores a `catchment` it is sent as
-- `perUnit` (projects/settings.ts UnitRain), so a project this misses still
-- runs Per unit; this makes the stored setting say so.
--
-- The project's fit (settings.fitRecord, and each calibration zone's) was
-- made under Fragmentation: the engine reads such a fit (one from an engine
-- before 1.109.0 whose forcing records no per-unit rain) as "Parameters not
-- fitted for this method" (fitRecordStatus methodChanged, the caveat that
-- asks for a refit). Nothing here touches it: the parameters stay, and the
-- hydrologist refits.
--
-- Nothing is lost without a record: each project whose stored setting was
-- not Per unit gets one `settings.flow_method_reset` History event, with no
-- actor (a migration, not a person), holding what it was:
--   { unitRain: <the stored settings.unitRain, or null when never set>,
--     fitted: <whether the project had a fit record> }
-- written before the setting changes, from the same rows, once per project
-- (a re-run finds it and writes none).
--
-- Stored runs (model_run.inputs) and model revisions keep their settings as
-- records of the past: an older run still reads as Fragmentation (the run
-- comparison's "Runoff from each unit's own rain: off → on" line, engine
-- compare.ts storedPerUnit). A scenario can't set unitRain (no settings.set
-- path for it, 239), so no scenario op is touched. team.settings never held
-- it.
--
-- The match is null-safe (coalesce … false): a project with no unitRain key
-- at all is on Fragmentation too, and NOT of a null would skip it.
--
-- Data only: no table, policy, function or grant changes, so no RLS change.
-- The History reads the event through audit_event_select (viewer and up) and
-- app_audit_subject, which passes a settings.* subject unchanged.

INSERT INTO audit_event (project_id, actor_user_id, actor_label, kind, subject)
SELECT
	p.id,
	NULL,
	'',
	'settings.flow_method_reset',
	jsonb_build_object(
		'unitRain', coalesce(p.settings -> 'unitRain', 'null'::jsonb),
		'fitted', coalesce(jsonb_typeof(p.settings -> 'fitRecord') = 'object', false)
	)
FROM project p
WHERE NOT coalesce(jsonb_typeof(p.settings -> 'unitRain') = 'object' AND p.settings -> 'unitRain' ->> 'mode' = 'perUnit', false)
	AND NOT EXISTS (SELECT 1 FROM audit_event e WHERE e.project_id = p.id AND e.kind = 'settings.flow_method_reset');

UPDATE project
SET settings = jsonb_set(
	settings,
	'{unitRain}',
	CASE
		WHEN jsonb_typeof(settings -> 'unitRain') = 'object' THEN (settings -> 'unitRain') || '{"mode": "perUnit"}'::jsonb
		ELSE '{"mode": "perUnit"}'::jsonb
	END
)
WHERE NOT coalesce(jsonb_typeof(settings -> 'unitRain') = 'object' AND settings -> 'unitRain' ->> 'mode' = 'perUnit', false);
