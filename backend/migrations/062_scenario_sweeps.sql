-- 062_scenario_sweeps — scenario sweeps as a background job (issue #53 R2;
-- docs/scenarios.md § Sweeps, docs/data-model.md § Scenario sweeps,
-- docs/api.md § Sweeps, docs/design/planning-outputs.md §3.2).
--
-- A sweep is one saved base run × a list of named members, each an op set
-- (typically `demand.scale` at 1.0, 0.85, 0.7). POST /projects/:id/sweeps
-- writes the sweep, its members and a `sweep` job (the queue, 016_jobs.sql)
-- in one transaction; the job, as the editor who asked and under RLS,
-- applies each member's ops to the base run's stored input and runs the
-- engine, storing each member's run summary (the RunSummary a model_run
-- stores in `summary`) and its catchment-level outcome series or, when its
-- ops don't apply, its problems. A member
-- that can't run never fails the sweep.
--
-- The uncertainty ensemble's pattern (014_run_uncertainty): a row written
-- at the start with everything the result depends on (the base run and each
-- member's ops, fixed by the column grants), then completed once by whoever
-- started it, and never changed after. Unlike an ensemble a sweep is not
-- evidence: an editor may delete one, and the API keeps the newest 20 per
-- project. A sweep goes with its base run (cascade), like a yield result.
--
-- In this file:
--  * `job.kind` accepts 'sweep'.
--  * `scenario_sweep` and `scenario_sweep_member`, with RLS (viewer read,
--    editor write), grants, covering indexes, and same-project guard
--    triggers.

-- ---------------------------------------------------------------------------
-- job: the new kind
-- ---------------------------------------------------------------------------

-- Latest definition: 040_yield.sql.
ALTER TABLE job DROP CONSTRAINT job_kind_check;
ALTER TABLE job ADD CONSTRAINT job_kind_check
	CHECK (kind IN ('feed_fetch', 'feed_ingest', 'rerun', 'alert_eval', 'report_render', 'yield', 'sweep'));

-- ---------------------------------------------------------------------------
-- scenario_sweep
-- ---------------------------------------------------------------------------
CREATE TABLE scenario_sweep (
	id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id     uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- The saved run every member's ops apply to (its stored input). Never a
	-- scenario run or a forecast run (the guard). The sweep goes with it.
	base_run_id    uuid NOT NULL REFERENCES model_run(id) ON DELETE CASCADE,
	-- The job that computes it; SET NULL when the 30-day purge deletes the job.
	job_id         uuid REFERENCES job(id) ON DELETE SET NULL,
	name           text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
	-- pending: written, the job hasn't finished it. complete: every member has an outcome.
	status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'complete')),
	-- The engine that ran the members; set on completion.
	engine_version text CHECK (char_length(engine_version) BETWEEN 1 AND 40),
	created_by     uuid REFERENCES app_user(id) ON DELETE SET NULL,
	created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
	completed_at   timestamptz,
	CHECK ((status = 'complete') = (completed_at IS NOT NULL AND engine_version IS NOT NULL))
);
COMMENT ON TABLE scenario_sweep IS
	'A base run × named op sets, run as one sweep job (062_scenario_sweeps, issue #53 R2). Written pending with its members, completed once by whoever asked; an editor may delete it.';

-- Covering indexes for every foreign key (catalogue.db.test.ts); the first
-- also serves GET /projects/:id/sweeps (newest first).
CREATE INDEX scenario_sweep_project_idx ON scenario_sweep (project_id, created_at DESC);
CREATE INDEX scenario_sweep_base_run_idx ON scenario_sweep (base_run_id);
CREATE INDEX scenario_sweep_job_idx ON scenario_sweep (job_id);
CREATE INDEX scenario_sweep_created_by_idx ON scenario_sweep (created_by);

-- Its base run and job are its own project's; the base run is an ordinary
-- run of the model; who and when are stamped here; it starts pending.
CREATE FUNCTION scenario_sweep_guard() RETURNS trigger
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
		IF base.scenario_id IS NOT NULL OR base."trigger" = 'forecast' THEN
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
CREATE TRIGGER scenario_sweep_guard BEFORE INSERT ON scenario_sweep
	FOR EACH ROW EXECUTE FUNCTION scenario_sweep_guard();

-- A pending sweep is completed once, by whoever asked for it (its job runs
-- as them); after that it is fixed.
CREATE FUNCTION scenario_sweep_complete() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF OLD.status <> 'pending' THEN
			RAISE EXCEPTION 'a sweep is completed once and never changed' USING ERRCODE = 'check_violation';
		END IF;
		IF app_current_user_id() IS DISTINCT FROM OLD.created_by THEN
			RAISE EXCEPTION 'only whoever asked for a sweep can complete it' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF NEW.status <> 'complete' THEN
			RAISE EXCEPTION 'a pending sweep can only be completed' USING ERRCODE = 'check_violation';
		END IF;
		IF EXISTS (SELECT 1 FROM scenario_sweep_member m WHERE m.sweep_id = OLD.id AND m.status = 'pending') THEN
			RAISE EXCEPTION 'every member of a sweep needs an outcome before it is complete' USING ERRCODE = 'check_violation';
		END IF;
		NEW.completed_at := clock_timestamp();
		RETURN NEW;
	END
	$$;
CREATE TRIGGER scenario_sweep_complete BEFORE UPDATE ON scenario_sweep
	FOR EACH ROW EXECUTE FUNCTION scenario_sweep_complete();

-- Read: a viewer (farmers and contributors read nothing, as for model_run).
-- Write: an editor, who is who a sweep job runs as.
ALTER TABLE scenario_sweep ENABLE ROW LEVEL SECURITY;
CREATE POLICY scenario_sweep_select ON scenario_sweep FOR SELECT USING (app_has_role(project_id, 'viewer'));
CREATE POLICY scenario_sweep_insert ON scenario_sweep FOR INSERT WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY scenario_sweep_update ON scenario_sweep FOR UPDATE
	USING (app_has_role(project_id, 'editor') AND status = 'pending')
	WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY scenario_sweep_delete ON scenario_sweep FOR DELETE USING (app_has_role(project_id, 'editor'));

GRANT SELECT, INSERT, DELETE ON scenario_sweep TO water_app;
-- The outcome only: the base run, job, name and author are fixed at insert.
GRANT UPDATE (status, engine_version, completed_at) ON scenario_sweep TO water_app;

-- ---------------------------------------------------------------------------
-- scenario_sweep_member
-- ---------------------------------------------------------------------------
CREATE TABLE scenario_sweep_member (
	id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	sweep_id    uuid NOT NULL REFERENCES scenario_sweep(id) ON DELETE CASCADE,
	project_id  uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- The member's place in the sweep, from 0. At most 12 members (SWEEP_MEMBERS_MAX).
	position    smallint NOT NULL CHECK (position BETWEEN 0 AND 11),
	name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
	-- The op set, as validated by the API (scenarios/schema.ts checkOps), and
	-- its RFC 8785 SHA-256, as scenario.ops / ops_sha256.
	ops         jsonb NOT NULL CHECK (jsonb_typeof(ops) = 'array' AND octet_length(ops::text) <= 262144),
	ops_sha256  text NOT NULL CHECK (ops_sha256 ~ '^[0-9a-f]{64}$'),
	-- pending: not run yet. done: `summary` holds its run summary.
	-- problems: its ops don't apply to the base run, `problems` says why.
	-- failed: the engine refused the input, `problems` holds its message.
	status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'problems', 'failed')),
	problems    jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(problems) = 'array' AND octet_length(problems::text) <= 65536),
	-- The engine's RunSummary, the shape model_run.summary stores.
	summary     jsonb CHECK (jsonb_typeof(summary) = 'object'),
	-- The catchment-level daily series R4's outcome matrix and R5's outlook
	-- read (RunSeries[], nodeId null: natural_flow, simulated_outflow, ewr,
	-- ewr_shortfall; SWEEP_SERIES_KEYS), a missing value as null. Not every
	-- node's series: a sweep is not a run.
	series      jsonb CHECK (jsonb_typeof(series) = 'array'),
	start_date  date,
	end_date    date,
	finished_at timestamptz,
	CHECK ((status = 'done') = (summary IS NOT NULL AND series IS NOT NULL)),
	CHECK ((status = 'pending') = (finished_at IS NULL)),
	CHECK (status NOT IN ('problems', 'failed') OR jsonb_array_length(problems) > 0)
);
COMMENT ON TABLE scenario_sweep_member IS
	'One named op set of a sweep (062_scenario_sweeps): its ops fixed at insert, then its outcome once: a run summary, or the problems that kept it from running.';

-- Covering indexes: the unique index leads with sweep_id; names are unique within a sweep.
CREATE UNIQUE INDEX scenario_sweep_member_position_idx ON scenario_sweep_member (sweep_id, position);
CREATE UNIQUE INDEX scenario_sweep_member_name_idx ON scenario_sweep_member (sweep_id, lower(name));
CREATE INDEX scenario_sweep_member_project_idx ON scenario_sweep_member (project_id);

-- Its sweep is its own project's and still pending; it starts pending.
CREATE FUNCTION scenario_sweep_member_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		sw scenario_sweep%ROWTYPE;
	BEGIN
		SELECT * INTO sw FROM scenario_sweep WHERE id = NEW.sweep_id;
		IF sw.project_id IS DISTINCT FROM NEW.project_id THEN
			RAISE EXCEPTION 'sweep % belongs to a different project', NEW.sweep_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		IF sw.status <> 'pending' THEN
			RAISE EXCEPTION 'a complete sweep takes no new members' USING ERRCODE = 'check_violation';
		END IF;
		NEW.status := 'pending';
		NEW.problems := '[]';
		NEW.summary := NULL;
		NEW.series := NULL;
		NEW.start_date := NULL;
		NEW.end_date := NULL;
		NEW.finished_at := NULL;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER scenario_sweep_member_guard BEFORE INSERT ON scenario_sweep_member
	FOR EACH ROW EXECUTE FUNCTION scenario_sweep_member_guard();

-- A pending member gets its outcome once, from whoever asked for the sweep.
CREATE FUNCTION scenario_sweep_member_outcome() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF OLD.status <> 'pending' THEN
			RAISE EXCEPTION 'a sweep member''s outcome is stored once and never changed' USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.status = 'pending' THEN
			RAISE EXCEPTION 'a sweep member''s outcome is done, problems or failed' USING ERRCODE = 'check_violation';
		END IF;
		IF app_current_user_id() IS DISTINCT FROM (SELECT created_by FROM scenario_sweep WHERE id = OLD.sweep_id) THEN
			RAISE EXCEPTION 'only whoever asked for a sweep can store its results' USING ERRCODE = 'insufficient_privilege';
		END IF;
		NEW.finished_at := clock_timestamp();
		RETURN NEW;
	END
	$$;
CREATE TRIGGER scenario_sweep_member_outcome BEFORE UPDATE ON scenario_sweep_member
	FOR EACH ROW EXECUTE FUNCTION scenario_sweep_member_outcome();

ALTER TABLE scenario_sweep_member ENABLE ROW LEVEL SECURITY;
CREATE POLICY scenario_sweep_member_select ON scenario_sweep_member FOR SELECT USING (app_has_role(project_id, 'viewer'));
CREATE POLICY scenario_sweep_member_insert ON scenario_sweep_member FOR INSERT WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY scenario_sweep_member_update ON scenario_sweep_member FOR UPDATE
	USING (app_has_role(project_id, 'editor') AND status = 'pending')
	WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY scenario_sweep_member_delete ON scenario_sweep_member FOR DELETE USING (app_has_role(project_id, 'editor'));

GRANT SELECT, INSERT, DELETE ON scenario_sweep_member TO water_app;
-- The outcome only: the sweep, place, name and ops are fixed at insert.
GRANT UPDATE (status, problems, summary, series, start_date, end_date, finished_at) ON scenario_sweep_member TO water_app;
