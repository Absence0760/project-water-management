-- 047_scenario_op_names — the display names a scenario's ops need (roadmap
-- WP-3.2 follow-up; docs/scenarios.md § Backend, docs/data-model.md
-- § Scenarios).
--
-- An op targets a node or crop by id, and the editor names it from the base
-- run's model snapshot. After a rebase onto a run without that node, nothing
-- named it any more once the page was reloaded ("a node the base run doesn't
-- have"). The API now stores `{ id, name }` for every node and crop an op
-- names, taken from the base run's snapshot when the ops are written
-- (backend/src/scenarios/names.ts opNames): a name once known is kept while an
-- op still names that id, and the current base's name wins when it has one.
--
-- Expand-only:
--   * scenario.op_names jsonb, an array of { id, name } sorted by id. Display
--     only: not part of ops_sha256 or a run's snapshot. Written by the API
--     beside the ops (POST, PATCH with ops, rebase), so it changes only while
--     the scenario is a draft, like the ops.
--   * Applications (045, WP-3.3): an applicant sees every node but their own
--     under an anonymous name, so an application's op_names only ever holds
--     its own nodes' names (owned_node_ids, its owner's farm links). The API
--     writes it so, and filters what a contributor reads the same way
--     (names.ts applicantOpNames).
--   * Backfill: each existing scenario gets the names of the nodes and crops of
--     its base run's snapshot that its ops name (matched on the op fields
--     that hold ids, as backend/src/scenarios/schema.ts opIds lists them);
--     an application only its own nodes'. scenario_guard is disabled for the
--     backfill so updated_at keeps its value (and nothing else is checked:
--     the only column written is op_names).
--
-- RLS and grants: the column is on `scenario`, whose policies (viewer read,
-- editor write) and table-level grants to water_app (024_scenarios) cover it.
-- No function or foreign key is added.

ALTER TABLE scenario ADD COLUMN op_names jsonb NOT NULL DEFAULT '[]'::jsonb
	CHECK (jsonb_typeof(op_names) = 'array' AND jsonb_array_length(op_names) <= 2000 AND octet_length(op_names::text) <= 1048576);

COMMENT ON COLUMN scenario.op_names IS
	'Display names of the nodes and crops the ops name, [{ id, name }] sorted by id, from the base run''s snapshot when the ops were written (047_scenario_op_names). Keeps an op readable after a rebase drops its node. Display only.';

ALTER TABLE scenario DISABLE TRIGGER scenario_guard;
UPDATE scenario s SET op_names = coalesce((
	SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) ORDER BY t.id)
	FROM (
		SELECT DISTINCT ON (e->>'id') e->>'id' AS id, coalesce(e->>'name', '') AS name
		FROM model_run r
		CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.inputs->'model'->'nodes', '[]'::jsonb) || coalesce(r.inputs->'model'->'crops', '[]'::jsonb)) e
		WHERE r.id = s.base_run_id AND e->>'id' IS NOT NULL
		  AND jsonb_path_exists(
			s.ops,
			'$[*] ? (@.nodeId == $id || @.cropId == $id || @.node.id == $id || @.node.downstreamNodeId == $id
				|| @.transfer.fromNodeId == $id || @.transfer.toNodeId == $id || @.value == $id
				|| @.patch.nodeId == $id || @.borehole.nodeId == $id)',
			jsonb_build_object('id', e->>'id'))
		  AND (s.origin <> 'applicant' OR e->>'id' = ANY (s.owned_node_ids::text[]))
		ORDER BY e->>'id'
	) t
), '[]'::jsonb);
ALTER TABLE scenario ENABLE TRIGGER scenario_guard;
