-- An applicant's yield on a dam their application inserts on a reach (issue
-- #73, engine 1.35.0 `node.insert`): 096 let a contributor calculate the
-- yield of their own farm links and of the nodes their application's
-- `node.add` ops add. A `node.insert` op adds a node the same way (a new
-- structure on the reach, the proposal's own), so it counts too. Only the
-- op test changes; the rest is 096's definition as it was. The API applies
-- the same list (yield/store.ts yieldInputFor), refusing an added node whose
-- id is a hidden one's with the words an unknown id gets.
CREATE OR REPLACE FUNCTION app_contributor_yield_target(p_project uuid, p_scenario text, p_node text) RETURNS boolean
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
			OR EXISTS (SELECT 1 FROM jsonb_array_elements(s.ops) o WHERE o->>'op' IN ('node.add', 'node.insert') AND o->'node'->>'id' = p_node);
	END
	$$;
GRANT EXECUTE ON FUNCTION app_contributor_yield_target(uuid, text, text) TO water_app;
