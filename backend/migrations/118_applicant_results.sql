-- 118_applicant_results — the applicant's view of results (roadmap WP-3.3,
-- D2's recommended default; docs/scenarios.md § Applications,
-- docs/followups.md § Applicants; issue #73).
--
-- An applicant (a contributor, 044/045) runs their application but reads no
-- run row (046): its `inputs` and `summary` hold every farm. The results they
-- see are a projection the server builds from the run and its base
-- (scenarios/applicantResults.ts), the way it builds the base's
-- (scenarios/applicant.ts): catchment figures and series under the k rule,
-- their own units, every EWR site, and other units downstream only as an
-- anonymous name and a rounded percentage.
--
--   app_run_all_proposals
--                     new, plain SQL: whether a run's recorded scenario ops were
--                     all proposals (each classed `proposal`, one class per
--                     op). The share link's rule (115): a baseline assumption
--                     can change another unit's inputs (its demand set to 0, a
--                     neighbour's dam removed), so every figure that moves with
--                     it (the catchment's flow, the applicant's own supply, a
--                     neighbour's delta) could read that unit's values out.
--   app_application_run_results
--                     new, SECURITY DEFINER: one application run's summary,
--                     recorded scenario and stored model, its base's summary
--                     (when the base is a published run of the project) and
--                     the k rule, for the server, for whoever reads the
--                     application (app_scenario_readable) as a contributor or
--                     above. The API projects it and never returns it, as it
--                     does app_published_run_input's (045).
--   app_contributor_scenario_runs, app_contributor_run_nodes
--                     from their latest definitions (045, 071), with
--                     app_run_all_proposals: of an application run whose ops
--                     weren't all proposals a contributor now reads no series,
--                     neither the catchment's nor their own units'. Before,
--                     RLS let them read both (no route served them), which a
--                     baseline op on a hidden farm turns into an oracle.

-- ---------------------------------------------------------------------------
-- app_run_all_proposals: pure, over a run's `inputs`. A run with no recorded
-- classes (not a scenario run, or one from before they were recorded) is not
-- all proposals: nothing says so.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_run_all_proposals(p_inputs jsonb) RETURNS boolean
	LANGUAGE sql IMMUTABLE SET search_path = public
	AS $$
	SELECT coalesce(
		jsonb_typeof(p_inputs->'scenario'->'classified') = 'array'
		AND jsonb_typeof(p_inputs->'scenario'->'ops') = 'array'
		AND jsonb_array_length(p_inputs->'scenario'->'classified') = jsonb_array_length(p_inputs->'scenario'->'ops')
		AND NOT EXISTS (
			SELECT 1 FROM jsonb_array_elements(p_inputs->'scenario'->'classified') c
			WHERE c.value IS DISTINCT FROM '"proposal"'::jsonb
		),
		false
	)
	$$;

-- ---------------------------------------------------------------------------
-- app_application_run_results: for the server only (module comment).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_application_run_results(p_project uuid, p_scenario uuid, p_run uuid)
	RETURNS TABLE (
		label text,
		engine_version text,
		start_date date,
		end_date date,
		created_at timestamptz,
		scenario jsonb,
		model jsonb,
		summary jsonb,
		base_run_id uuid,
		base_start_date date,
		base_summary jsonb,
		all_proposals boolean,
		farm_holders_ok boolean
	)
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NOT app_has_role(p_project, 'contributor') OR NOT app_scenario_readable(p_scenario) THEN
			RETURN;
		END IF;
		RETURN QUERY
			SELECT r.label, r.engine_version, r.start_date, r.end_date, r.created_at,
				r.inputs->'scenario', r.inputs->'model', r.summary,
				b.id, b.start_date, b.summary,
				app_run_all_proposals(r.inputs),
				-- app_share_series' k (025): at least 5 farm holders, counted from nobody's point of view.
				(SELECT count(DISTINCT coalesce(
					(SELECT min(fl.user_id::text) FROM farm_link fl WHERE fl.node_id = n.id),
					'node:' || n.id::text
				)) >= 5 FROM node n WHERE n.project_id = p_project AND n.kind = 'farm')
			FROM model_run r
			JOIN scenario s ON s.id = r.scenario_id AND s.project_id = p_project AND s.origin = 'applicant'
			-- The base only when a publication of the project names it (an application's base always is one).
			LEFT JOIN model_run b ON b.id::text = r.inputs->'scenario'->>'baseRunId' AND b.project_id = p_project AND b.scenario_id IS NULL
				AND EXISTS (SELECT 1 FROM run_publication p WHERE p.run_id = b.id AND p.project_id = p_project)
			WHERE r.id = p_run AND r.project_id = p_project AND r.scenario_id = p_scenario;
	END
	$$;
REVOKE ALL ON FUNCTION app_application_run_results(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_application_run_results(uuid, uuid, uuid) TO water_app;

-- ---------------------------------------------------------------------------
-- app_contributor_scenario_runs, from 045: only runs whose ops were all
-- proposals. Used only by run_series_select_contributor (046), for the
-- catchment series of an application run.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_contributor_scenario_runs() RETURNS SETOF uuid
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
	BEGIN
		-- Most readers are no contributor anywhere: one index probe, and done.
		IF NOT EXISTS (SELECT 1 FROM project_member WHERE user_id = uid AND role = 'contributor') THEN
			RETURN;
		END IF;
		RETURN QUERY
			SELECT r.id FROM scenario s JOIN model_run r ON r.scenario_id = s.id
			WHERE s.origin = 'applicant'
			  AND (s.owner_user_id = uid OR EXISTS (SELECT 1 FROM scenario_member m WHERE m.scenario_id = s.id AND m.user_id = uid))
			  AND app_is_contributor(s.project_id)
			  AND app_run_all_proposals(r.inputs);
	END
	$$;

-- ---------------------------------------------------------------------------
-- app_contributor_run_nodes, from 071: the same rule for their own units'
-- series of an application run.
-- ---------------------------------------------------------------------------
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
			  AND app_run_all_proposals(r.inputs)
			  -- Still the application's owner's farm (071).
			  AND EXISTS (SELECT 1 FROM farm_link f WHERE f.project_id = s.project_id AND f.user_id = s.owner_user_id AND f.node_id = o.node_id);
	END
	$$;
