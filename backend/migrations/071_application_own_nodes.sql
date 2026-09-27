-- 071_application_own_nodes — an application's own farms are its owner's
-- farm links, in the table and whenever an applicant reads them
-- (docs/security.md § Applicants; scenarios/applicant.security.db.test.ts).
--
-- An application's owned_node_ids (045) decide what its applicant and their
-- consultant see in full: the base projection (GET …/base,
-- scenarios/applicant.ts), the series of its runs
-- (app_contributor_run_nodes, 046), the check's mask and which ops are the
-- proposal. The route fills them from the owner's farm links (app_farm_nodes)
-- when the application is made or its ops change, but:
--
--   1. the table took any list: scenario_guard sets an application's owner
--      and origin, never checks its own nodes, so an insert or update as the
--      applicant past the route (the second layer RLS exists for) could name
--      a neighbour's farm as theirs, and read it in full through the base
--      and their runs' series; and the assessors' record would class ops on
--      that neighbour as the proposal;
--   2. a draft made while linked kept its list after the owner unlinked the
--      farm (it changed hands, or was linked by mistake): the former holder
--      went on reading that farm's figures in the base, rebased onto every
--      newer published run, and in their runs' series.
--
-- Now:
--   scenario_owned_nodes  new BEFORE INSERT OR UPDATE trigger (after
--                         scenario_guard, which sets the owner): an
--                         application's own nodes, when set or changed, are
--                         a subset of its owner's farm links, else 42501. A
--                         team scenario names what its modeller says.
--   app_application_own_nodes
--                         new, SECURITY DEFINER: an application's own nodes
--                         that are still its owner's farm links, for a caller
--                         who reads it (empty otherwise). What the API gives
--                         a contributor as ownedNodeIds (SCENARIO_SELECT); the
--                         stored list stays the assessors' record.
--   app_contributor_run_nodes
--                         from its only definition (046): the same
--                         intersection, so a run's series of a farm no longer
--                         linked to the application's owner read as none.

CREATE FUNCTION scenario_owned_nodes() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NEW.origin = 'applicant'
			AND (TG_OP = 'INSERT' OR NEW.owned_node_ids IS DISTINCT FROM OLD.owned_node_ids)
			AND EXISTS (
				SELECT 1 FROM unnest(NEW.owned_node_ids) AS o(node_id)
				WHERE NOT EXISTS (
					SELECT 1 FROM farm_link f WHERE f.project_id = NEW.project_id AND f.user_id = NEW.owner_user_id AND f.node_id = o.node_id
				)
			)
		THEN
			RAISE EXCEPTION 'an application''s own farms are its applicant''s farm links' USING ERRCODE = 'insufficient_privilege';
		END IF;
		RETURN NEW;
	END
	$$;
-- Named to fire after scenario_guard (BEFORE triggers run in name order),
-- which sets NEW.owner_user_id and NEW.origin on insert.
CREATE TRIGGER scenario_owned_nodes BEFORE INSERT OR UPDATE ON scenario
	FOR EACH ROW EXECUTE FUNCTION scenario_owned_nodes();

CREATE FUNCTION app_application_own_nodes(p_scenario uuid) RETURNS uuid[]
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		s record;
		out uuid[];
	BEGIN
		SELECT project_id, origin, status, owner_user_id, owned_node_ids INTO s FROM scenario WHERE id = p_scenario;
		IF NOT FOUND OR NOT app_scenario_visible(s.project_id, p_scenario, s.origin, s.status, s.owner_user_id) THEN
			RETURN '{}';
		END IF;
		SELECT coalesce(array_agg(o.node_id ORDER BY o.ord), '{}') INTO out
		FROM unnest(s.owned_node_ids) WITH ORDINALITY AS o(node_id, ord)
		WHERE EXISTS (SELECT 1 FROM farm_link f WHERE f.project_id = s.project_id AND f.user_id = s.owner_user_id AND f.node_id = o.node_id);
		RETURN out;
	END
	$$;

CREATE OR REPLACE FUNCTION app_contributor_run_nodes() RETURNS TABLE (run_id uuid, node_id uuid)
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
	BEGIN
		IF NOT EXISTS (SELECT 1 FROM project_member WHERE user_id = uid AND role = 'contributor') THEN
			RETURN;
		END IF;
		RETURN QUERY
			SELECT r.id, o.node_id
			FROM scenario s
			JOIN model_run r ON r.scenario_id = s.id
			CROSS JOIN LATERAL unnest(s.owned_node_ids) AS o(node_id)
			WHERE s.origin = 'applicant'
			  AND (s.owner_user_id = uid OR EXISTS (SELECT 1 FROM scenario_member m WHERE m.scenario_id = s.id AND m.user_id = uid))
			  AND app_is_contributor(s.project_id)
			  -- Still the application's owner's farm (071).
			  AND EXISTS (SELECT 1 FROM farm_link f WHERE f.project_id = s.project_id AND f.user_id = s.owner_user_id AND f.node_id = o.node_id);
	END
	$$;

REVOKE ALL ON FUNCTION scenario_owned_nodes(), app_application_own_nodes(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_application_own_nodes(uuid) TO water_app;
