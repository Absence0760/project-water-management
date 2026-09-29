-- 108_auto_calibration — automated calibration under pre-declared rules, run
-- by the server (issue #153; docs/model.md §2.10j, docs/data-model.md
-- § Automated calibrations, docs/api.md § Automated calibration).
--
-- settings.calibrationRules (engine calibrate/rulesSettings.ts) decide the
-- exclusions, the fits and the one kept. A run of them is a row here, written
-- with everything its result depends on (the rules as they stood, their
-- revision, the hash of the model input and the plan: the water years the
-- rules leave out and the cases in order), then fitted one case per
-- `auto_calibration` job, each job queueing the next as the same user, and
-- completed once. The server computes every score, so a stored report is
-- not a client's claim. Applying the kept fit (POST …/apply, or the
-- new-data job itself when the rules say so and are signed off) is the one
-- later change, recorded with who, when, the run it made and the ensemble
-- started on it.
--
-- New data (series/newData.ts) queues a run of the rules through
-- app_enqueue_auto_calibration when settings.calibrationRules.after.onNewData
-- is 'report' or 'apply' (off by default), debounced like the automatic
-- re-run, as the same acting user app_enqueue_rerun picks.
--
-- In this file:
--  * `job.kind` accepts 'auto_calibration' and 'uncertainty' (the server's
--    own run of an uncertainty ensemble, after an automated fit is applied).
--  * `auto_calibration`, with RLS (viewer read, editor write), grants,
--    covering indexes and a guard trigger.
--  * app_enqueue_auto_calibration.

-- ---------------------------------------------------------------------------
-- job: the new kinds
-- ---------------------------------------------------------------------------

-- Latest definition: 063_seasonal_outlook.sql.
ALTER TABLE job DROP CONSTRAINT job_kind_check;
ALTER TABLE job ADD CONSTRAINT job_kind_check
	CHECK (kind IN ('feed_fetch', 'feed_ingest', 'rerun', 'alert_eval', 'report_render', 'yield', 'sweep', 'outlook', 'auto_calibration', 'uncertainty'));

-- ---------------------------------------------------------------------------
-- auto_calibration
-- ---------------------------------------------------------------------------
CREATE TABLE auto_calibration (
	id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id     uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- The job fitting the next case (each queues the next); SET NULL when the 30-day purge deletes it.
	job_id         uuid REFERENCES job(id) ON DELETE SET NULL,
	-- manual: an editor asked (POST …/auto-calibrations). new_data: new observed or rain data queued it.
	"trigger"      text NOT NULL CHECK ("trigger" IN ('manual', 'new_data')),
	-- running: cases still to fit. complete: every case fitted and one (or none) kept. failed: stopped, `error` says why.
	status         text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'complete', 'failed')),
	-- settings.calibrationRules as they stood, and their revision: fixed at insert.
	rules          jsonb NOT NULL CHECK (jsonb_typeof(rules) = 'object'),
	rules_revision integer NOT NULL CHECK (rules_revision >= 1),
	-- SHA-256 (hex) of the model input the plan was made on: every case job refuses another.
	input_sha256   text NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
	-- The engine's AutoCalibrationPlan: fixed at insert.
	plan           jsonb NOT NULL CHECK (jsonb_typeof(plan) = 'object' AND pg_column_size(plan) <= 1048576),
	-- The fitted cases (engine AutoCase), in plan order, one appended per job; at most 8 (RULE_CASES_MAX).
	cases          jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(cases) = 'array' AND jsonb_array_length(cases) <= 8 AND pg_column_size(cases) <= 8388608),
	-- The finished report without its cases (chosen, notes): set on completion.
	report         jsonb CHECK (report IS NULL OR jsonb_typeof(report) = 'object'),
	chosen         smallint CHECK (chosen BETWEEN 0 AND 7),
	error          text CHECK (char_length(error) <= 2000),
	engine_version text NOT NULL CHECK (char_length(engine_version) BETWEEN 1 AND 40),
	created_by     uuid REFERENCES app_user(id) ON DELETE SET NULL,
	created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
	completed_at   timestamptz,
	-- Applying the kept fit: who, when, the run it made and the ensemble started on it.
	applied_by     uuid REFERENCES app_user(id) ON DELETE SET NULL,
	applied_at     timestamptz,
	applied_run_id uuid REFERENCES model_run(id) ON DELETE SET NULL,
	uncertainty_id uuid REFERENCES run_uncertainty(id) ON DELETE SET NULL,
	CHECK ((status = 'running') = (completed_at IS NULL)),
	CHECK (status <> 'complete' OR report IS NOT NULL),
	CHECK (applied_at IS NULL OR (status = 'complete' AND chosen IS NOT NULL))
);
COMMENT ON TABLE auto_calibration IS
	'A run of the project''s calibration rules, fitted by the server one case per job (108_auto_calibration, issue #153). Written with its rules and plan, completed once by whoever it runs as; applying the kept fit is the only later change.';

-- Covering indexes for every foreign key (catalogue.db.test.ts); the first
-- also serves GET /projects/:id/auto-calibrations (newest first).
CREATE INDEX auto_calibration_project_idx ON auto_calibration (project_id, created_at DESC);
CREATE INDEX auto_calibration_job_idx ON auto_calibration (job_id);
CREATE INDEX auto_calibration_created_by_idx ON auto_calibration (created_by);
CREATE INDEX auto_calibration_applied_by_idx ON auto_calibration (applied_by);
CREATE INDEX auto_calibration_applied_run_idx ON auto_calibration (applied_run_id);
CREATE INDEX auto_calibration_uncertainty_idx ON auto_calibration (uncertainty_id);

-- Written running, by a signed-in user, with its job this project's; who and
-- when are stamped here.
CREATE FUNCTION auto_calibration_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
	BEGIN
		IF uid IS NULL THEN
			RAISE EXCEPTION 'an automated calibration needs a signed-in user' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF NEW.job_id IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM job j WHERE j.id = NEW.job_id AND j.project_id = NEW.project_id AND j.kind = 'auto_calibration'
		) THEN
			RAISE EXCEPTION 'job % is not an automated calibration job of this project', NEW.job_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		NEW.status := 'running';
		NEW.cases := '[]';
		NEW.report := NULL;
		NEW.chosen := NULL;
		NEW.error := NULL;
		NEW.completed_at := NULL;
		NEW.applied_by := NULL;
		NEW.applied_at := NULL;
		NEW.applied_run_id := NULL;
		NEW.uncertainty_id := NULL;
		NEW.created_by := uid;
		NEW.created_at := clock_timestamp();
		RETURN NEW;
	END
	$$;
CREATE TRIGGER auto_calibration_guard BEFORE INSERT ON auto_calibration
	FOR EACH ROW EXECUTE FUNCTION auto_calibration_guard();

-- While running, only whoever it runs as (its jobs' acting user) fits it:
-- cases appended, never rewritten, then completed or failed once. After
-- that, a complete run with a kept fit may be applied (once), by any editor,
-- with a run and an ensemble of this project; nothing else changes.
CREATE FUNCTION auto_calibration_update() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
	BEGIN
		-- A foreign key clearing a link (066_account_fk_clears): an account going clears who asked or applied, the job
		-- purge the job, a run trimmed its run and ensemble. Such an update only clears those links and changes nothing
		-- else. water_app can't write created_by or applied_by (the grants below); the others only lose a link.
		IF to_jsonb(NEW) - '{job_id,created_by,applied_by,applied_run_id,uncertainty_id}'::text[]
				= to_jsonb(OLD) - '{job_id,created_by,applied_by,applied_run_id,uncertainty_id}'::text[]
			AND (NEW.job_id IS NULL OR NEW.job_id = OLD.job_id)
			AND (NEW.created_by IS NULL OR NEW.created_by = OLD.created_by)
			AND (NEW.applied_by IS NULL OR NEW.applied_by = OLD.applied_by)
			AND (NEW.applied_run_id IS NULL OR NEW.applied_run_id = OLD.applied_run_id)
			AND (NEW.uncertainty_id IS NULL OR NEW.uncertainty_id = OLD.uncertainty_id)
			AND (NEW.job_id, NEW.created_by, NEW.applied_by, NEW.applied_run_id, NEW.uncertainty_id)
				IS DISTINCT FROM (OLD.job_id, OLD.created_by, OLD.applied_by, OLD.applied_run_id, OLD.uncertainty_id) THEN
			RETURN NEW;
		END IF;
		IF OLD.status = 'running' THEN
			IF uid IS DISTINCT FROM OLD.created_by THEN
				RAISE EXCEPTION 'only whoever an automated calibration runs as can fit it' USING ERRCODE = 'insufficient_privilege';
			END IF;
			-- The first cases must be the ones already stored.
			IF (SELECT COALESCE(jsonb_agg(e ORDER BY n), '[]'::jsonb) FROM jsonb_array_elements(NEW.cases) WITH ORDINALITY t(e, n)
				WHERE n <= jsonb_array_length(OLD.cases)) IS DISTINCT FROM OLD.cases
			THEN
				RAISE EXCEPTION 'fitted cases are appended, never rewritten' USING ERRCODE = 'check_violation';
			END IF;
			IF NEW.applied_at IS NOT NULL OR NEW.applied_by IS NOT NULL OR NEW.applied_run_id IS NOT NULL OR NEW.uncertainty_id IS NOT NULL THEN
				RAISE EXCEPTION 'a running automated calibration can''t be applied' USING ERRCODE = 'check_violation';
			END IF;
			IF NEW.status <> 'running' THEN
				NEW.completed_at := clock_timestamp();
			END IF;
			IF NEW.job_id IS NOT NULL AND NEW.job_id IS DISTINCT FROM OLD.job_id AND NOT EXISTS (
				SELECT 1 FROM job j WHERE j.id = NEW.job_id AND j.project_id = NEW.project_id AND j.kind = 'auto_calibration'
			) THEN
				RAISE EXCEPTION 'job % is not an automated calibration job of this project', NEW.job_id USING ERRCODE = 'foreign_key_violation';
			END IF;
			RETURN NEW;
		END IF;
		IF OLD.status = 'failed' THEN
			RAISE EXCEPTION 'a failed automated calibration is never changed' USING ERRCODE = 'check_violation';
		END IF;
		-- Complete: only the application.
		IF (NEW.status, NEW.cases, NEW.report, NEW.chosen, NEW.error, NEW.completed_at, NEW.job_id)
			IS DISTINCT FROM (OLD.status, OLD.cases, OLD.report, OLD.chosen, OLD.error, OLD.completed_at, OLD.job_id) THEN
			RAISE EXCEPTION 'a complete automated calibration is never changed, only applied' USING ERRCODE = 'check_violation';
		END IF;
		IF OLD.applied_at IS NULL AND NEW.applied_at IS NOT NULL THEN
			NEW.applied_by := uid;
			NEW.applied_at := clock_timestamp();
		ELSIF (NEW.applied_at, NEW.applied_by) IS DISTINCT FROM (OLD.applied_at, OLD.applied_by) THEN
			RAISE EXCEPTION 'an automated calibration is applied once' USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.applied_run_id IS DISTINCT FROM OLD.applied_run_id AND (OLD.applied_run_id IS NOT NULL OR NOT EXISTS (
			SELECT 1 FROM model_run r WHERE r.id = NEW.applied_run_id AND r.project_id = NEW.project_id
		)) THEN
			RAISE EXCEPTION 'the applied run is set once, to a run of this project' USING ERRCODE = 'foreign_key_violation';
		END IF;
		IF NEW.uncertainty_id IS DISTINCT FROM OLD.uncertainty_id AND (OLD.uncertainty_id IS NOT NULL OR NOT EXISTS (
			SELECT 1 FROM run_uncertainty u WHERE u.id = NEW.uncertainty_id AND u.project_id = NEW.project_id AND u.run_id = NEW.applied_run_id
		)) THEN
			RAISE EXCEPTION 'the ensemble is set once, to one of the applied run' USING ERRCODE = 'foreign_key_violation';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER auto_calibration_update BEFORE UPDATE ON auto_calibration
	FOR EACH ROW EXECUTE FUNCTION auto_calibration_update();

-- Read: a viewer (farmers and contributors read nothing, as for model_run).
-- Write: an editor, who is who its jobs run as and who may apply it.
ALTER TABLE auto_calibration ENABLE ROW LEVEL SECURITY;
CREATE POLICY auto_calibration_select ON auto_calibration FOR SELECT USING (app_has_role(project_id, 'viewer'));
CREATE POLICY auto_calibration_insert ON auto_calibration FOR INSERT WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY auto_calibration_update ON auto_calibration FOR UPDATE
	USING (app_has_role(project_id, 'editor'))
	WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY auto_calibration_delete ON auto_calibration FOR DELETE USING (app_has_role(project_id, 'editor'));

GRANT SELECT, INSERT, DELETE ON auto_calibration TO water_app;
-- The outcome and the application only: the rules, plan, input hash, trigger and author are fixed at insert;
-- completed_at and applied_by are stamped by the trigger, never written.
GRANT UPDATE (job_id, status, cases, report, chosen, error, applied_at, applied_run_id, uncertainty_id) ON auto_calibration TO water_app;

-- ---------------------------------------------------------------------------
-- app_enqueue_auto_calibration: new data queues a run of the rules
-- ---------------------------------------------------------------------------

-- As app_enqueue_rerun (042_auto_rerun.sql): an editor, or a live API key of
-- the project (its creator is the acting user); a key whose creator's account
-- was deleted queues nothing. Nothing unless the rules ask for it
-- (calibrationRules.after.onNewData 'report' or 'apply'). One pending per
-- project (dedupe key 'auto_calibration'), pushed back by the automatic
-- re-run's debounce (settings.autoRun.debounceMinutes, default 15) up to 120
-- minutes after it was first queued.
CREATE FUNCTION app_enqueue_auto_calibration(p_project uuid)
	RETURNS uuid
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_actor uuid := app_rerun_acting_user(p_project);
		v_settings jsonb;
		v_on text;
		v_debounce interval;
		v_max_wait constant interval := interval '120 minutes';
		v_id uuid;
	BEGIN
		IF v_actor IS NULL THEN
			IF app_current_user_id() IS NULL AND app_api_key_project('series:write') = p_project THEN
				RETURN NULL;
			END IF;
			RAISE EXCEPTION 'only an editor of the project can queue an automated calibration' USING ERRCODE = 'insufficient_privilege';
		END IF;
		SELECT p.settings INTO v_settings FROM project p WHERE p.id = p_project;
		v_on := v_settings #>> '{calibrationRules,after,onNewData}';
		IF v_on IS NULL OR v_on NOT IN ('report', 'apply') THEN
			RETURN NULL;
		END IF;
		v_debounce := make_interval(mins => CASE
			WHEN jsonb_typeof(v_settings #> '{autoRun,debounceMinutes}') = 'number'
				AND (v_settings #>> '{autoRun,debounceMinutes}')::numeric BETWEEN 0 AND 120
				AND (v_settings #>> '{autoRun,debounceMinutes}')::numeric = trunc((v_settings #>> '{autoRun,debounceMinutes}')::numeric)
			THEN (v_settings #>> '{autoRun,debounceMinutes}')::integer ELSE 15 END);
		PERFORM pg_advisory_xact_lock(hashtextextended('job_auto_calibration:' || p_project::text, 0));

		UPDATE job j SET run_after = LEAST(now() + v_debounce, j.created_at + v_max_wait)
			WHERE j.project_id = p_project AND j.dedupe_key = 'auto_calibration' AND j.status = 'queued'
			RETURNING j.id INTO v_id;
		IF v_id IS NOT NULL THEN RETURN v_id; END IF;
		SELECT j.id INTO v_id FROM job j WHERE j.project_id = p_project AND j.dedupe_key = 'auto_calibration' AND j.status IN ('queued', 'failed');
		IF v_id IS NOT NULL THEN RETURN v_id; END IF;

		INSERT INTO job AS j (project_id, kind, payload, dedupe_key, run_after, max_attempts, acting_user_id)
			VALUES (p_project, 'auto_calibration', jsonb_build_object('start', 'new_data'), 'auto_calibration', now() + v_debounce, 2, v_actor)
			ON CONFLICT (project_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'failed') DO NOTHING
			RETURNING j.id INTO v_id;
		IF v_id IS NOT NULL THEN RETURN v_id; END IF;
		SELECT j.id INTO v_id FROM job j WHERE j.project_id = p_project AND j.dedupe_key = 'auto_calibration' AND j.status IN ('queued', 'failed');
		RETURN v_id;
	END
	$$;
REVOKE ALL ON FUNCTION app_enqueue_auto_calibration(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_enqueue_auto_calibration(uuid) TO water_app;
