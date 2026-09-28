-- 040_yield — firm yield and storage–yield curves (roadmap WP-3.6;
-- docs/model.md §2.13, docs/data-model.md § Yield results, docs/api.md
-- § Yield).
--
-- A `yield` job (the queue from 016_jobs.sql) runs the engine's firm-yield
-- search (packages/engine/src/network/yield.ts) on a saved run's stored
-- inputs, or on a scenario applied to its base run, as the editor who queued
-- it, and stores the result in `yield_result`. Its status is WP-2.8's
-- GET /projects/:id/jobs, now with a progress percentage.
--
-- In this file:
--  * `job.kind` accepts 'yield'.
--  * `job.progress` (0–100, NULL = not reported) and app_job_progress: a
--    long job reports how far it is from outside its own transaction (whose
--    writes nobody sees until it commits). Only the current lease holder can
--    write it, and only while the job is running; the claim resets it.
--  * `job.cancel_requested_at` and app_cancel_job: the user who queued a
--    job, or an editor of its project, cancels it. A waiting job is dead at
--    once ("cancelled"); a running one is flagged, and app_job_progress
--    answers false from then on, so a handler that reports progress stops at
--    its next report.
--  * `yield_result`, with RLS viewer read, editor insert and delete, grants,
--    covering indexes and a same-project trigger.
--
-- The roadmap also widens the job and yield_result policies to "a
-- contributor, for a job on a scenario they own". The contributor role is
-- WP-3.3's and doesn't exist yet; WP-3.3 adds those policies from the latest
-- definitions here (docs/followups.md).

-- ---------------------------------------------------------------------------
-- job: the new kind, and progress
-- ---------------------------------------------------------------------------

-- Latest definition: 016_jobs.sql (the column's inline CHECK, job_kind_check).
ALTER TABLE job DROP CONSTRAINT job_kind_check;
ALTER TABLE job ADD CONSTRAINT job_kind_check
	CHECK (kind IN ('feed_fetch', 'feed_ingest', 'rerun', 'alert_eval', 'report_render', 'yield'));

ALTER TABLE job ADD COLUMN progress smallint CHECK (progress BETWEEN 0 AND 100);
COMMENT ON COLUMN job.progress IS
	'How far a running job is, 0–100, as its handler reports it (app_job_progress); NULL when it reports none. Reset when the job is claimed.';

ALTER TABLE job ADD COLUMN cancel_requested_at timestamptz;
COMMENT ON COLUMN job.cancel_requested_at IS
	'When someone asked to cancel the job while it ran (app_cancel_job); app_job_progress then answers false and the handler stops. NULL = not asked.';

-- The enqueue trigger, from its latest definition (016_jobs.sql), also
-- clearing progress and the cancel flag so an enqueue can't forge them.
CREATE OR REPLACE FUNCTION job_enqueue() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
	BEGIN
		IF uid IS NULL THEN
			RAISE EXCEPTION 'a job needs a signed-in user' USING ERRCODE = 'insufficient_privilege';
		END IF;
		NEW.acting_user_id := uid;
		NEW.status := 'queued';
		NEW.attempts := 0;
		NEW.locked_until := NULL;
		NEW.lease_token := NULL;
		NEW.last_error := NULL;
		NEW.started_at := NULL;
		NEW.finished_at := NULL;
		NEW.progress := NULL;
		NEW.cancel_requested_at := NULL;
		NEW.created_at := now();
		NEW.run_after := GREATEST(COALESCE(NEW.run_after, now()), now());
		IF NEW.run_after > now() + interval '7 days' THEN
			RAISE EXCEPTION 'a job can be delayed by at most 7 days' USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END
	$$;

-- Clear a job's progress when a worker claims it (a retry starts again from
-- 0; a finished job keeps its last value). A trigger rather than a change to app_claim_jobs, whose body stays as
-- 016 wrote it.
CREATE FUNCTION job_progress_reset() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF NEW.lease_token IS NOT NULL AND NEW.lease_token IS DISTINCT FROM OLD.lease_token THEN
			NEW.progress := NULL;
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER job_progress_reset BEFORE UPDATE OF lease_token ON job
	FOR EACH ROW EXECUTE FUNCTION job_progress_reset();

-- Record a running job's progress. Only the current lease's holder (the
-- worker running it) can, as for app_finish_job; anyone else gets false.
-- Called outside the job's own transaction so the status UI sees it at once.
-- Also false once someone asked to cancel the job: the handler stops.
CREATE FUNCTION app_job_progress(p_id uuid, p_lease uuid, p_pct integer) RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_go boolean;
	BEGIN
		IF p_pct IS NULL OR p_pct < 0 OR p_pct > 100 THEN
			RAISE EXCEPTION 'progress is 0–100' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		UPDATE job j SET progress = p_pct
		WHERE j.id = p_id AND j.status = 'running' AND j.lease_token = p_lease
		RETURNING j.cancel_requested_at IS NULL INTO v_go;
		RETURN COALESCE(v_go, false);
	END
	$$;
REVOKE ALL ON FUNCTION app_job_progress(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_job_progress(uuid, uuid, integer) TO water_app;

-- Cancel a job of the kinds a user may cancel (yield only, for now), as the
-- session's user: the one who queued it, or an editor of its project. A
-- queued or retrying job is dead at once; a running one is flagged for its
-- handler (app_job_progress). Returns the job's status afterwards, or NULL
-- when there is no such job for this user (not theirs, not visible, or
-- another kind). SECURITY DEFINER: water_app has no UPDATE on job.
CREATE FUNCTION app_cancel_job(p_id uuid) RETURNS text
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
		v_status text;
	BEGIN
		IF uid IS NULL THEN
			RETURN NULL;
		END IF;
		UPDATE job j SET
			status = CASE WHEN j.status IN ('queued', 'failed') THEN 'dead' ELSE j.status END,
			finished_at = CASE WHEN j.status IN ('queued', 'failed') THEN now() ELSE j.finished_at END,
			last_error = CASE WHEN j.status IN ('queued', 'failed') THEN 'cancelled' ELSE j.last_error END,
			cancel_requested_at = CASE WHEN j.status = 'running' THEN COALESCE(j.cancel_requested_at, now()) ELSE j.cancel_requested_at END
		WHERE j.id = p_id AND j.kind = 'yield'
		  AND (j.acting_user_id = uid OR app_has_role(j.project_id, 'editor'))
		RETURNING j.status INTO v_status;
		RETURN v_status;
	END
	$$;
REVOKE ALL ON FUNCTION app_cancel_job(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_cancel_job(uuid) TO water_app;

-- ---------------------------------------------------------------------------
-- yield_result
-- ---------------------------------------------------------------------------
CREATE TABLE yield_result (
	id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id     uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- What it was computed on: a saved run's stored inputs, or a scenario
	-- applied to its base run. Exactly one. A result goes with its run or
	-- scenario.
	run_id         uuid REFERENCES model_run(id) ON DELETE CASCADE,
	scenario_id    uuid REFERENCES scenario(id) ON DELETE CASCADE,
	-- The dam node, as the input names it. No foreign key: a scenario may add
	-- nodes the live model doesn't have (024_scenarios), and a run may name
	-- nodes deleted since.
	node_id        uuid NOT NULL,
	-- The job that computed it (the UI finds a job's result by it); SET NULL
	-- when the 30-day purge deletes the job.
	job_id         uuid REFERENCES job(id) ON DELETE SET NULL,
	kind           text NOT NULL CHECK (kind IN ('firm', 'curve')),
	-- The search's parameters (pattern, assurance, tolerance, points) and the
	-- engine's points (YieldPoint[]), with the curve's flags. Small: at most
	-- 20 points.
	params         jsonb NOT NULL CHECK (jsonb_typeof(params) = 'object' AND octet_length(params::text) <= 4096),
	points         jsonb NOT NULL CHECK (jsonb_typeof(points) = 'object' AND octet_length(points::text) <= 65536),
	engine_version text NOT NULL CHECK (char_length(engine_version) BETWEEN 1 AND 40),
	created_by     uuid REFERENCES app_user(id) ON DELETE SET NULL,
	created_at     timestamptz NOT NULL DEFAULT now(),
	CHECK ((run_id IS NULL) <> (scenario_id IS NULL))
);
COMMENT ON TABLE yield_result IS
	'A firm yield or storage–yield curve of one dam node on a saved run or a scenario (040_yield, WP-3.6), written by a yield job as its acting user. Historical: it replays the record.';

-- Covering indexes for every foreign key (catalogue.db.test.ts); the first
-- two also serve GET /projects/:id/yield (newest first per run or scenario).
CREATE INDEX yield_result_run_idx ON yield_result (run_id, created_at DESC) WHERE run_id IS NOT NULL;
CREATE INDEX yield_result_scenario_idx ON yield_result (scenario_id, created_at DESC) WHERE scenario_id IS NOT NULL;
CREATE INDEX yield_result_project_idx ON yield_result (project_id);
CREATE INDEX yield_result_job_idx ON yield_result (job_id);
CREATE INDEX yield_result_created_by_idx ON yield_result (created_by);

-- Its run, scenario and job are its own project's; the author is the session's user.
CREATE FUNCTION yield_result_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		NEW.created_by := app_current_user_id();
		NEW.created_at := now();
		IF NEW.run_id IS NOT NULL AND (SELECT project_id FROM model_run WHERE id = NEW.run_id) IS DISTINCT FROM NEW.project_id THEN
			RAISE EXCEPTION 'run % belongs to a different project', NEW.run_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		IF NEW.scenario_id IS NOT NULL AND (SELECT project_id FROM scenario WHERE id = NEW.scenario_id) IS DISTINCT FROM NEW.project_id THEN
			RAISE EXCEPTION 'scenario % belongs to a different project', NEW.scenario_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		IF NEW.job_id IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM job j WHERE j.id = NEW.job_id AND j.project_id = NEW.project_id AND j.kind = 'yield'
		) THEN
			RAISE EXCEPTION 'job % is not a yield job of this project', NEW.job_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		RETURN NEW;
	END
	$$;
-- INSERT only: water_app has no UPDATE on the table.
CREATE TRIGGER yield_result_guard BEFORE INSERT ON yield_result
	FOR EACH ROW EXECUTE FUNCTION yield_result_guard();

-- Read: a viewer (farmers read nothing, as for model_run). Write: an editor,
-- who is who a yield job runs as. Delete: an editor (the handler keeps the
-- newest few per dam).
ALTER TABLE yield_result ENABLE ROW LEVEL SECURITY;
CREATE POLICY yield_result_select ON yield_result FOR SELECT USING (app_has_role(project_id, 'viewer'));
CREATE POLICY yield_result_insert ON yield_result FOR INSERT WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY yield_result_delete ON yield_result FOR DELETE USING (app_has_role(project_id, 'editor'));

GRANT SELECT, INSERT, DELETE ON yield_result TO water_app;
