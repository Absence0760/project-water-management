-- 264_retire_flow_share_method — engine 1.105.0 retires the flow-share methods
-- (issue #616; docs/model.md §2.5, docs/engine-audit.md FM1). Every unit has
-- one share, its natural MAR share: it splits the flow under Fragmentation,
-- the EWR, the land-cover low-flow threshold and the senior users' claims.
-- The client called fragmentation by area, Hi/Lo MAP and specific shares
-- obsolete, so settings.flowShareMethod ('area' | 'hiLo' | 'manual') and
-- settings.hiLoSplit have nothing left to choose, and the node's High-MAP
-- and Low-MAP areas (area_hi_km2, area_lo_km2) and manual share
-- (flow_share_manual) nothing left to feed.
--
-- Expand half of expand/contract (the 064 pattern for jsonb keys, 197/211
-- for columns). The backend from this release neither reads nor writes the
-- three node columns (model/store.ts; area_hi_km2 and area_lo_km2 are NOT
-- NULL DEFAULT 0 and flow_share_manual is nullable, so new rows take their
-- defaults); a later contract migration drops them once this release is in
-- production. Here the two settings keys are stripped from project.settings
-- (the engine and the API drop them on read too: engine prepare.ts
-- mergeSettings, backend projects/settings.ts mergeSettings). team.settings
-- never had them.
--
-- Decided by the operator (issue #619): a project on 'hiLo' or 'manual'
-- switches to the natural MAR shares on its next run. Nothing is lost
-- without a record: the project's History gets one
-- `settings.flow_share_reset` event, with no actor (a migration, not a
-- person), when its method was 'hiLo' or 'manual' or any of its nodes held a
-- High-MAP area, a Low-MAP area or a manual share. It lists what it was
-- (the 220 pattern):
--   { method: 'area' | 'hiLo' | 'manual' | null (never set: area),
--     hiLoSplit: { hi, lo } | null (never set: 50/50),
--     units: [{ id, name, areaHiKm2, areaLoKm2, flowShareManual }] }
-- where `units` holds each node with a value other than the column default
-- (0, 0, null), in the table's order (sort_order, name, id). The events are
-- written before the keys are stripped, from the same rows. The event is
-- written once per project (a re-run finds it and writes none).
--
-- Stored runs (model_run.inputs) and model revisions (model_revision) keep
-- the keys and fields in their JSON, as records of the past: an older run's
-- summary keeps its recorded flow shares, the evidence nomination still
-- refuses an older snapshot whose shares summed past 100 % (engine
-- legacy/flowShares.ts inputFlowShares), and the engine drops the fields from
-- any input it reads (upgradeLegacyModel), so a restored revision loses them.
-- Scenario ops on the retired paths are left alone too: they are hashed
-- (scenario.ops_sha256) and a decided scenario's are immutable (052); the
-- engine refuses them with a reason the scenario shows (RETIRED_SETTINGS_PATHS,
-- RETIRED_NODE_SET_FIELDS).
--
-- Data only: no table, policy, function or grant changes, so no RLS change.
-- The History reads the event through audit_event_select (viewer and up) and
-- app_audit_subject, which passes a settings.* subject unchanged.

INSERT INTO audit_event (project_id, actor_user_id, actor_label, kind, subject)
SELECT
	p.id,
	NULL,
	'',
	'settings.flow_share_reset',
	jsonb_build_object(
		'method', p.settings -> 'flowShareMethod',
		'hiLoSplit', p.settings -> 'hiLoSplit',
		'units', coalesce((
			SELECT jsonb_agg(
				jsonb_build_object('id', n.id, 'name', n.name, 'areaHiKm2', n.area_hi_km2, 'areaLoKm2', n.area_lo_km2, 'flowShareManual', n.flow_share_manual)
				ORDER BY n.sort_order, n.name, n.id
			)
			FROM node n
			WHERE n.project_id = p.id AND (n.area_hi_km2 <> 0 OR n.area_lo_km2 <> 0 OR n.flow_share_manual IS NOT NULL)
		), '[]'::jsonb)
	)
FROM project p
WHERE (
		p.settings ->> 'flowShareMethod' IN ('hiLo', 'manual')
		OR EXISTS (
			SELECT 1 FROM node n
			WHERE n.project_id = p.id AND (n.area_hi_km2 <> 0 OR n.area_lo_km2 <> 0 OR n.flow_share_manual IS NOT NULL)
		)
	)
	AND NOT EXISTS (SELECT 1 FROM audit_event e WHERE e.project_id = p.id AND e.kind = 'settings.flow_share_reset');

UPDATE project
SET settings = settings - ARRAY['flowShareMethod', 'hiLoSplit']
WHERE settings ?| ARRAY['flowShareMethod', 'hiLoSplit'];
