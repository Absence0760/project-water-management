-- 298_scenario_alternatives — the mitigation alternatives an application cites
-- (docs/followups.md "Labelled mitigation alternatives", the licence applicant;
-- docs/scenarios.md § Applications, docs/data-model.md § Scenarios,
-- docs/evidence-pack.md § Mitigation alternatives).
--
-- The evidence report showed one application, but an applicant must show the
-- mitigation they weighed. An application (or a team scenario) now cites up to
-- three runs of other scenarios on the same base run as labelled alternatives
-- ("smaller dam", "winter abstraction only"); the report sets each beside the
-- application on page 1 (report format evidence-26).
--
-- Expand-only.
--
--  1. scenario_alternative: one row per alternative, `position` 0–2 (so at
--     most three, ALTERNATIVES_MAX in the engine), unique per scenario, the
--     label trimmed 1–80 characters. It cites a **run** (run_id), not the
--     scenario: a run's ops and results never change, so the citation is the
--     alternative as it was weighed. `alternative_scenario_id` is the run's
--     scenario, kept so deleting that scenario is refused while a frozen
--     application cites it (2).
--
--  2. scenario_alternative_guard (SECURITY DEFINER: an applicant reads no
--     model_run row, 046): rows are never updated (replaced: delete, insert),
--     and change only while the citing scenario is a draft, like its ops
--     (frozen once submitted; a withdrawn one reopened takes changes again).
--     An insert's run must be a run of `alternative_scenario_id`, another
--     scenario than the citing one, of the same origin and, for an
--     application, the same owner, on the citing scenario's base run. One
--     refusal for a run that isn't the caller's own scenario's (or doesn't
--     exist), so no answer says another applicant's run exists. A delete the
--     citing scenario's (or the project's) own deletion cascades finds it
--     gone, and passes.
--
--  3. scenario_alternative_rebase: rebasing a draft drops the citations on
--     another base run, so every alternative is on the scenario's base.
--
--  4. RLS: whoever reads the citing scenario reads its alternatives; whoever
--     may change it (an editor on a team scenario, its owner on an
--     application, scenario_update's rule) cites and drops them. No UPDATE
--     policy, as the guard refuses one. Grants to water_app.
--
--  5. Who reads the cited run. A draft application's runs are its parties'
--     alone (model_run_select, app_hidden_scenario_runs, 045/046), and an
--     alternative is usually a draft forever, so the assessors couldn't read
--     what they are shown. A run cited by a scenario past draft that the
--     caller reads is readable too (app_alternative_run_readable), in
--     model_run_select (046's, + this branch) and app_hidden_scenario_runs
--     (045's, + this exclusion, which run_series and the share and pack
--     policies read), and in the definers that apply model_run_select's rule
--     themselves: app_run_digest (so its server stamp verifies) and
--     app_run_allocation_holders / _kinds (219, 226). The applicant chose to
--     put it before them by citing it and submitting.
--
--  6. model_run_cited (112's, + this clause): a run a scenario past draft
--     cites, or one a scenario with an evidence pack cites, is kept (no trim,
--     no delete), so a frozen application's alternatives can't vanish. A
--     draft's citations keep nothing: deleting or trimming the run drops the
--     citation (ON DELETE CASCADE), and an account's deletion of its drafts
--     (138/160/161) isn't held up by them.

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------
CREATE TABLE scenario_alternative (
	id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id              uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	scenario_id             uuid NOT NULL REFERENCES scenario(id) ON DELETE CASCADE,
	alternative_scenario_id uuid NOT NULL REFERENCES scenario(id) ON DELETE CASCADE,
	run_id                  uuid NOT NULL REFERENCES model_run(id) ON DELETE CASCADE,
	position                smallint NOT NULL CHECK (position BETWEEN 0 AND 2),
	label                   text NOT NULL CHECK (label = btrim(label) AND char_length(label) BETWEEN 1 AND 80),
	created_at              timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT scenario_alternative_position_key UNIQUE (scenario_id, position),
	CONSTRAINT scenario_alternative_run_key UNIQUE (scenario_id, run_id),
	CHECK (alternative_scenario_id <> scenario_id)
);
-- Covering indexes: scenario_id by the two unique keys; the others here.
CREATE INDEX scenario_alternative_project_idx ON scenario_alternative (project_id);
CREATE INDEX scenario_alternative_alternative_idx ON scenario_alternative (alternative_scenario_id);
CREATE INDEX scenario_alternative_run_idx ON scenario_alternative (run_id);
CREATE TRIGGER scenario_alternative_same_project BEFORE INSERT OR UPDATE ON scenario_alternative
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('scenario_id', 'alternative_scenario_id', 'run_id');

COMMENT ON TABLE scenario_alternative IS
	'The mitigation alternatives a scenario cites (298): up to three labelled runs of the same owner''s other scenarios on its base run, set beside it on the evidence report''s page 1 (evidence-26). Frozen with the ops once submitted.';
COMMENT ON COLUMN scenario_alternative.run_id IS
	'The alternative''s run (of alternative_scenario_id, on the citing scenario''s base run): kept by model_run_cited once the citing scenario is past draft.';
COMMENT ON COLUMN scenario_alternative.label IS
	'The applicant''s label for the alternative ("smaller dam"), printed over its page-1 column.';

-- ---------------------------------------------------------------------------
-- 2. The guard
-- ---------------------------------------------------------------------------
CREATE FUNCTION scenario_alternative_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		c record;
		a record;
		v_base text;
	BEGIN
		IF TG_OP = 'UPDATE' THEN
			RAISE EXCEPTION 'an alternative is replaced, not changed' USING ERRCODE = 'check_violation';
		END IF;
		IF TG_OP = 'DELETE' THEN
			SELECT status INTO c FROM scenario WHERE id = OLD.scenario_id;
			-- The citing scenario's own deletion (or its project's) cascades here after it is gone.
			IF FOUND AND c.status <> 'draft' AND EXISTS (SELECT 1 FROM project WHERE id = OLD.project_id) THEN
				RAISE EXCEPTION 'a % scenario''s alternatives are frozen, and so is the scenario run each cites', c.status USING ERRCODE = 'restrict_violation';
			END IF;
			RETURN OLD;
		END IF;
		SELECT project_id, origin, owner_user_id, status, base_run_id INTO c FROM scenario WHERE id = NEW.scenario_id;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'no such scenario' USING ERRCODE = 'foreign_key_violation';
		END IF;
		IF c.status <> 'draft' THEN
			RAISE EXCEPTION 'a % scenario''s alternatives are frozen; withdraw it to change them', c.status USING ERRCODE = 'check_violation';
		END IF;
		SELECT s.origin, s.owner_user_id, r.inputs->'scenario'->>'baseRunId' AS base INTO a
		FROM model_run r JOIN scenario s ON s.id = r.scenario_id
		WHERE r.id = NEW.run_id AND r.project_id = NEW.project_id AND s.id = NEW.alternative_scenario_id;
		IF NOT FOUND OR NEW.alternative_scenario_id = NEW.scenario_id OR a.origin <> c.origin
		   OR (c.origin = 'applicant' AND a.owner_user_id IS DISTINCT FROM c.owner_user_id) THEN
			RAISE EXCEPTION 'an alternative is a run of another of your own scenarios' USING ERRCODE = 'check_violation';
		END IF;
		v_base := a.base;
		IF v_base IS DISTINCT FROM c.base_run_id::text THEN
			RAISE EXCEPTION 'an alternative is a run on the same base run as the scenario it is cited by' USING ERRCODE = 'check_violation';
		END IF;
		NEW.created_at := now();
		RETURN NEW;
	END
	$$;
CREATE TRIGGER scenario_alternative_guard BEFORE INSERT OR UPDATE OR DELETE ON scenario_alternative
	FOR EACH ROW EXECUTE FUNCTION scenario_alternative_guard();

-- ---------------------------------------------------------------------------
-- 3. Rebasing a draft drops the citations on another base run
-- ---------------------------------------------------------------------------
CREATE FUNCTION scenario_alternative_rebase() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		DELETE FROM scenario_alternative sa USING model_run r
		WHERE sa.scenario_id = NEW.id AND r.id = sa.run_id
			AND (r.inputs->'scenario'->>'baseRunId') IS DISTINCT FROM NEW.base_run_id::text;
		RETURN NULL;
	END
	$$;
CREATE TRIGGER scenario_alternative_rebase AFTER UPDATE OF base_run_id ON scenario
	FOR EACH ROW WHEN (NEW.base_run_id IS DISTINCT FROM OLD.base_run_id)
	EXECUTE FUNCTION scenario_alternative_rebase();

-- ---------------------------------------------------------------------------
-- 4. RLS
-- ---------------------------------------------------------------------------
ALTER TABLE scenario_alternative ENABLE ROW LEVEL SECURITY;
CREATE POLICY scenario_alternative_select ON scenario_alternative FOR SELECT
	USING (app_scenario_readable(scenario_id));
-- Whoever may change the citing scenario (scenario_update's rule; the scenario's own policy applies inside too).
CREATE POLICY scenario_alternative_insert ON scenario_alternative FOR INSERT
	WITH CHECK (EXISTS (
		SELECT 1 FROM scenario s WHERE s.id = scenario_id AND s.project_id = scenario_alternative.project_id AND (
			(s.origin = 'team' AND app_has_role(s.project_id, 'editor'))
			OR (s.origin = 'applicant' AND s.owner_user_id = app_current_user_id() AND app_has_role(s.project_id, 'contributor'))
		)
	));
CREATE POLICY scenario_alternative_delete ON scenario_alternative FOR DELETE
	USING (EXISTS (
		SELECT 1 FROM scenario s WHERE s.id = scenario_id AND (
			(s.origin = 'team' AND app_has_role(s.project_id, 'editor'))
			OR (s.origin = 'applicant' AND s.owner_user_id = app_current_user_id() AND app_has_role(s.project_id, 'contributor'))
		)
	));
GRANT SELECT, INSERT, DELETE ON scenario_alternative TO water_app;

-- The alternatives as a reader of the scenario lists them, with what they need of each run and its
-- scenario: an applicant reads no model_run row (046), and an assessor no draft alternative's scenario.
CREATE FUNCTION app_scenario_alternatives(p_project uuid, p_scenario uuid)
	RETURNS TABLE (ord smallint, label text, run_id uuid, alternative_scenario_id uuid, scenario_name text,
		run_label text, engine_version text, run_created_at timestamptz)
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NOT app_scenario_readable(p_scenario) THEN
			RETURN;
		END IF;
		RETURN QUERY
			SELECT sa.position, sa.label, sa.run_id, sa.alternative_scenario_id,
				COALESCE(s.name, r.inputs->'scenario'->>'name'), r.label, r.engine_version, r.created_at
			FROM scenario_alternative sa
			JOIN model_run r ON r.id = sa.run_id
			LEFT JOIN scenario s ON s.id = sa.alternative_scenario_id
			WHERE sa.project_id = p_project AND sa.scenario_id = p_scenario
			ORDER BY sa.position;
	END
	$$;
COMMENT ON FUNCTION app_scenario_alternatives(uuid, uuid) IS
	'The alternatives a scenario cites (298), for a reader of it: order (ord), label, the run and its scenario''s name, label, engine and date.';
REVOKE ALL ON FUNCTION app_scenario_alternatives(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_scenario_alternatives(uuid, uuid) TO water_app;

-- The runs whoever may change the scenario may cite as its alternatives: runs of their other scenarios of the same
-- origin (an application's: the same owner's) on its base run, newest first, at most 100. Nothing for anyone else.
CREATE FUNCTION app_scenario_alternative_candidates(p_project uuid, p_scenario uuid)
	RETURNS TABLE (run_id uuid, alternative_scenario_id uuid, scenario_name text, run_label text, engine_version text, run_created_at timestamptz)
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		c record;
	BEGIN
		SELECT sc.origin, sc.owner_user_id, sc.base_run_id INTO c FROM scenario sc WHERE sc.id = p_scenario AND sc.project_id = p_project;
		IF NOT FOUND OR NOT (
			(c.origin = 'team' AND app_has_role(p_project, 'editor'))
			OR (c.origin = 'applicant' AND c.owner_user_id = app_current_user_id() AND app_has_role(p_project, 'contributor'))
		) THEN
			RETURN;
		END IF;
		RETURN QUERY
			SELECT r.id, s.id, s.name, r.label, r.engine_version, r.created_at
			FROM model_run r JOIN scenario s ON s.id = r.scenario_id
			WHERE r.project_id = p_project AND s.project_id = p_project AND s.id <> p_scenario AND s.origin = c.origin
				AND (c.origin = 'team' OR s.owner_user_id = c.owner_user_id)
				AND r.inputs->'scenario'->>'baseRunId' = c.base_run_id::text
			ORDER BY r.created_at DESC, r.id DESC
			LIMIT 100;
	END
	$$;
COMMENT ON FUNCTION app_scenario_alternative_candidates(uuid, uuid) IS
	'The runs the caller may cite as a scenario''s alternatives (298): their own other scenarios'' runs (same origin; an application''s owner''s) on its base run.';
REVOKE ALL ON FUNCTION app_scenario_alternative_candidates(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_scenario_alternative_candidates(uuid, uuid) TO water_app;

-- ---------------------------------------------------------------------------
-- 5. Who reads the cited run
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_alternative_run_readable(p_run uuid) RETURNS boolean
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$ SELECT EXISTS (
		SELECT 1 FROM scenario_alternative sa JOIN scenario c ON c.id = sa.scenario_id
		WHERE sa.run_id = p_run AND c.status <> 'draft'
			AND app_scenario_visible(c.project_id, c.id, c.origin, c.status, c.owner_user_id)
	) $$;
COMMENT ON FUNCTION app_alternative_run_readable(uuid) IS
	'True for a run that a scenario past draft, which the caller reads, cites as an alternative (298): readable with it.';
REVOKE ALL ON FUNCTION app_alternative_run_readable(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_alternative_run_readable(uuid) TO water_app;

-- 046's model_run_select, + the cited alternative's branch.
DROP POLICY model_run_select ON model_run;
CREATE POLICY model_run_select ON model_run FOR SELECT
	USING (
		app_has_role(project_id, 'viewer')
		AND (scenario_id IS NULL OR app_scenario_readable(scenario_id) OR app_alternative_run_readable(id))
	);

-- 045's app_hidden_scenario_runs, less the runs a readable scenario past draft cites (run_series and the
-- share and pack policies read it).
CREATE OR REPLACE FUNCTION app_hidden_scenario_runs() RETURNS SETOF uuid
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		RETURN QUERY
			SELECT r.id FROM scenario s JOIN model_run r ON r.scenario_id = s.id
			WHERE s.origin = 'applicant'
			  AND NOT app_scenario_visible(s.project_id, s.id, s.origin, s.status, s.owner_user_id)
			  AND NOT app_alternative_run_readable(r.id);
	END
	$$;

-- The definers that read a run past RLS by model_run_select's rule, with the same branch: its digest (077/115's
-- app_run_digest, so a cited run's server stamp verifies for the assessors) and its allocations' holder keys and
-- kinds (219, 226: the evidence report's § 5 gate and page 1's registered-use row, for an alternative as for the
-- application).
CREATE OR REPLACE FUNCTION app_run_digest(p_run uuid) RETURNS bytea
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	SELECT app_run_digest_body(r.id)
	FROM model_run r
	WHERE r.id = p_run
	  AND (
		(app_has_role(r.project_id, 'viewer') AND (r.scenario_id IS NULL OR app_scenario_readable(r.scenario_id) OR app_alternative_run_readable(r.id)))
		OR app_own_new_scenario_run(r.project_id, r.id)
	  )
	$$;

CREATE OR REPLACE FUNCTION app_run_allocation_holders(p_project uuid, p_run uuid, p_ids text[])
	RETURNS TABLE (allocation_id text, holder text)
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	BEGIN
		IF NOT app_has_role(p_project, 'viewer') THEN
			RAISE EXCEPTION 'not a member of this project' USING ERRCODE = 'insufficient_privilege';
		END IF;
		-- Only a run the caller can read: model_run_select's rule (latest: 298), as this definer reads past it.
		IF NOT EXISTS (SELECT 1 FROM model_run r WHERE r.id = p_run AND r.project_id = p_project
			AND (r.scenario_id IS NULL OR app_scenario_readable(r.scenario_id) OR app_alternative_run_readable(r.id))) THEN
			RETURN;
		END IF;
		RETURN QUERY
		SELECT h.allocation_id, h.holder
		FROM run_allocation_holder h
		WHERE h.run_id = p_run AND h.allocation_id = ANY(p_ids)
		ORDER BY h.allocation_id;
	END
	$$;

CREATE OR REPLACE FUNCTION app_run_allocation_kinds(p_project uuid, p_run uuid, p_ids text[])
	RETURNS TABLE (allocation_id text, authorisation text)
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	BEGIN
		IF NOT app_has_role(p_project, 'viewer') THEN
			RAISE EXCEPTION 'not a member of this project' USING ERRCODE = 'insufficient_privilege';
		END IF;
		-- Only a run the caller can read: model_run_select's rule (latest: 298), as this definer reads past it.
		IF NOT EXISTS (SELECT 1 FROM model_run r WHERE r.id = p_run AND r.project_id = p_project
			AND (r.scenario_id IS NULL OR app_scenario_readable(r.scenario_id) OR app_alternative_run_readable(r.id))) THEN
			RETURN;
		END IF;
		RETURN QUERY
		SELECT h.allocation_id, h.authorisation
		FROM run_allocation_holder h
		WHERE h.run_id = p_run AND h.allocation_id = ANY(p_ids)
		ORDER BY h.allocation_id;
	END
	$$;

-- ---------------------------------------------------------------------------
-- 6. Kept while a frozen scenario, or one with a pack, cites it (112's, + the last clause)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION model_run_cited(p_run uuid) RETURNS boolean
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$ SELECT EXISTS (SELECT 1 FROM run_publication p WHERE p.run_id = p_run)
		OR EXISTS (SELECT 1 FROM scenario s WHERE s.base_run_id = p_run)
		OR EXISTS (SELECT 1 FROM signoff so WHERE so.run_id = p_run)
		OR EXISTS (SELECT 1 FROM evidence_pack ep WHERE ep.baseline_run_id = p_run)
		OR EXISTS (SELECT 1 FROM evidence_pack ep WHERE ep.scenario_run_id = p_run)
		OR EXISTS (SELECT 1 FROM scenario_alternative sa JOIN scenario c ON c.id = sa.scenario_id
			WHERE sa.run_id = p_run AND (c.status <> 'draft' OR EXISTS (SELECT 1 FROM evidence_pack ep WHERE ep.scenario_id = c.id))) $$;
COMMENT ON FUNCTION model_run_cited(uuid) IS
	'True for a run a publication (022_publication), a scenario (024_scenarios), a sign-off (036_signoff), an evidence pack (112_evidence_pack) or a frozen or packed scenario''s alternative (298) cites; assessments add their own EXISTS clause. Part of RUN_KEPT_SQL in backend/src/runs/execute.ts.';
