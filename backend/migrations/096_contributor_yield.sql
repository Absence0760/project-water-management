-- 096_contributor_yield — an applicant (a contributor, 044/045, WP-3.3)
-- calculates the firm yield or storage–yield curve of a dam of their own
-- application (roadmap WP-3.6: "a contributor, for a job on a scenario they
-- own"; docs/followups.md § Firm yield; issue #73).
--
-- Until now a contributor read no job and no yield result
-- (scenarios/contributor-tables.db.test.ts). Everything here is an extra
-- *permissive* policy beside the existing ones (016/023's job_select and
-- job_insert, 040/045's yield_result policies stay as they are), so nobody
-- else gains or loses anything:
--
--   job            a contributor queues a `yield` job as themselves on an
--                  application they own, for one of its dams they may see
--                  (app_contributor_yield_target), and reads their own yield
--                  jobs (status and progress). Never a job of another kind,
--                  another person's job, or a job on a saved run.
--   yield_result   a contributor inserts, reads and deletes (the handler keeps
--                  the newest few) only the results they computed themselves,
--                  on such a target. An assessor's yield on the same
--                  application (possibly of a dam hidden from the applicant)
--                  stays hidden from them.
--
-- The dams they may see: their farm links on the application
-- (app_application_own_nodes, 071) and the nodes its own `node.add` ops add.
-- The API narrows the second further (yield/store.ts yieldInputFor): an added
-- node whose id is a hidden node's (the engine's `reIds`) is refused with the
-- same words as an unknown id, so no answer tells a hidden id from a free one.
-- The job handler repeats that check as the acting user, so the job dies once
-- they lose the role or the application (fail closed, as every job does).

-- Whether the current user is a contributor who owns this application and may
-- calculate this node's yield on it. Text arguments, so a policy can pass a
-- job payload's fields without a cast that could fail on a bad value.
CREATE FUNCTION app_contributor_yield_target(p_project uuid, p_scenario text, p_node text) RETURNS boolean
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		s record;
	BEGIN
		IF p_scenario IS NULL OR p_node IS NULL OR NOT app_is_contributor(p_project) THEN
			RETURN false;
		END IF;
		SELECT id, ops INTO s FROM scenario
		WHERE id::text = p_scenario AND project_id = p_project AND origin = 'applicant' AND owner_user_id = app_current_user_id();
		IF NOT FOUND THEN
			RETURN false;
		END IF;
		RETURN p_node = ANY (app_application_own_nodes(s.id)::text[])
			OR EXISTS (SELECT 1 FROM jsonb_array_elements(s.ops) o WHERE o->>'op' = 'node.add' AND o->'node'->>'id' = p_node);
	END
	$$;
GRANT EXECUTE ON FUNCTION app_contributor_yield_target(uuid, text, text) TO water_app;

-- ---------------------------------------------------------------------------
-- job
-- ---------------------------------------------------------------------------
CREATE POLICY job_select_contributor ON job FOR SELECT
	USING (kind = 'yield' AND acting_user_id = app_current_user_id() AND app_is_contributor(project_id));
CREATE POLICY job_insert_contributor ON job FOR INSERT
	WITH CHECK (
		kind = 'yield'
		AND acting_user_id = app_current_user_id()
		AND payload->>'runId' IS NULL
		AND app_contributor_yield_target(project_id, payload->>'scenarioId', payload->>'nodeId')
	);

-- ---------------------------------------------------------------------------
-- yield_result (created_by is stamped from the session by yield_result_guard)
-- ---------------------------------------------------------------------------
CREATE POLICY yield_result_select_contributor ON yield_result FOR SELECT
	USING (created_by = app_current_user_id() AND scenario_id IS NOT NULL AND app_contributor_yield_target(project_id, scenario_id::text, node_id::text));
CREATE POLICY yield_result_insert_contributor ON yield_result FOR INSERT
	WITH CHECK (created_by = app_current_user_id() AND scenario_id IS NOT NULL AND app_contributor_yield_target(project_id, scenario_id::text, node_id::text));
CREATE POLICY yield_result_delete_contributor ON yield_result FOR DELETE
	USING (created_by = app_current_user_id() AND scenario_id IS NOT NULL AND app_contributor_yield_target(project_id, scenario_id::text, node_id::text));
