-- 145_assessment — cumulative impact assessment (roadmap WP-3.11, issue #287;
-- docs/scenarios.md § Cumulative impact, docs/data-model.md § Assessments,
-- docs/api.md § Assessments).
--
-- An assessment is several scenarios on one base run, each on its own and
-- all together. POST /projects/:id/assessments checks first that the
-- scenarios combine (engine combineScenarios: no two write the same thing,
-- none removes what another uses, every op applies on top of the others)
-- and refuses with the conflicts otherwise; then it writes the assessment,
-- one member per scenario and an `assessment` job (016_jobs.sql) in one
-- transaction. The job, as the editor who asked and under RLS, runs each
-- member alone and all of them together on the base run's stored input and
-- stores each member's run summary and the cumulative report (engine
-- cumulativeImpact: per site and measure the baseline, each alone, all
-- together and the interaction).
--
-- The sweep's pattern (062_scenario_sweeps): a row written at the start with
-- everything its result depends on (the base run, and each member's ops,
-- copied from its scenario by the guard, never from the request), then
-- completed once by whoever asked, and never changed after. Derived, not
-- evidence: an editor may delete one, and the API keeps the newest 20 per
-- project.
--
-- Who reads it: editors only. Contributors never (an assessment reveals
-- other applications), and viewers neither, since it names submitted
-- applications a viewer can't read until they are decided (045).
--
-- In this file:
--  * `job.kind` accepts 'assessment'.
--  * `assessment` and `assessment_member`, with RLS (editor read and write),
--    grants, covering indexes, and guard triggers.

-- ---------------------------------------------------------------------------
-- job: the new kind. From 119_pack_render's list.
-- ---------------------------------------------------------------------------
ALTER TABLE job DROP CONSTRAINT job_kind_check;
ALTER TABLE job ADD CONSTRAINT job_kind_check
	CHECK (kind IN ('feed_fetch', 'feed_ingest', 'rerun', 'alert_eval', 'report_render', 'yield', 'sweep', 'outlook', 'auto_calibration',
		'uncertainty', 'pack_render', 'assessment'));

-- ---------------------------------------------------------------------------
-- assessment
-- ---------------------------------------------------------------------------
CREATE TABLE assessment (
	id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id     uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- The run every member's scenario is based on (its stored input). Never a
	-- scenario run or a forecast run (the guard). The assessment goes with it.
	base_run_id    uuid NOT NULL REFERENCES model_run(id) ON DELETE CASCADE,
	-- The job that computes it; SET NULL when the 30-day purge deletes the job.
	job_id         uuid REFERENCES job(id) ON DELETE SET NULL,
	name           text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
	-- pending: written, the job hasn't finished it. complete: `report` holds
	-- the cumulative report. refused: the scenarios no longer combine on the
	-- base run, or one doesn't apply alone; `problems` says why (written by
	-- the job, which checks again). failed: the engine refused an input;
	-- `problems` holds its message.
	status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'complete', 'refused', 'failed')),
	problems       jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(problems) = 'array' AND octet_length(problems::text) <= 262144),
	-- The engine's CumulativeReport (scenario/cumulative.ts) and the combined
	-- run's summary and window.
	report         jsonb CHECK (jsonb_typeof(report) = 'object'),
	combined_summary jsonb CHECK (jsonb_typeof(combined_summary) = 'object'),
	start_date     date,
	end_date       date,
	-- The engine that ran it; set on completion.
	engine_version text CHECK (char_length(engine_version) BETWEEN 1 AND 40),
	created_by     uuid REFERENCES app_user(id) ON DELETE SET NULL,
	created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
	completed_at   timestamptz,
	CHECK ((status = 'pending') = (completed_at IS NULL)),
	CHECK ((status = 'pending') = (engine_version IS NULL)),
	CHECK ((status = 'complete') = (report IS NOT NULL AND combined_summary IS NOT NULL)),
	CHECK (status NOT IN ('refused', 'failed') OR jsonb_array_length(problems) > 0)
);
COMMENT ON TABLE assessment IS
	'Several scenarios on one base run, each alone and all together, run as one assessment job (145_assessment, WP-3.11). Written pending with its members, completed once by whoever asked; an editor may delete it.';

-- Covering indexes for every foreign key (catalogue.db.test.ts); the first
-- also serves GET /projects/:id/assessments (newest first).
CREATE INDEX assessment_project_idx ON assessment (project_id, created_at DESC);
CREATE INDEX assessment_base_run_idx ON assessment (base_run_id);
CREATE INDEX assessment_job_idx ON assessment (job_id);
CREATE INDEX assessment_created_by_idx ON assessment (created_by);

-- Its base run and job are its own project's; the base run is an ordinary
-- run of the model; who and when are stamped here; it starts pending.
CREATE FUNCTION assessment_guard() RETURNS trigger
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
		IF base.scenario_id IS NOT NULL OR base."trigger" = 'forecast' THEN
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
CREATE TRIGGER assessment_guard BEFORE INSERT ON assessment
	FOR EACH ROW EXECUTE FUNCTION assessment_guard();

-- A pending assessment is completed once, by whoever asked for it (its job
-- runs as them), and only when every member has its outcome; after that it
-- is fixed.
CREATE FUNCTION assessment_complete() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF OLD.status <> 'pending' THEN
			RAISE EXCEPTION 'an assessment is completed once and never changed' USING ERRCODE = 'check_violation';
		END IF;
		IF app_current_user_id() IS DISTINCT FROM OLD.created_by THEN
			RAISE EXCEPTION 'only whoever asked for an assessment can complete it' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF NEW.status = 'pending' THEN
			RAISE EXCEPTION 'a pending assessment can only be completed, refused or failed' USING ERRCODE = 'check_violation';
		END IF;
		IF EXISTS (SELECT 1 FROM assessment_member m WHERE m.assessment_id = OLD.id AND m.status = 'pending') THEN
			RAISE EXCEPTION 'every member of an assessment needs an outcome before it is completed' USING ERRCODE = 'check_violation';
		END IF;
		NEW.completed_at := clock_timestamp();
		RETURN NEW;
	END
	$$;
-- Only on the outcome's columns: the foreign keys' own updates (job_id when
-- the 30-day purge deletes the job, created_by when an account is deleted)
-- set only their column, so they pass, and water_app can't write either.
CREATE TRIGGER assessment_complete
	BEFORE UPDATE OF status, problems, report, combined_summary, start_date, end_date, engine_version, completed_at ON assessment
	FOR EACH ROW EXECUTE FUNCTION assessment_complete();

-- Editors only, read and write (header).
ALTER TABLE assessment ENABLE ROW LEVEL SECURITY;
CREATE POLICY assessment_select ON assessment FOR SELECT USING (app_has_role(project_id, 'editor'));
CREATE POLICY assessment_insert ON assessment FOR INSERT WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY assessment_update ON assessment FOR UPDATE
	USING (app_has_role(project_id, 'editor') AND status = 'pending')
	WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY assessment_delete ON assessment FOR DELETE USING (app_has_role(project_id, 'editor'));

GRANT SELECT, INSERT, DELETE ON assessment TO water_app;
-- The outcome only: the base run, job, name and author are fixed at insert.
GRANT UPDATE (status, problems, report, combined_summary, start_date, end_date, engine_version, completed_at) ON assessment TO water_app;

-- ---------------------------------------------------------------------------
-- assessment_member
-- ---------------------------------------------------------------------------
CREATE TABLE assessment_member (
	id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	assessment_id uuid NOT NULL REFERENCES assessment(id) ON DELETE CASCADE,
	project_id    uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- The scenario it was taken from; SET NULL when a team scenario is
	-- deleted (a submitted or decided application can't be). The copy below
	-- keeps the assessment as it was run.
	scenario_id   uuid REFERENCES scenario(id) ON DELETE SET NULL,
	-- Its place in the assessment, from 0. At most 8 (ASSESSMENT_SCENARIOS_MAX).
	position      smallint NOT NULL CHECK (position BETWEEN 0 AND 7),
	-- Copied from the scenario by assessment_member_guard, never from the
	-- request: what the job runs.
	name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
	origin        text NOT NULL CHECK (origin IN ('team', 'applicant')),
	ops           jsonb NOT NULL CHECK (jsonb_typeof(ops) = 'array' AND octet_length(ops::text) <= 1048576),
	ops_sha256    text NOT NULL CHECK (ops_sha256 ~ '^[0-9a-f]{64}$'),
	owned_node_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(owned_node_ids) <= 500),
	-- pending: not run yet. done: `summary` holds its run alone.
	-- problems: its ops don't apply alone to the base run. failed: the engine
	-- refused the input; `problems` holds its message.
	status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'problems', 'failed')),
	problems      jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(problems) = 'array' AND octet_length(problems::text) <= 65536),
	-- The engine's RunSummary of the scenario alone.
	summary       jsonb CHECK (jsonb_typeof(summary) = 'object'),
	start_date    date,
	end_date      date,
	finished_at   timestamptz,
	CHECK ((status = 'done') = (summary IS NOT NULL)),
	CHECK ((status = 'pending') = (finished_at IS NULL)),
	CHECK (status NOT IN ('problems', 'failed') OR jsonb_array_length(problems) > 0)
);
COMMENT ON TABLE assessment_member IS
	'One scenario of an assessment (145_assessment): its ops copied from the scenario at insert, then its outcome alone once: a run summary, or the problems that kept it from running.';

-- Covering indexes: the unique index leads with assessment_id; a scenario is in an assessment once.
CREATE UNIQUE INDEX assessment_member_position_idx ON assessment_member (assessment_id, position);
CREATE UNIQUE INDEX assessment_member_scenario_idx ON assessment_member (scenario_id, assessment_id);
CREATE INDEX assessment_member_project_idx ON assessment_member (project_id);

-- Its assessment is its own project's and still pending; its scenario is
-- one the caller reads (SECURITY INVOKER: RLS hides a draft application, so
-- it can't be named), based on the assessment's base run, and a team
-- scenario or a submitted or decided application. Everything the job runs
-- is copied from the scenario here; it starts pending.
CREATE FUNCTION assessment_member_guard() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	DECLARE
		a_project uuid;
		a_base uuid;
		a_status text;
		s scenario%ROWTYPE;
	BEGIN
		SELECT project_id, base_run_id, status INTO a_project, a_base, a_status FROM assessment WHERE id = NEW.assessment_id;
		IF a_project IS DISTINCT FROM NEW.project_id THEN
			RAISE EXCEPTION 'assessment % belongs to a different project', NEW.assessment_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		IF a_status <> 'pending' THEN
			RAISE EXCEPTION 'a completed assessment takes no new members' USING ERRCODE = 'check_violation';
		END IF;
		SELECT * INTO s FROM scenario WHERE id = NEW.scenario_id;
		IF s.id IS NULL OR s.project_id IS DISTINCT FROM NEW.project_id THEN
			RAISE EXCEPTION 'scenario % not found', NEW.scenario_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		IF s.base_run_id IS DISTINCT FROM a_base THEN
			RAISE EXCEPTION 'scenario % is based on another run', NEW.scenario_id USING ERRCODE = 'check_violation';
		END IF;
		IF s.origin = 'applicant' AND s.status NOT IN ('submitted', 'decided') THEN
			RAISE EXCEPTION 'an application is assessed once it is submitted' USING ERRCODE = 'check_violation';
		END IF;
		NEW.name := s.name;
		NEW.origin := s.origin;
		NEW.ops := s.ops;
		NEW.ops_sha256 := s.ops_sha256;
		NEW.owned_node_ids := s.owned_node_ids;
		NEW.status := 'pending';
		NEW.problems := '[]';
		NEW.summary := NULL;
		NEW.start_date := NULL;
		NEW.end_date := NULL;
		NEW.finished_at := NULL;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER assessment_member_guard BEFORE INSERT ON assessment_member
	FOR EACH ROW EXECUTE FUNCTION assessment_member_guard();

-- A pending member gets its outcome once, from whoever asked for the assessment.
CREATE FUNCTION assessment_member_outcome() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF OLD.status <> 'pending' THEN
			RAISE EXCEPTION 'an assessment member''s outcome is stored once and never changed' USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.status = 'pending' THEN
			RAISE EXCEPTION 'an assessment member''s outcome is done, problems or failed' USING ERRCODE = 'check_violation';
		END IF;
		IF app_current_user_id() IS DISTINCT FROM (SELECT created_by FROM assessment WHERE id = OLD.assessment_id) THEN
			RAISE EXCEPTION 'only whoever asked for an assessment can store its results' USING ERRCODE = 'insufficient_privilege';
		END IF;
		NEW.finished_at := clock_timestamp();
		RETURN NEW;
	END
	$$;
-- Only on the outcome's columns: deleting a team scenario sets scenario_id
-- NULL through the foreign key, which passes (water_app can't write it).
CREATE TRIGGER assessment_member_outcome
	BEFORE UPDATE OF status, problems, summary, start_date, end_date, finished_at ON assessment_member
	FOR EACH ROW EXECUTE FUNCTION assessment_member_outcome();

ALTER TABLE assessment_member ENABLE ROW LEVEL SECURITY;
CREATE POLICY assessment_member_select ON assessment_member FOR SELECT USING (app_has_role(project_id, 'editor'));
CREATE POLICY assessment_member_insert ON assessment_member FOR INSERT WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY assessment_member_update ON assessment_member FOR UPDATE
	USING (app_has_role(project_id, 'editor') AND status = 'pending')
	WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY assessment_member_delete ON assessment_member FOR DELETE USING (app_has_role(project_id, 'editor'));

GRANT SELECT, INSERT, DELETE ON assessment_member TO water_app;
-- The outcome only: the assessment, place, scenario and its copied ops are fixed at insert.
GRANT UPDATE (status, problems, summary, start_date, end_date, finished_at) ON assessment_member TO water_app;
