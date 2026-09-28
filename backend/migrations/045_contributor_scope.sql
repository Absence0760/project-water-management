-- 045_contributor_scope — what a contributor (044, a licence applicant or
-- their consultant) may read and write, application scenarios and their
-- submission workflow (roadmap WP-3.3; docs/data-model.md § Applicants,
-- docs/security.md § Applicants, docs/scenarios.md § Applications).
--
-- A contributor ranks below viewer, so every existing policy already refuses
-- them. Everything here is an extra *permissive* policy, a helper, or a
-- policy rewritten from its latest definition (named below):
--
--   project, run_publication, audit_event (insert)
--                     unchanged: `app_has_role(…, 'farmer')` already admits a
--                     contributor, who ranks above a farmer
--   project_member    unchanged: their own row (020's member_select_self)
--   node, crop_area, crop, transfer, land_cover, publication_farm, run_series
--   (farm keys)       unchanged: 020/022's farmer policies are keyed on
--                     app_farm_nodes (farm_link rows), not on the role, so a
--                     contributor linked to a farm reads what a farmer with the
--                     same links reads. farm_link_check (020) now admits a
--                     contributor as well as a farmer.
--   scenario          rewritten: a scenario has an `origin`. 'team' is
--                     WP-3.2's modelling scenario, read by viewers and written
--                     by editors exactly as before. 'applicant' is an
--                     application, made by a contributor: its owner and the
--                     people they add (scenario_member) read it; editors (the
--                     assessors) only once it is submitted, viewers only once
--                     decided. Only its owner edits it, only while a draft;
--                     only an editor who isn't the owner decides it.
--   scenario_member   new: the applicant's consultant and client share one
--                     application.
--   model_run         model_run_select rewritten (001): a run of a scenario is
--                     read by whoever reads the scenario, so an application's
--                     draft runs are hidden from the assessors too. A
--                     contributor may insert runs of the scenarios they read,
--                     and delete their own scenarios' runs that nothing keeps.
--                     A published run is *not* readable as a row: its inputs
--                     and summary hold every farm (as for farmers, 020).
--   run_series        run_series_select rewritten (001): a viewer no longer
--                     reads the series of an application run they can't see.
--                     A contributor reads their scenario runs' series and the
--                     catchment series (the share links' allowlist, 025) of a
--                     published run, when the catchment has at least 5 farm
--                     holders (the share links' k).
--   series_blob, run_input_series
--                     a contributor may add a new run's stored inputs, as an
--                     editor does (021)
--   note, signoff, yield_result
--                     note_select (037), signoff_select (036) and
--                     yield_result_select (040) rewritten: a viewer doesn't
--                     read a note on, a sign-off of or a yield of an
--                     application hidden from them (at the end)
--   allocation, allocation_holder, borehole, note (farm)
--                     unchanged: keyed on app_farm_nodes, so a linked
--                     contributor reads their own farm's rows, as a farmer
--
-- The published baseline's full input reaches the *server* through
-- app_published_run_input / app_published_run_series (SECURITY DEFINER), for
-- executeScenarioRun and the check against the base. The API projects what
-- an applicant sees of it (D2's recommended default, pending the client):
-- catchment settings, their own farms, the gauges, and every other node by
-- kind and an anonymous name (backend/src/scenarios/applicant.ts).

-- ---------------------------------------------------------------------------
-- scenario: origin and the decision
-- ---------------------------------------------------------------------------
ALTER TABLE scenario
	ADD COLUMN origin text NOT NULL DEFAULT 'team' CHECK (origin IN ('team', 'applicant')),
	ADD COLUMN submitted_at timestamptz,
	ADD COLUMN decided_at timestamptz,
	ADD COLUMN decided_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
	-- The assessor's outcome (pending the licensing authority's own terms).
	ADD COLUMN outcome text CHECK (outcome IN ('approved', 'approved_with_conditions', 'refused')),
	ADD COLUMN decision_note text NOT NULL DEFAULT '' CHECK (char_length(decision_note) <= 4000),
	ADD CONSTRAINT scenario_outcome_decided CHECK (outcome IS NULL OR status = 'decided');
CREATE INDEX scenario_decided_by_idx ON scenario (decided_by);
-- The assessors' Applications list: a project's applications by status.
CREATE INDEX scenario_applications_idx ON scenario (project_id, status) WHERE origin = 'applicant';

COMMENT ON COLUMN scenario.origin IS
	'team: a modelling scenario (WP-3.2), viewer read, editor write. applicant: an application by a contributor (045, WP-3.3), read by its owner and scenario_member, by editors once submitted and by viewers once decided. Stamped from the creator''s role; never changes.';
COMMENT ON COLUMN scenario.outcome IS 'The assessor''s decision on an application (with decided_at, decided_by and decision_note); set once, on the move to decided.';

-- ---------------------------------------------------------------------------
-- Helpers. SECURITY DEFINER (they read scenario, scenario_member, model_run
-- and farm_link past RLS), STABLE, search_path pinned; PL/pgSQL so their
-- plans are cached for the session (026).
-- ---------------------------------------------------------------------------

-- Exactly a contributor in this project (not above: a viewer and up already
-- read what a contributor's policies grant, through their own).
CREATE FUNCTION app_is_contributor(p_project uuid) RETURNS boolean
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		RETURN coalesce(app_project_role(p_project) = 'contributor', false);
	END
	$$;

CREATE TABLE scenario_member (
	scenario_id uuid NOT NULL REFERENCES scenario(id) ON DELETE CASCADE,
	project_id  uuid NOT NULL,
	user_id     uuid NOT NULL,
	added_by    uuid REFERENCES app_user(id) ON DELETE SET NULL,
	added_at    timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (scenario_id, user_id),
	-- A share needs a membership, and goes with it (as farm_link, 020).
	FOREIGN KEY (project_id, user_id) REFERENCES project_member (project_id, user_id) ON DELETE CASCADE
);
CREATE INDEX scenario_member_member_idx ON scenario_member (project_id, user_id);
CREATE INDEX scenario_member_user_idx ON scenario_member (user_id);
CREATE INDEX scenario_member_added_by_idx ON scenario_member (added_by);
COMMENT ON TABLE scenario_member IS
	'Who else reads an application (045, WP-3.3): the applicant''s consultant or client. Only the owner adds; anyone listed may leave.';

-- Whether the current user reads a scenario with these columns. Takes the
-- columns, not the id, so a policy can call it on a row being inserted (the
-- row isn't visible to a lookup by id yet). The one definition of who reads
-- a scenario; app_scenario_readable looks the row up and calls it.
CREATE FUNCTION app_scenario_visible(p_project uuid, p_scenario uuid, p_origin text, p_status text, p_owner uuid) RETURNS boolean
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		r project_role := app_project_role(p_project);
		uid uuid := app_current_user_id();
	BEGIN
		IF r IS NULL THEN
			RETURN false;
		END IF;
		IF p_origin = 'team' THEN
			RETURN r >= 'viewer'::project_role;
		END IF;
		IF r >= 'contributor'::project_role AND (
			p_owner = uid OR EXISTS (SELECT 1 FROM scenario_member WHERE scenario_id = p_scenario AND user_id = uid)
		) THEN
			RETURN true;
		END IF;
		IF p_status = 'decided' THEN
			RETURN r >= 'viewer'::project_role;
		END IF;
		IF p_status <> 'draft' THEN
			RETURN r >= 'editor'::project_role;
		END IF;
		RETURN false;
	END
	$$;

CREATE FUNCTION app_scenario_readable(p_scenario uuid) RETURNS boolean
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		s record;
	BEGIN
		SELECT project_id, origin, status, owner_user_id INTO s FROM scenario WHERE id = p_scenario;
		IF NOT FOUND THEN
			RETURN false;
		END IF;
		RETURN app_scenario_visible(s.project_id, p_scenario, s.origin, s.status, s.owner_user_id);
	END
	$$;

-- Runs of applications the current user can't read, in every project: the
-- one exclusion from a viewer's run_series policy. Uncorrelated, so a query
-- evaluates it once (a hashed subplan), not per series row.
CREATE FUNCTION app_hidden_scenario_runs() RETURNS SETOF uuid
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		RETURN QUERY
			SELECT r.id FROM scenario s JOIN model_run r ON r.scenario_id = s.id
			WHERE s.origin = 'applicant'
			  AND NOT app_scenario_visible(s.project_id, s.id, s.origin, s.status, s.owner_user_id);
	END
	$$;

-- Runs of applications the current user reads in a project where they are a
-- contributor: their series are theirs to read. Uncorrelated, as above.
CREATE FUNCTION app_contributor_scenario_runs() RETURNS SETOF uuid
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
			  AND app_is_contributor(s.project_id);
	END
	$$;

-- Published runs (current or in the history) of the projects where the
-- current user is a contributor and the catchment has at least 5 farm
-- holders, counted from nobody's point of view as app_share_series (025)
-- counts them: whose catchment series a contributor reads.
CREATE FUNCTION app_contributor_catchment_runs() RETURNS SETOF uuid
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
	BEGIN
		IF NOT EXISTS (SELECT 1 FROM project_member WHERE user_id = uid AND role = 'contributor') THEN
			RETURN;
		END IF;
		RETURN QUERY
			SELECT p.run_id FROM run_publication p
			WHERE p.project_id IN (SELECT m.project_id FROM project_member m WHERE m.user_id = uid AND m.role = 'contributor')
			  AND app_is_contributor(p.project_id)
			  AND (
				SELECT count(DISTINCT coalesce(
					(SELECT min(fl.user_id::text) FROM farm_link fl WHERE fl.node_id = n.id),
					'node:' || n.id::text
				))
				FROM node n WHERE n.project_id = p.project_id AND n.kind = 'farm'
			  ) >= 5;
	END
	$$;

-- A run nothing keeps (RUN_KEPT_SQL in backend/src/runs/execute.ts: pinned,
-- nominated now or before, or cited), read past RLS: a contributor can't see
-- run_nomination, so without this they could delete a nominated run of theirs.
CREATE FUNCTION app_run_kept(p_run uuid) RETURNS boolean
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		RETURN EXISTS (SELECT 1 FROM model_run r WHERE r.id = p_run AND r.pinned)
			OR EXISTS (SELECT 1 FROM run_nomination n WHERE n.run_id = p_run)
			OR model_run_cited(p_run);
	END
	$$;

-- A published run's stored input, for the server: its snapshot, label and
-- trigger (042: a forecast run is refused as a base, as for a team scenario).
-- Answers a contributor or above, for a run of the model itself (not a
-- scenario run) that a publication of this project names (current or in the
-- history); anyone else gets no row. The API never
-- returns `inputs` to a contributor (scenarios/applicant.ts projects it).
CREATE FUNCTION app_published_run_input(p_project uuid, p_run uuid)
	RETURNS TABLE (created_at timestamptz, label text, inputs jsonb, "trigger" text)
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		RETURN QUERY
			SELECT r.created_at, r.label, r.inputs, r."trigger"::text FROM model_run r
			WHERE r.id = p_run AND r.project_id = p_project AND r.scenario_id IS NULL
			  AND app_has_role(p_project, 'contributor')
			  AND EXISTS (SELECT 1 FROM run_publication p WHERE p.run_id = p_run AND p.project_id = p_project);
	END
	$$;

-- Its stored input series (021), under the same rule.
CREATE FUNCTION app_published_run_series(p_project uuid, p_run uuid)
	RETURNS TABLE (kind text, start_date date, sha256 text, "values" double precision[])
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		RETURN QUERY
			SELECT i.kind::text, i.start_date, i.sha256, b."values"
			FROM run_input_series i LEFT JOIN series_blob b ON b.project_id = i.project_id AND b.sha256 = i.sha256
			WHERE i.run_id = p_run AND i.project_id = p_project
			  AND app_has_role(p_project, 'contributor')
			  AND EXISTS (SELECT 1 FROM model_run r WHERE r.id = p_run AND r.scenario_id IS NULL)
			  AND EXISTS (SELECT 1 FROM run_publication p WHERE p.run_id = p_run AND p.project_id = p_project);
	END
	$$;

-- A run's id, label and date, for the "Based on run X" banner: for a run the
-- caller reads, or a published run and a caller who is a contributor or
-- above; else NULL.
CREATE FUNCTION app_run_brief(p_project uuid, p_run uuid) RETURNS jsonb
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		RETURN (
			SELECT jsonb_build_object('id', r.id, 'label', r.label, 'createdAt', r.created_at)
			FROM model_run r
			WHERE r.id = p_run AND r.project_id = p_project
			  AND (
				(r.scenario_id IS NULL AND app_has_role(p_project, 'viewer'))
				OR (r.scenario_id IS NOT NULL AND app_scenario_readable(r.scenario_id))
				OR (app_has_role(p_project, 'contributor') AND EXISTS (SELECT 1 FROM run_publication p WHERE p.run_id = p_run AND p.project_id = p_project))
			  )
		);
	END
	$$;

-- ---------------------------------------------------------------------------
-- scenario_guard, from its latest definition (024_scenarios), with:
--  * origin stamped from the creator's role on insert, never changed;
--  * an application's base must be a published run of the project (current
--    or in the history), on insert and on rebase;
--  * an application moves only as its owner moves it (submit, withdraw, back
--    to draft), except the decision, which only an editor who isn't its owner
--    makes, with an outcome, and nothing else in the same update;
--  * submitted_at, decided_at and decided_by stamped here, never by the caller;
--    the outcome and its note set once, on the move to decided.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION scenario_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		run_project uuid;
		run_scenario uuid;
		uid uuid := app_current_user_id();
		deciding boolean;
	BEGIN
		IF TG_OP = 'DELETE' THEN
			IF OLD.status IN ('submitted', 'decided') THEN
				RAISE EXCEPTION 'a % scenario can''t be deleted', OLD.status USING ERRCODE = 'check_violation';
			END IF;
			RETURN OLD;
		END IF;
		IF TG_OP = 'INSERT' THEN
			NEW.owner_user_id := uid;
			IF NEW.owner_user_id IS NULL THEN
				RAISE EXCEPTION 'a scenario needs a signed-in user' USING ERRCODE = 'insufficient_privilege';
			END IF;
			IF NEW.status <> 'draft' THEN
				RAISE EXCEPTION 'a new scenario is a draft' USING ERRCODE = 'check_violation';
			END IF;
			NEW.created_at := now();
			NEW.origin := CASE WHEN app_project_role(NEW.project_id) = 'contributor' THEN 'applicant' ELSE 'team' END;
			NEW.submitted_at := NULL;
			NEW.decided_at := NULL;
			NEW.decided_by := NULL;
			NEW.outcome := NULL;
			NEW.decision_note := '';
		ELSE
			IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
			   OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.origin IS DISTINCT FROM OLD.origin THEN
				RAISE EXCEPTION 'a scenario''s project, owner, origin and creation time never change' USING ERRCODE = 'check_violation';
			END IF;
			IF OLD.status <> 'draft' AND (NEW.ops IS DISTINCT FROM OLD.ops OR NEW.ops_sha256 IS DISTINCT FROM OLD.ops_sha256
			   OR NEW.base_run_id IS DISTINCT FROM OLD.base_run_id OR NEW.owned_node_ids IS DISTINCT FROM OLD.owned_node_ids) THEN
				RAISE EXCEPTION 'a % scenario is frozen', OLD.status USING ERRCODE = 'check_violation';
			END IF;
			IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
				(OLD.status = 'draft' AND NEW.status = 'submitted')
				OR (OLD.status = 'submitted' AND NEW.status IN ('withdrawn', 'decided'))
				OR (OLD.status = 'withdrawn' AND NEW.status = 'draft')
			) THEN
				RAISE EXCEPTION 'a scenario can''t go from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
			END IF;
			deciding := NEW.status = 'decided' AND OLD.status <> 'decided';
			IF OLD.origin = 'applicant' THEN
				IF deciding THEN
					IF uid IS NOT DISTINCT FROM OLD.owner_user_id OR NOT app_has_role(NEW.project_id, 'editor') THEN
						RAISE EXCEPTION 'only an assessor (an editor who didn''t make it) decides an application' USING ERRCODE = 'insufficient_privilege';
					END IF;
					IF NEW.outcome IS NULL THEN
						RAISE EXCEPTION 'a decision needs an outcome' USING ERRCODE = 'check_violation';
					END IF;
					IF NEW.name IS DISTINCT FROM OLD.name OR NEW.description IS DISTINCT FROM OLD.description THEN
						RAISE EXCEPTION 'a decision changes nothing else in the application' USING ERRCODE = 'check_violation';
					END IF;
				ELSIF uid IS DISTINCT FROM OLD.owner_user_id THEN
					RAISE EXCEPTION 'only the applicant changes their application' USING ERRCODE = 'insufficient_privilege';
				END IF;
			END IF;
			IF deciding THEN
				NEW.decided_at := now();
				NEW.decided_by := uid;
			ELSIF NEW.outcome IS DISTINCT FROM OLD.outcome OR NEW.decision_note IS DISTINCT FROM OLD.decision_note
			   OR NEW.decided_at IS DISTINCT FROM OLD.decided_at OR NEW.decided_by IS DISTINCT FROM OLD.decided_by THEN
				RAISE EXCEPTION 'a decision is recorded when the scenario is decided, and never changes' USING ERRCODE = 'check_violation';
			END IF;
			IF NEW.status = 'submitted' AND OLD.status <> 'submitted' THEN
				NEW.submitted_at := now();
			ELSIF NEW.status = 'draft' THEN
				NEW.submitted_at := NULL;
			ELSE
				NEW.submitted_at := OLD.submitted_at;
			END IF;
		END IF;
		NEW.updated_at := now();
		IF TG_OP = 'INSERT' OR NEW.base_run_id IS DISTINCT FROM OLD.base_run_id THEN
			SELECT project_id, scenario_id INTO run_project, run_scenario FROM model_run WHERE id = NEW.base_run_id;
			IF run_project IS DISTINCT FROM NEW.project_id THEN
				RAISE EXCEPTION 'run % belongs to a different project', NEW.base_run_id USING ERRCODE = 'foreign_key_violation';
			END IF;
			IF run_scenario IS NOT NULL THEN
				RAISE EXCEPTION 'run % is a scenario run; base a scenario on a run of the model', NEW.base_run_id USING ERRCODE = 'check_violation';
			END IF;
			IF NEW.origin = 'applicant' AND NOT EXISTS (
				SELECT 1 FROM run_publication p WHERE p.run_id = NEW.base_run_id AND p.project_id = NEW.project_id
			) THEN
				RAISE EXCEPTION 'an application is based on a published run' USING ERRCODE = 'check_violation';
			END IF;
		END IF;
		RETURN NEW;
	END
	$$;

-- An application deleted (a draft or withdrawn one, scenario_guard) takes
-- its runs that nothing keeps: they were never the assessors' to see, and
-- with scenario_id cleared (024's SET NULL) every viewer would read them.
-- A kept run stays (an editor pinned or nominated it while it was visible).
CREATE FUNCTION scenario_drop_application_runs() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF OLD.origin = 'applicant' THEN
			DELETE FROM model_run r WHERE r.scenario_id = OLD.id AND NOT app_run_kept(r.id);
		END IF;
		RETURN OLD;
	END
	$$;
CREATE TRIGGER scenario_drop_application_runs BEFORE DELETE ON scenario
	FOR EACH ROW EXECUTE FUNCTION scenario_drop_application_runs();

-- scenario_member: an application's, in its project, for a member who is a
-- contributor or above (a farmer reads no scenario), never its owner.
CREATE FUNCTION scenario_member_check() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		s record;
	BEGIN
		SELECT project_id, origin, owner_user_id INTO s FROM scenario WHERE id = NEW.scenario_id;
		IF s.project_id IS DISTINCT FROM NEW.project_id THEN
			RAISE EXCEPTION 'scenario % belongs to a different project', NEW.scenario_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		IF s.origin <> 'applicant' THEN
			RAISE EXCEPTION 'only an application is shared this way; a team scenario is read by every viewer' USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.user_id = s.owner_user_id THEN
			RAISE EXCEPTION 'the owner already reads their application' USING ERRCODE = 'check_violation';
		END IF;
		IF NOT EXISTS (
			SELECT 1 FROM project_member WHERE project_id = NEW.project_id AND user_id = NEW.user_id AND role >= 'contributor'::project_role
		) THEN
			RAISE EXCEPTION 'user % is not a contributor or above on this project', NEW.user_id USING ERRCODE = 'check_violation';
		END IF;
		IF TG_OP = 'INSERT' THEN
			NEW.added_by := app_current_user_id();
			NEW.added_at := now();
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER scenario_member_check BEFORE INSERT OR UPDATE ON scenario_member
	FOR EACH ROW EXECUTE FUNCTION scenario_member_check();

-- ---------------------------------------------------------------------------
-- farm_link_check, from its latest definition (020_farm_scope): a contributor
-- keeps their farm links (an irrigator applying to raise their own dam), so
-- a link is for a farmer or a contributor.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION farm_link_check() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NOT EXISTS (SELECT 1 FROM node WHERE id = NEW.node_id AND kind = 'farm') THEN
			RAISE EXCEPTION 'node % is not a farm', NEW.node_id USING ERRCODE = 'check_violation';
		END IF;
		IF NOT EXISTS (
			SELECT 1 FROM project_member
			WHERE project_id = NEW.project_id AND user_id = NEW.user_id AND role IN ('farmer', 'contributor')
		) THEN
			RAISE EXCEPTION 'user % is not a farmer or contributor on this project', NEW.user_id USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END
	$$;

-- ---------------------------------------------------------------------------
-- scenario RLS, replacing 024's viewer-read / editor-write policies.
-- ---------------------------------------------------------------------------
DROP POLICY scenario_select ON scenario;
DROP POLICY scenario_insert ON scenario;
DROP POLICY scenario_update ON scenario;
DROP POLICY scenario_delete ON scenario;
CREATE POLICY scenario_select ON scenario FOR SELECT
	USING (app_scenario_visible(project_id, id, origin, status, owner_user_id));
-- scenario_guard stamps the origin from the role before this is checked: an
-- editor makes a team scenario, a contributor an application.
CREATE POLICY scenario_insert ON scenario FOR INSERT
	WITH CHECK (app_has_role(project_id, 'editor') OR app_is_contributor(project_id));
-- An application: its owner (while still a member), or an editor deciding a
-- submitted one; scenario_guard says which of them may change what.
CREATE POLICY scenario_update ON scenario FOR UPDATE
	USING (
		(origin = 'team' AND app_has_role(project_id, 'editor'))
		OR (origin = 'applicant' AND owner_user_id = app_current_user_id() AND app_has_role(project_id, 'contributor'))
		OR (origin = 'applicant' AND status = 'submitted' AND app_has_role(project_id, 'editor'))
	)
	WITH CHECK (
		(origin = 'team' AND app_has_role(project_id, 'editor'))
		OR (origin = 'applicant' AND owner_user_id = app_current_user_id() AND app_has_role(project_id, 'contributor'))
		OR (origin = 'applicant' AND status = 'decided' AND app_has_role(project_id, 'editor'))
	);
CREATE POLICY scenario_delete ON scenario FOR DELETE
	USING (
		(origin = 'team' AND app_has_role(project_id, 'editor'))
		OR (origin = 'applicant' AND owner_user_id = app_current_user_id() AND app_has_role(project_id, 'contributor'))
	);

ALTER TABLE scenario_member ENABLE ROW LEVEL SECURITY;
CREATE POLICY scenario_member_select ON scenario_member FOR SELECT USING (app_scenario_readable(scenario_id));
-- Only the application's owner adds (scenario's own policy applies inside).
CREATE POLICY scenario_member_insert ON scenario_member FOR INSERT
	WITH CHECK (EXISTS (SELECT 1 FROM scenario s WHERE s.id = scenario_id AND s.owner_user_id = app_current_user_id()));
-- The owner removes anyone; anyone listed may leave.
CREATE POLICY scenario_member_delete ON scenario_member FOR DELETE
	USING (user_id = app_current_user_id() OR EXISTS (SELECT 1 FROM scenario s WHERE s.id = scenario_id AND s.owner_user_id = app_current_user_id()));
-- No update policy: a share is added or removed, never edited.
GRANT SELECT, INSERT, UPDATE, DELETE ON scenario_member TO water_app;

-- ---------------------------------------------------------------------------
-- model_run, from 001's model_run_select: a scenario run is read by whoever
-- reads its scenario (team scenarios: viewers, as before).
-- ---------------------------------------------------------------------------
DROP POLICY model_run_select ON model_run;
CREATE POLICY model_run_select ON model_run FOR SELECT
	USING (
		(scenario_id IS NULL AND app_has_role(project_id, 'viewer'))
		OR (scenario_id IS NOT NULL AND app_scenario_readable(scenario_id))
	);
-- A contributor runs the scenarios they read, as themselves.
CREATE POLICY model_run_insert_contributor ON model_run FOR INSERT
	WITH CHECK (
		scenario_id IS NOT NULL AND app_is_contributor(project_id)
		AND created_by = app_current_user_id() AND app_scenario_readable(scenario_id)
	);
-- …and removes their own applications' runs that nothing keeps (the
-- per-application run cap, APPLICATION_RUNS_KEPT in scenarios/execute.ts).
CREATE POLICY model_run_delete_contributor ON model_run FOR DELETE
	USING (
		scenario_id IS NOT NULL AND app_is_contributor(project_id)
		AND EXISTS (SELECT 1 FROM scenario s WHERE s.id = scenario_id AND s.owner_user_id = app_current_user_id())
		AND NOT app_run_kept(id)
	);

-- ---------------------------------------------------------------------------
-- run_series, from 001's run_series_select (and 022's farmer policy, kept).
-- ---------------------------------------------------------------------------
DROP POLICY run_series_select ON run_series;
CREATE POLICY run_series_select ON run_series FOR SELECT
	USING (app_has_role(project_id, 'viewer') AND run_id NOT IN (SELECT app_hidden_scenario_runs()));
CREATE POLICY run_series_select_contributor ON run_series FOR SELECT
	USING (
		run_id IN (SELECT app_contributor_scenario_runs())
		OR (
			node_id IS NULL
			AND key IN ('natural_flow', 'simulated_outflow', 'observed_flow', 'ewr', 'ewr_shortfall')
			AND run_id IN (SELECT app_contributor_catchment_runs())
		)
	);
-- A contributor's own scenario run, saved in this very transaction.
CREATE POLICY run_series_insert_contributor ON run_series FOR INSERT
	WITH CHECK (
		app_is_contributor(project_id)
		AND EXISTS (
			SELECT 1 FROM model_run m
			WHERE m.id = run_series.run_id AND m.project_id = run_series.project_id AND m.scenario_id IS NOT NULL
			  AND m.created_by = app_current_user_id() AND m.created_at = now()
		)
	);

-- The run's stored inputs (021), as an editor's are written.
CREATE POLICY series_blob_insert_contributor ON series_blob FOR INSERT WITH CHECK (app_is_contributor(project_id));
CREATE POLICY run_input_series_insert_contributor ON run_input_series FOR INSERT
	WITH CHECK (
		app_is_contributor(project_id)
		AND EXISTS (
			SELECT 1 FROM model_run m
			WHERE m.id = run_input_series.run_id AND m.project_id = run_input_series.project_id AND m.scenario_id IS NOT NULL
			  AND m.created_by = app_current_user_id() AND m.created_at = now()
		)
	);

-- ---------------------------------------------------------------------------
-- Tables added while WP-3.3 was in flight that point at a run or a scenario:
-- a viewer reading them by project role alone would read what an application
-- hidden from them says (a note on its run, a sign-off of it, a yield of it).
-- Each viewer policy gains the same exclusion as run_series_select above.
-- Contributors are refused by all three already (they rank below viewer).
-- ---------------------------------------------------------------------------

-- note_select, from 037_notes.sql.
DROP POLICY note_select ON note;
CREATE POLICY note_select ON note FOR SELECT
	USING (
		app_has_role(project_id, 'viewer')
		AND (deleted_at IS NULL OR author_id = app_current_user_id() OR app_has_role(project_id, 'editor'))
		AND (run_id IS NULL OR run_id NOT IN (SELECT app_hidden_scenario_runs()))
	);

-- signoff_select, from 036_signoff.sql.
DROP POLICY signoff_select ON signoff;
CREATE POLICY signoff_select ON signoff FOR SELECT
	USING (app_has_role(project_id, 'viewer') AND run_id NOT IN (SELECT app_hidden_scenario_runs()));

-- yield_result_select, from 040_yield.sql: a yield on a scenario follows the
-- scenario, one on a run follows the run.
DROP POLICY yield_result_select ON yield_result;
CREATE POLICY yield_result_select ON yield_result FOR SELECT
	USING (
		app_has_role(project_id, 'viewer')
		AND (scenario_id IS NULL OR app_scenario_readable(scenario_id))
		AND (run_id IS NULL OR run_id NOT IN (SELECT app_hidden_scenario_runs()))
	);
