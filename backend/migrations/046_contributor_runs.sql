-- 046_contributor_runs — a contributor (044, a licence applicant or their
-- consultant) no longer reads any model_run row, nor another farm's run
-- series (docs/followups.md § Applicants; docs/security.md § Applicants,
-- docs/scenarios.md § Applications).
--
-- 045 let a contributor read the rows of their own applications' runs, whose
-- `inputs` snapshot is the whole base with the ops applied (every farm's
-- parameters) and whose `summary` names every farm. The API never returned
-- them, but RLS can't hide a column, so a route that forgot to project, or
-- any `SELECT … FROM model_run` in a contributor's transaction, would. Now:
--
--   model_run_select  rewritten (045): a scenario run is read by whoever
--                     reads its scenario *and* is a viewer or above. A
--                     contributor reads no run row at all.
--   app_scenario_run_meta
--                     new, SECURITY DEFINER: the metadata of a scenario's runs
--                     (id, label, engine version, dates, scenario), for whoever
--                     reads the scenario. What a contributor's API reads of
--                     their runs (the scenario list's run count and last run,
--                     a new run's response); never `inputs` or `summary`.
--   app_trim_application_runs
--                     new, SECURITY DEFINER: the owner's per-application run
--                     cap. A DELETE needs its rows visible to a SELECT policy,
--                     so model_run_delete_contributor (045) can't work without
--                     the row read: dropped, replaced by this.
--   app_own_new_scenario_run
--                     new, SECURITY DEFINER: "a scenario run the current user
--                     made in this transaction", for the two insert policies
--                     below, whose EXISTS over model_run ran under the
--                     contributor's RLS and so needed the row read.
--   run_series_insert_contributor, run_input_series_insert_contributor
--                     rewritten (045) on that helper, same rule.
--   run_series_select_contributor
--                     rewritten (045). A contributor read *every* series of
--                     their application runs, including other farms' demand,
--                     supply and dam storage, which carry those farms'
--                     parameters (area × crop factor, dam capacity) that the
--                     applicant projection zeroes. Now, of an application run
--                     they read: the application's own nodes (owned_node_ids,
--                     its owner's farm links), and the catchment allowlist
--                     under the k rule, as for a published run. The
--                     published-run branch is unchanged.
--
-- What remains by design: app_published_run_input / app_published_run_series
-- (045) hand the server the published base's full input in a contributor's
-- transaction, so it can run their application; the API projects it
-- (scenarios/applicant.ts) and never returns it.

-- ---------------------------------------------------------------------------
-- Helpers. SECURITY DEFINER (they read model_run and scenario past RLS),
-- STABLE (bar the trim), search_path pinned, PL/pgSQL (026). EXECUTE: the
-- owner and water_app only (028's default privileges; stated here too).
-- ---------------------------------------------------------------------------

-- The metadata of a scenario's runs, newest first, for a caller who reads the
-- scenario (app_scenario_readable); anyone else gets no row. Never inputs or
-- summary: those hold every farm.
CREATE FUNCTION app_scenario_run_meta(p_project uuid, p_scenario uuid)
	RETURNS TABLE (id uuid, label text, engine_version text, start_date date, end_date date, created_at timestamptz, scenario_id uuid)
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NOT app_scenario_readable(p_scenario) THEN
			RETURN;
		END IF;
		RETURN QUERY
			SELECT r.id, r.label, r.engine_version, r.start_date, r.end_date, r.created_at, r.scenario_id
			FROM model_run r
			WHERE r.project_id = p_project AND r.scenario_id = p_scenario
			ORDER BY r.created_at DESC, r.id DESC;
	END
	$$;

-- Keep an application's newest p_keep runs (kept runs aside, app_run_kept),
-- deleting the rest; returns the ids deleted. Only its owner, while exactly a
-- contributor in the project (as 045's model_run_delete_contributor): anyone
-- else deletes nothing.
CREATE FUNCTION app_trim_application_runs(p_project uuid, p_scenario uuid, p_keep integer)
	RETURNS SETOF uuid
	LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF p_keep IS NULL OR p_keep < 0 THEN
			RAISE EXCEPTION 'keep must be a count' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		IF NOT app_is_contributor(p_project) OR NOT EXISTS (
			SELECT 1 FROM scenario s
			WHERE s.id = p_scenario AND s.project_id = p_project AND s.origin = 'applicant' AND s.owner_user_id = app_current_user_id()
		) THEN
			RETURN;
		END IF;
		RETURN QUERY
			DELETE FROM model_run WHERE model_run.id IN (
				SELECT r.id FROM model_run r
				WHERE r.project_id = p_project AND r.scenario_id = p_scenario AND NOT app_run_kept(r.id)
				ORDER BY r.created_at DESC, r.id DESC OFFSET p_keep
			) RETURNING model_run.id;
	END
	$$;

-- A scenario run of this project, made by the current user in this very
-- transaction: what a contributor may add series and stored inputs to.
CREATE FUNCTION app_own_new_scenario_run(p_project uuid, p_run uuid) RETURNS boolean
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		RETURN EXISTS (
			SELECT 1 FROM model_run m
			WHERE m.id = p_run AND m.project_id = p_project AND m.scenario_id IS NOT NULL
			  AND m.created_by = app_current_user_id() AND m.created_at = now()
		);
	END
	$$;

-- Projects where the current user is exactly a contributor and the catchment
-- has at least 5 farm holders, counted from nobody's point of view as
-- app_share_series (025) counts them: where a contributor reads catchment
-- series. The one definition of that k rule (app_contributor_catchment_runs
-- below now uses it).
CREATE FUNCTION app_contributor_k_projects() RETURNS SETOF uuid
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
			SELECT m.project_id FROM project_member m
			WHERE m.user_id = uid AND m.role = 'contributor'
			  AND app_is_contributor(m.project_id)
			  AND (
				SELECT count(DISTINCT coalesce(
					(SELECT min(fl.user_id::text) FROM farm_link fl WHERE fl.node_id = n.id),
					'node:' || n.id::text
				))
				FROM node n WHERE n.project_id = m.project_id AND n.kind = 'farm'
			  ) >= 5;
	END
	$$;

-- app_contributor_catchment_runs, from its latest definition (045), on the
-- helper above: the same published runs.
CREATE OR REPLACE FUNCTION app_contributor_catchment_runs() RETURNS SETOF uuid
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		RETURN QUERY
			SELECT p.run_id FROM run_publication p
			WHERE p.project_id IN (SELECT app_contributor_k_projects());
	END
	$$;

-- The application runs the current user reads as a contributor
-- (app_contributor_scenario_runs, 045), each with the application's own
-- nodes: the node-keyed series of those runs a contributor reads.
-- Uncorrelated, so a policy evaluates it once (a hashed subplan).
CREATE FUNCTION app_contributor_run_nodes() RETURNS TABLE (run_id uuid, node_id uuid)
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
			  AND app_is_contributor(s.project_id);
	END
	$$;

REVOKE ALL ON FUNCTION app_scenario_run_meta(uuid, uuid), app_trim_application_runs(uuid, uuid, integer),
	app_own_new_scenario_run(uuid, uuid), app_contributor_k_projects(), app_contributor_run_nodes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_scenario_run_meta(uuid, uuid), app_trim_application_runs(uuid, uuid, integer),
	app_own_new_scenario_run(uuid, uuid), app_contributor_k_projects(), app_contributor_run_nodes() TO water_app;

-- ---------------------------------------------------------------------------
-- model_run, from 045's model_run_select: no contributor branch.
-- ---------------------------------------------------------------------------
DROP POLICY model_run_select ON model_run;
CREATE POLICY model_run_select ON model_run FOR SELECT
	USING (
		app_has_role(project_id, 'viewer')
		AND (scenario_id IS NULL OR app_scenario_readable(scenario_id))
	);
-- Unreachable without the row read (a DELETE's rows must pass a SELECT
-- policy); app_trim_application_runs does the trim.
DROP POLICY model_run_delete_contributor ON model_run;

-- ---------------------------------------------------------------------------
-- run_series, from 045's run_series_select_contributor and
-- run_series_insert_contributor.
-- ---------------------------------------------------------------------------
DROP POLICY run_series_select_contributor ON run_series;
CREATE POLICY run_series_select_contributor ON run_series FOR SELECT
	USING (
		-- An application run they read: the application's own nodes.
		(run_id, node_id) IN (SELECT n.run_id, n.node_id FROM app_contributor_run_nodes() n)
		-- The catchment allowlist (the share links', 025) under the k rule: of a
		-- published run, or of an application run they read.
		OR (
			node_id IS NULL
			AND key IN ('natural_flow', 'simulated_outflow', 'observed_flow', 'ewr', 'ewr_shortfall')
			AND (
				run_id IN (SELECT app_contributor_catchment_runs())
				OR (run_id IN (SELECT app_contributor_scenario_runs()) AND project_id IN (SELECT app_contributor_k_projects()))
			)
		)
	);

DROP POLICY run_series_insert_contributor ON run_series;
CREATE POLICY run_series_insert_contributor ON run_series FOR INSERT
	WITH CHECK (app_is_contributor(project_id) AND app_own_new_scenario_run(project_id, run_id));

DROP POLICY run_input_series_insert_contributor ON run_input_series;
CREATE POLICY run_input_series_insert_contributor ON run_input_series FOR INSERT
	WITH CHECK (app_is_contributor(project_id) AND app_own_new_scenario_run(project_id, run_id));
