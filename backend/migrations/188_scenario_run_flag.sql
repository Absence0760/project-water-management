-- 188_scenario_run_flag — a run of a deleted scenario is still a scenario run
-- (issues #380 and #381; docs/data-model.md § Scenarios).
--
-- Deleting a scenario clears its runs' scenario_id (024: ON DELETE SET NULL),
-- while each run's inputs.scenario keeps the scenario's id, name, base run and
-- ops. Every check that told "a run of the model" from a scenario run by
-- `scenario_id IS NULL` alone took such a run for a run of the model: it could
-- be nominated or published, become the base of a scenario, sweep, outlook,
-- assessment or evidence pack, and count as the newest run of the model.
--
-- Why a column and not a tombstone: keeping the scenario row (or its id in a
-- column that survives) would mean a soft delete through every path that
-- deletes a scenario (the route, account deletion, pseudonymisation, the
-- project's own delete) and every policy that reads one, and would keep a
-- deleted application's name and ops in a second place. The run already
-- records its scenario, so what is missing is one name for the test:
-- model_run.from_scenario, a stored generated column, true for a run made by
-- a scenario whether or not the scenario still exists. Postgres recomputes it
-- when the foreign key clears scenario_id, so it can't drift, needs no
-- trigger, and every caller (SQL and TypeScript) reads the same column.
--
-- scenario_id stays what it was: the live link, for joins and for who may read
-- the run (the model_run policies, app_run_brief, app_run_digest: a run with
-- no scenario left to gate on is its project's, as 045 decided). The catalogue
-- test (src/db/catalogue.db.test.ts) lists every remaining `scenario_id IS
-- [NOT] NULL` in a function, policy or trigger and why it is a link or an
-- access test, so a new one has to be classified. Redefined below from their
-- latest definitions (CLAUDE.md rule 3), with only that test changed:
--   run_nomination_stamp (098), scenario_guard (163), app_published_run_input and
--   app_published_run_series (045), app_api_key_accepted_series (056),
--   scenario_sweep_guard (062), seasonal_outlook_guard (106),
--   assessment_guard (145), evidence_pack_guard (112),
--   app_application_run_results (118), app_specialist_pack (167).
-- run_nomination_stamp also refuses a forecast run (the route did; the stamp
-- didn't, though the route said it did), and a new trigger on run_publication
-- refuses a scenario run, as the publish route does (#379): both now hold in
-- the database, not only in the API.

ALTER TABLE model_run
	ADD COLUMN from_scenario boolean NOT NULL GENERATED ALWAYS AS (scenario_id IS NOT NULL OR inputs ? 'scenario') STORED;
COMMENT ON COLUMN model_run.from_scenario IS
	'True for a run a scenario made (024_scenarios), also once the scenario is deleted and scenario_id is NULL: its inputs.scenario stays (188). Tell a run of the model from a scenario run by this, never by scenario_id IS NULL.';
COMMENT ON COLUMN model_run.scenario_id IS
	'The scenario that produced this run (024_scenarios); NULL for a run of the live model, or once the scenario is deleted (the run''s inputs.scenario still records its ops, and from_scenario stays true, 188). Set on insert only.';

-- ---------------------------------------------------------------------------
-- run_nomination_stamp, from 098_nomination_withdrawal: refuses a scenario
-- run (live or orphaned) and a forecast run.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION run_nomination_stamp() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
		run_project uuid;
		run_engine text;
		run_model text;
		run_scenario boolean;
		run_trigger text;
		latest uuid;
		has_latest boolean;
	BEGIN
		IF uid IS NULL THEN
			RAISE EXCEPTION 'a nomination needs a signed-in user' USING ERRCODE = 'insufficient_privilege';
		END IF;
		-- One nomination at a time per project, so "already the current run",
		-- the history cap and the order below can't race.
		PERFORM pg_advisory_xact_lock(hashtextextended('run_nomination:' || NEW.project_id::text, 0));
		SELECT n.run_id INTO latest FROM run_nomination n WHERE n.project_id = NEW.project_id ORDER BY n.nominated_at DESC LIMIT 1;
		has_latest := FOUND;
		IF NEW.run_id IS NULL THEN
			-- Nothing yet, or the newest row is already a withdrawal.
			IF NOT has_latest OR latest IS NULL THEN
				RAISE EXCEPTION 'no run is nominated as evidence, so there is nothing to withdraw' USING ERRCODE = 'check_violation';
			END IF;
			NEW.runoff_model := NULL;
			NEW.engine_version := NULL;
		ELSE
			SELECT project_id, engine_version, COALESCE(inputs->'settings'->>'runoffModel', 'legacy'), from_scenario, "trigger"
				INTO run_project, run_engine, run_model, run_scenario, run_trigger
				FROM model_run WHERE id = NEW.run_id;
			IF run_project IS DISTINCT FROM NEW.project_id THEN
				RAISE EXCEPTION 'run % belongs to a different project', NEW.run_id USING ERRCODE = 'foreign_key_violation';
			END IF;
			-- A scenario's run, live or of a deleted scenario (188: from_scenario),
			-- is a what-if on a base run, never the catchment as it is.
			IF run_scenario THEN
				RAISE EXCEPTION 'a scenario run cannot be nominated as evidence' USING ERRCODE = 'check_violation';
			END IF;
			-- Evidence is judged on the record; a forecast run's tail is forecast rain (WP-2.12).
			IF run_trigger = 'forecast' THEN
				RAISE EXCEPTION 'a forecast run cannot be nominated as evidence' USING ERRCODE = 'check_violation';
			END IF;
			-- The legacy runoff model doesn't conserve water (audit H1): workbook
			-- comparison only, never evidence.
			IF run_model = 'legacy' THEN
				RAISE EXCEPTION 'a legacy-model run cannot be nominated as evidence' USING ERRCODE = 'check_violation';
			END IF;
			IF has_latest AND latest = NEW.run_id THEN
				RAISE EXCEPTION 'run % is already the nominated evidence run', NEW.run_id USING ERRCODE = 'check_violation';
			END IF;
			NEW.runoff_model := run_model;
			NEW.engine_version := run_engine;
		END IF;
		IF (SELECT count(*) FROM run_nomination WHERE project_id = NEW.project_id) >= 50 THEN
			RAISE EXCEPTION 'the project has reached its nomination limit' USING ERRCODE = 'check_violation';
		END IF;
		NEW.nominated_by := uid;
		NEW.nominated_at := clock_timestamp();
		RETURN NEW;
	END
	$$;

-- ---------------------------------------------------------------------------
-- run_publication_model_run (new): a publication holds a run of the model.
-- ---------------------------------------------------------------------------
CREATE FUNCTION run_publication_model_run() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF EXISTS (SELECT 1 FROM model_run r WHERE r.id = NEW.run_id AND r.from_scenario) THEN
			RAISE EXCEPTION 'a scenario run cannot be published' USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END
	$$;
-- INSERT only: water_app can't update run_id (022, column grants).
CREATE TRIGGER run_publication_model_run BEFORE INSERT ON run_publication
	FOR EACH ROW EXECUTE FUNCTION run_publication_model_run();
REVOKE ALL ON FUNCTION run_publication_model_run() FROM PUBLIC, water_app;

-- ---------------------------------------------------------------------------
-- scenario_guard, from 163_licensing_authority: a scenario's base is not a
-- scenario run, live or orphaned.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION scenario_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		run_project uuid;
		run_scenario boolean;
		uid uuid := app_current_user_id();
		deciding boolean;
	BEGIN
		IF TG_OP = 'DELETE' THEN
			IF OLD.status IN ('submitted', 'decided') THEN
				RAISE EXCEPTION 'a % scenario can''t be deleted', OLD.status USING ERRCODE = 'check_violation';
			END IF;
			RETURN OLD;
		END IF;
		-- An account going (the owner's or the assessor's): its foreign key clears
		-- owner_user_id or decided_by, nothing else, and only once the account is gone.
		IF TG_OP = 'UPDATE'
			AND (to_jsonb(NEW) - 'decided_by' - 'owner_user_id') = (to_jsonb(OLD) - 'decided_by' - 'owner_user_id')
			AND (NEW.decided_by, NEW.owner_user_id) IS DISTINCT FROM (OLD.decided_by, OLD.owner_user_id)
			AND (NEW.decided_by IS NOT DISTINCT FROM OLD.decided_by
				OR (NEW.decided_by IS NULL AND NOT EXISTS (SELECT 1 FROM app_user u WHERE u.id = OLD.decided_by)))
			AND (NEW.owner_user_id IS NOT DISTINCT FROM OLD.owner_user_id
				OR (NEW.owner_user_id IS NULL AND NOT EXISTS (SELECT 1 FROM app_user u WHERE u.id = OLD.owner_user_id)))
		THEN
			RETURN NEW;
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
			NEW.decision_authority := NULL;
			NEW.decision_date := NULL;
			NEW.decision_reference := '';
			NEW.reasons_received := NULL;
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
			-- 163: a decision is the responsible authority's, recorded by a member acting for it:
			-- every application's, and any outcome on a team scenario (one an editor only marks
			-- decided, with no outcome, records nothing and needs no authority, as before).
			IF deciding AND (OLD.origin = 'applicant' OR NEW.outcome IS NOT NULL) THEN
				IF NOT app_acts_for_authority(NEW.project_id) THEN
					RAISE EXCEPTION 'only a member acting for the responsible authority records its decision' USING ERRCODE = 'insufficient_privilege';
				END IF;
				IF NEW.outcome IS NULL THEN
					RAISE EXCEPTION 'a decision needs an outcome' USING ERRCODE = 'check_violation';
				END IF;
				IF NEW.decision_authority IS NULL OR NEW.decision_date IS NULL OR NEW.reasons_received IS NULL THEN
					RAISE EXCEPTION 'a decision needs the authority, the date of its decision and whether written reasons were received' USING ERRCODE = 'check_violation';
				END IF;
			END IF;
			IF OLD.origin = 'applicant' THEN
				IF deciding THEN
					IF uid IS NOT DISTINCT FROM OLD.owner_user_id OR NOT app_has_role(NEW.project_id, 'editor') THEN
						RAISE EXCEPTION 'only an assessor (an editor who didn''t make it) decides an application' USING ERRCODE = 'insufficient_privilege';
					END IF;
					-- 129: the applicant's answers to Appendix C's prompts are theirs too.
					IF NEW.name IS DISTINCT FROM OLD.name OR NEW.description IS DISTINCT FROM OLD.description
					   OR NEW.purpose_need IS DISTINCT FROM OLD.purpose_need OR NEW.mitigation IS DISTINCT FROM OLD.mitigation
					   OR NEW.monitoring IS DISTINCT FROM OLD.monitoring THEN
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
			   OR NEW.decided_at IS DISTINCT FROM OLD.decided_at OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
			   OR NEW.decision_authority IS DISTINCT FROM OLD.decision_authority OR NEW.decision_date IS DISTINCT FROM OLD.decision_date
			   OR NEW.decision_reference IS DISTINCT FROM OLD.decision_reference OR NEW.reasons_received IS DISTINCT FROM OLD.reasons_received THEN
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
			SELECT project_id, from_scenario INTO run_project, run_scenario FROM model_run WHERE id = NEW.base_run_id;
			IF run_project IS DISTINCT FROM NEW.project_id THEN
				RAISE EXCEPTION 'run % belongs to a different project', NEW.base_run_id USING ERRCODE = 'foreign_key_violation';
			END IF;
			IF run_scenario THEN
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

-- ---------------------------------------------------------------------------
-- From 045_contributor_scope: a published run of the model.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_published_run_input(p_project uuid, p_run uuid) RETURNS TABLE(created_at timestamp with time zone, label text, inputs jsonb, "trigger" text)
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		RETURN QUERY
			SELECT r.created_at, r.label, r.inputs, r."trigger"::text FROM model_run r
			WHERE r.id = p_run AND r.project_id = p_project AND NOT r.from_scenario
			  AND app_has_role(p_project, 'contributor')
			  AND EXISTS (SELECT 1 FROM run_publication p WHERE p.run_id = p_run AND p.project_id = p_project);
	END
	$$;

CREATE OR REPLACE FUNCTION app_published_run_series(p_project uuid, p_run uuid) RETURNS TABLE(kind text, start_date date, sha256 text, "values" double precision[])
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		RETURN QUERY
			SELECT i.kind::text, i.start_date, i.sha256, b."values"
			FROM run_input_series i LEFT JOIN series_blob b ON b.project_id = i.project_id AND b.sha256 = i.sha256
			WHERE i.run_id = p_run AND i.project_id = p_project
			  AND app_has_role(p_project, 'contributor')
			  AND EXISTS (SELECT 1 FROM model_run r WHERE r.id = p_run AND NOT r.from_scenario)
			  AND EXISTS (SELECT 1 FROM run_publication p WHERE p.run_id = p_run AND p.project_id = p_project);
	END
	$$;

-- ---------------------------------------------------------------------------
-- From 056_accepted_series: the newest manual run of the model.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_api_key_accepted_series(p_series uuid) RETURNS TABLE(start_date date, "values" double precision[])
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT i.start_date, b."values"
		FROM time_series t
		JOIN run_input_series i ON i.project_id = t.project_id AND i.series_id = t.id
		JOIN model_run r ON r.id = i.run_id
		JOIN series_blob b ON b.project_id = i.project_id AND b.sha256 = i.sha256
		WHERE t.id = p_series
		  AND t.project_id = app_api_key_project('series:write')
		  AND app_api_key_allows(t.kind, t.name)
		  AND r.trigger = 'manual' AND NOT r.from_scenario
		ORDER BY r.created_at DESC, r.id DESC
		LIMIT 1
	$$;

-- ---------------------------------------------------------------------------
-- From 062_scenario_sweeps, 106_outlook_triggers_publication and
-- 145_assessment: each is based on an ordinary run of the model.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION scenario_sweep_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
		base model_run%ROWTYPE;
	BEGIN
		IF uid IS NULL THEN
			RAISE EXCEPTION 'a sweep needs a signed-in user' USING ERRCODE = 'insufficient_privilege';
		END IF;
		SELECT * INTO base FROM model_run WHERE id = NEW.base_run_id;
		IF base.project_id IS DISTINCT FROM NEW.project_id THEN
			RAISE EXCEPTION 'run % belongs to a different project', NEW.base_run_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		IF base.from_scenario OR base."trigger" = 'forecast' THEN
			RAISE EXCEPTION 'a sweep is based on an ordinary run of the model' USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.job_id IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM job j WHERE j.id = NEW.job_id AND j.project_id = NEW.project_id AND j.kind = 'sweep'
		) THEN
			RAISE EXCEPTION 'job % is not a sweep job of this project', NEW.job_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		NEW.status := 'pending';
		NEW.engine_version := NULL;
		NEW.completed_at := NULL;
		NEW.created_by := uid;
		NEW.created_at := clock_timestamp();
		RETURN NEW;
	END
	$$;

CREATE OR REPLACE FUNCTION seasonal_outlook_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
		base model_run%ROWTYPE;
	BEGIN
		IF uid IS NULL THEN
			RAISE EXCEPTION 'an outlook needs a signed-in user' USING ERRCODE = 'insufficient_privilege';
		END IF;
		SELECT * INTO base FROM model_run WHERE id = NEW.base_run_id;
		IF base.project_id IS DISTINCT FROM NEW.project_id THEN
			RAISE EXCEPTION 'run % belongs to a different project', NEW.base_run_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		IF base.from_scenario OR base."trigger" = 'forecast' THEN
			RAISE EXCEPTION 'an outlook is based on an ordinary run of the model' USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.job_id IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM job j WHERE j.id = NEW.job_id AND j.project_id = NEW.project_id AND j.kind = 'outlook'
		) THEN
			RAISE EXCEPTION 'job % is not an outlook job of this project', NEW.job_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		NEW.status := 'pending';
		NEW.result := NULL;
		NEW.triggers := NULL;
		NEW.engine_version := NULL;
		NEW.completed_at := NULL;
		NEW.created_by := uid;
		NEW.created_at := clock_timestamp();
		RETURN NEW;
	END
	$$;

CREATE OR REPLACE FUNCTION assessment_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
		base model_run%ROWTYPE;
	BEGIN
		IF uid IS NULL THEN
			RAISE EXCEPTION 'an assessment needs a signed-in user' USING ERRCODE = 'insufficient_privilege';
		END IF;
		SELECT * INTO base FROM model_run WHERE id = NEW.base_run_id;
		IF base.project_id IS DISTINCT FROM NEW.project_id THEN
			RAISE EXCEPTION 'run % belongs to a different project', NEW.base_run_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		IF base.from_scenario OR base."trigger" = 'forecast' THEN
			RAISE EXCEPTION 'an assessment is based on an ordinary run of the model' USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.job_id IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM job j WHERE j.id = NEW.job_id AND j.project_id = NEW.project_id AND j.kind = 'assessment'
		) THEN
			RAISE EXCEPTION 'job % is not an assessment job of this project', NEW.job_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		NEW.status := 'pending';
		NEW.problems := '[]';
		NEW.report := NULL;
		NEW.combined_summary := NULL;
		NEW.start_date := NULL;
		NEW.end_date := NULL;
		NEW.engine_version := NULL;
		NEW.completed_at := NULL;
		NEW.created_by := uid;
		NEW.created_at := clock_timestamp();
		RETURN NEW;
	END
	$$;

-- ---------------------------------------------------------------------------
-- From 112_evidence_pack: the baseline is a run of the model.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION evidence_pack_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		-- Everything but the lifecycle columns: frozen from the insert.
		lifecycle constant text[] := ARRAY['status', 'issued_at', 'issued_by', 'status_reason', 'superseded_by_pack_id',
			'pdf_key', 'pdf_sha256', 'pdf_pages', 'bundle_key', 'bundle_sha256', 'created_by'];
		pred record;
		succ record;
	BEGIN
		IF TG_OP = 'INSERT' THEN
			IF NEW.status <> 'draft' OR NEW.issued_at IS NOT NULL OR NEW.issued_by IS NOT NULL OR NEW.superseded_by_pack_id IS NOT NULL
				OR NEW.status_reason IS NOT NULL THEN
				RAISE EXCEPTION 'an evidence pack is created as a draft' USING ERRCODE = 'check_violation';
			END IF;
			-- The baseline is a run of the model itself; the application run is its scenario's.
			IF EXISTS (SELECT 1 FROM model_run WHERE id = NEW.baseline_run_id AND from_scenario) THEN
				RAISE EXCEPTION 'an evidence pack''s baseline is not a scenario run' USING ERRCODE = 'check_violation';
			END IF;
			IF NEW.scenario_run_id IS NOT NULL
				AND NOT EXISTS (SELECT 1 FROM model_run WHERE id = NEW.scenario_run_id AND scenario_id = NEW.scenario_id) THEN
				RAISE EXCEPTION 'an evidence pack''s application run is a run of its scenario' USING ERRCODE = 'check_violation';
			END IF;
			-- The manifest is this row's: its pack id and version, project, engine and report versions are the columns'.
			-- (Its SHA-256 is the backend's to check: SQL has no RFC 8785.)
			IF NEW.manifest->'pack'->>'id' IS DISTINCT FROM NEW.id::text
				OR NEW.manifest->'pack'->>'version' IS DISTINCT FROM NEW.version::text
				OR NEW.manifest->'project'->>'id' IS DISTINCT FROM NEW.project_id::text
				OR NEW.manifest->'engine'->>'version' IS DISTINCT FROM NEW.engine_version
				OR NEW.manifest->'report'->>'version' IS DISTINCT FROM NEW.report_version THEN
				RAISE EXCEPTION 'an evidence pack''s manifest names another pack, version, project or engine' USING ERRCODE = 'check_violation';
			END IF;
			IF NEW.supersedes_pack_id IS NOT NULL THEN
				SELECT version, status, scenario_id INTO pred FROM evidence_pack WHERE id = NEW.supersedes_pack_id;
				IF NOT FOUND OR pred.status <> 'issued' OR NEW.version <> pred.version + 1
					OR pred.scenario_id IS DISTINCT FROM NEW.scenario_id THEN
					RAISE EXCEPTION 'a new version of an evidence pack supersedes an issued pack of the same application (or baseline evidence), as its version + 1'
						USING ERRCODE = 'check_violation';
				END IF;
			END IF;
			RETURN NEW;
		END IF;

		IF (to_jsonb(NEW) - lifecycle) IS DISTINCT FROM (to_jsonb(OLD) - lifecycle) THEN
			RAISE EXCEPTION 'evidence pack % is frozen: only its status, reason, successor, PDF and bundle change', OLD.id
				USING ERRCODE = 'check_violation';
		END IF;
		-- An account deletion clears who made or issued it (the foreign key's SET NULL), nothing else.
		IF NEW.created_by IS DISTINCT FROM OLD.created_by
			AND NOT (NEW.created_by IS NULL AND NOT EXISTS (SELECT 1 FROM app_user WHERE id = OLD.created_by)) THEN
			RAISE EXCEPTION 'who created evidence pack % never changes', OLD.id USING ERRCODE = 'check_violation';
		END IF;

		IF NEW.status IS DISTINCT FROM OLD.status THEN
			IF NOT ((OLD.status = 'draft' AND NEW.status IN ('issued', 'withdrawn'))
				OR (OLD.status = 'issued' AND NEW.status IN ('superseded', 'withdrawn'))
				OR (OLD.status = 'superseded' AND NEW.status = 'withdrawn')) THEN
				RAISE EXCEPTION 'evidence pack % can''t move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'check_violation';
			END IF;
		END IF;

		IF OLD.status = 'draft' AND NEW.status = 'issued' THEN
			IF NOT EXISTS (SELECT 1 FROM signoff WHERE pack_id = OLD.id) THEN
				RAISE EXCEPTION 'evidence pack % has no sign-off, so it can''t be issued', OLD.id USING ERRCODE = 'check_violation';
			END IF;
			IF app_current_user_id() IS NULL THEN
				RAISE EXCEPTION 'an evidence pack is issued by a signed-in user' USING ERRCODE = 'check_violation';
			END IF;
			NEW.issued_at := now();
			NEW.issued_by := app_current_user_id();
		ELSE
			IF NEW.issued_at IS DISTINCT FROM OLD.issued_at THEN
				RAISE EXCEPTION 'evidence pack % was issued once, when it was', OLD.id USING ERRCODE = 'check_violation';
			END IF;
			IF NEW.issued_by IS DISTINCT FROM OLD.issued_by
				AND NOT (NEW.issued_by IS NULL AND NOT EXISTS (SELECT 1 FROM app_user WHERE id = OLD.issued_by)) THEN
				RAISE EXCEPTION 'who issued evidence pack % never changes', OLD.id USING ERRCODE = 'check_violation';
			END IF;
		END IF;

		IF NEW.status_reason IS DISTINCT FROM OLD.status_reason
			AND NOT (OLD.status_reason IS NULL AND NEW.status = 'withdrawn' AND OLD.status <> 'withdrawn') THEN
			RAISE EXCEPTION 'evidence pack %''s reason is given once, when it is withdrawn', OLD.id USING ERRCODE = 'check_violation';
		END IF;

		IF NEW.superseded_by_pack_id IS DISTINCT FROM OLD.superseded_by_pack_id THEN
			IF NOT (OLD.superseded_by_pack_id IS NULL AND OLD.status = 'issued' AND NEW.status = 'superseded') THEN
				RAISE EXCEPTION 'evidence pack %''s successor is named once, when it is superseded', OLD.id USING ERRCODE = 'check_violation';
			END IF;
			SELECT status, supersedes_pack_id INTO succ FROM evidence_pack WHERE id = NEW.superseded_by_pack_id;
			IF NOT FOUND OR succ.status <> 'issued' OR succ.supersedes_pack_id IS DISTINCT FROM OLD.id THEN
				RAISE EXCEPTION 'evidence pack % is superseded by an issued pack that supersedes it', OLD.id USING ERRCODE = 'check_violation';
			END IF;
		END IF;

		IF (NEW.pdf_key, NEW.pdf_sha256, NEW.pdf_pages) IS DISTINCT FROM (OLD.pdf_key, OLD.pdf_sha256, OLD.pdf_pages) AND OLD.pdf_key IS NOT NULL THEN
			RAISE EXCEPTION 'evidence pack %''s PDF is recorded once', OLD.id USING ERRCODE = 'check_violation';
		END IF;
		IF (NEW.bundle_key, NEW.bundle_sha256) IS DISTINCT FROM (OLD.bundle_key, OLD.bundle_sha256) AND OLD.bundle_key IS NOT NULL THEN
			RAISE EXCEPTION 'evidence pack %''s bundle is recorded once', OLD.id USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END
	$$;

-- ---------------------------------------------------------------------------
-- From 118_applicant_results: the application's base, a run of the model.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_application_run_results(p_project uuid, p_scenario uuid, p_run uuid) RETURNS TABLE(label text, engine_version text, start_date date, end_date date, created_at timestamp with time zone, scenario jsonb, model jsonb, summary jsonb, base_run_id uuid, base_start_date date, base_summary jsonb, all_proposals boolean, farm_holders_ok boolean)
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
			LEFT JOIN model_run b ON b.id::text = r.inputs->'scenario'->>'baseRunId' AND b.project_id = p_project AND NOT b.from_scenario
				AND EXISTS (SELECT 1 FROM run_publication p WHERE p.run_id = b.id AND p.project_id = p_project)
			WHERE r.id = p_run AND r.project_id = p_project AND r.scenario_id = p_scenario;
	END
	$$;

-- ---------------------------------------------------------------------------
-- From 167_signers: whether each run of the pack is a scenario run, for the
-- sign-off statement.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_specialist_pack(p_project uuid, p_pack uuid) RETURNS jsonb
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		p evidence_pack;
	BEGIN
		IF NOT app_pack_specialist(p_project, p_pack) THEN
			RETURN NULL;
		END IF;
		SELECT * INTO p FROM evidence_pack WHERE id = p_pack AND project_id = p_project;
		RETURN jsonb_build_object(
			'id', p.id,
			'scenarioId', p.scenario_id,
			'title', p.manifest->'report'->'identity'->>'title',
			'version', p.version,
			'status', p.status,
			'manifestSha256', p.manifest_sha256,
			'baselineRunId', p.baseline_run_id,
			'scenarioRunId', p.scenario_run_id,
			'createdAt', p.created_at,
			'runs', (
				SELECT coalesce(jsonb_agg(jsonb_build_object(
					'id', r.id,
					'engineVersion', r.engine_version,
					'scenario', r.from_scenario,
					'fitEngineVersion', r.inputs->'settings'->'fitRecord'->>'engineVersion',
					'legacy', coalesce(r.inputs->'settings'->>'runoffModel', 'legacy') = 'legacy',
					'forecast', r."trigger" = 'forecast',
					'stamp', encode(r.stamp, 'hex'),
					'digest', encode(app_run_digest_body(r.id), 'hex')
				)), '[]'::jsonb)
				FROM model_run r WHERE r.project_id = p_project AND (r.id = p.baseline_run_id OR r.id = p.scenario_run_id)
			)
		);
	END
	$$;
