-- 191_delineation_request — delineating a catchment too large for the
-- request, on the background worker (docs/design/delineation.md § Where it
-- runs, docs/maps.md § Delineation, followups.md "Delineation of catchments
-- larger than about 100 km across").
--
-- The API delineates around a click within a 20 s budget and a 3 072-cell
-- window (about 100 km at zoom 11). A catchment that still reaches the
-- window's edge was refused (422 too_large). Now the route hands it to the
-- worker instead (300 s Lambda): the same code with larger windows
-- (delineation/delineate.ts JOB_WINDOWS), starting where the request
-- stopped. An editor can also ask for the worker at once (`background`),
-- for a catchment they know is large.
--
-- In this file:
--  1. job.kind accepts 'delineate' (latest list: 165_applicant_copy). Only
--     editors queue it (job_insert, latest: 023_reports, unchanged).
--  2. delineation_request: one click handed to the worker, and what came of
--     it: the proposal it made (a delineation_proposal like any other, then
--     accepted or rejected the usual way), or the refusal, in the same words
--     the request would have answered. The job's own state (queued, running,
--     its progress, a failure) stays on the job row; GET
--     …/map/delineation/requests/:rid joins the two.
--     RLS: viewers read (as proposals); editors queue, and the job writes the
--     outcome as the editor who queued it. The route prunes finished
--     requests beyond the newest 20 a project, and a request goes with its
--     project. The proposal is tied by a composite foreign key (same project
--     by construction), cleared when the proposal is pruned; the job by a
--     plain one, cleared when the 30-day purge deletes the job.
--     Personal data: created_by only (ON DELETE SET NULL); not exported
--     (auth/export.ts), as delineation_proposal.created_by.
--  3. app_cancel_job (latest: 040_yield) also cancels a delineate job: a new
--     click supersedes the same user's waiting one in the project.
--  4. app_release_job: the worker hands a claimed job back to the queue
--     without spending the attempt its claim counted, for a job the tick had
--     too little time left for (a delineate job claimed late in a worker
--     Lambda's 300 s). Not a failure: no backoff, no error kept, and so a
--     valid catchment never goes dead from unlucky ticks.

-- ---------------------------------------------------------------------------
-- 1. job: the new kind
-- ---------------------------------------------------------------------------
ALTER TABLE job DROP CONSTRAINT job_kind_check;
ALTER TABLE job ADD CONSTRAINT job_kind_check
	CHECK (kind IN ('feed_fetch', 'feed_ingest', 'rerun', 'alert_eval', 'report_render', 'yield', 'sweep', 'outlook', 'auto_calibration',
		'uncertainty', 'pack_render', 'assessment', 'pack_reproduce', 'applicant_pack_render', 'delineate'));

-- ---------------------------------------------------------------------------
-- 2. The requests
-- ---------------------------------------------------------------------------
-- The composite key the request's proposal link needs (as map_feature's for the proposal's own feature link).
ALTER TABLE delineation_proposal ADD CONSTRAINT delineation_proposal_id_project_key UNIQUE (id, project_id);

CREATE TABLE delineation_request (
	id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id    uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- The worker's job; NULL until the route links it (same transaction), and again once the purge deletes the job.
	job_id        uuid REFERENCES job(id) ON DELETE SET NULL,
	-- queued: the job has it (the job's row says whether it waits, runs or failed). proposed / refused: the outcome.
	-- superseded: the same editor clicked again before it ran.
	status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'proposed', 'refused', 'superseded')),
	click_kind    text NOT NULL CHECK (click_kind IN ('outlet', 'dam_wall')),
	click_lon     double precision NOT NULL CHECK (click_lon BETWEEN -180 AND 180),
	click_lat     double precision NOT NULL CHECK (click_lat BETWEEN -90 AND 90),
	-- The request's own options: keep the point beside a much larger channel, the river reach picked at a confluence.
	keep_point    boolean NOT NULL DEFAULT false,
	reach         jsonb CHECK (reach IS NULL OR (jsonb_typeof(reach) = 'object' AND octet_length(reach::text) <= 300)),
	-- The smallest window (cells a side) the job tries: the one after the window the request stopped at.
	from_window   integer NOT NULL CHECK (from_window BETWEEN 1 AND 65536),
	proposal_id   uuid,
	refusal_code  text CHECK (refusal_code IN ('outside', 'no_data', 'too_large', 'too_small', 'outline', 'larger_channel', 'confluence', 'off')),
	refusal       text CHECK (char_length(refusal) BETWEEN 1 AND 1000),
	-- With larger_channel: the channel to offer (delineate.ts LargerChannel).
	larger        jsonb CHECK (larger IS NULL OR (jsonb_typeof(larger) = 'object' AND octet_length(larger::text) <= 1000)),
	-- The river-network check that came with the proposal (a reach nearby whose area no channel matched).
	check_note    text CHECK (char_length(check_note) BETWEEN 1 AND 1000),
	created_by    uuid REFERENCES app_user(id) ON DELETE SET NULL,
	created_at    timestamptz NOT NULL DEFAULT now(),
	finished_at   timestamptz,
	CHECK ((status = 'queued') = (finished_at IS NULL)),
	CHECK ((status = 'refused') = (refusal IS NOT NULL AND refusal_code IS NOT NULL)),
	CHECK (proposal_id IS NULL OR status = 'proposed'),
	CHECK (larger IS NULL OR refusal_code = 'larger_channel'),
	CHECK (check_note IS NULL OR status = 'proposed'),
	FOREIGN KEY (proposal_id, project_id) REFERENCES delineation_proposal (id, project_id) ON DELETE SET NULL (proposal_id)
);
-- The project's latest requests (also covers the project_id foreign key).
CREATE INDEX delineation_request_project_idx ON delineation_request (project_id, created_at DESC);
CREATE INDEX delineation_request_job_idx ON delineation_request (job_id);
CREATE INDEX delineation_request_proposal_idx ON delineation_request (proposal_id, project_id);
CREATE INDEX delineation_request_created_by_idx ON delineation_request (created_by);

COMMENT ON TABLE delineation_request IS
	'A click delineated on the background worker, too large for the request (191): the job that has it, then the proposal it made or the refusal. Viewers read; editors queue; the job writes the outcome as its editor.';

-- An outcome is final: once proposed, refused or superseded, only the proposal
-- link may change (cleared by its foreign key) and the job link (cleared by the purge).
CREATE FUNCTION delineation_request_final() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF OLD.status <> 'queued' AND (
			(NEW.id, NEW.project_id, NEW.status, NEW.click_kind, NEW.click_lon, NEW.click_lat, NEW.keep_point, NEW.reach, NEW.from_window,
				NEW.refusal_code, NEW.refusal, NEW.larger, NEW.check_note, NEW.created_at, NEW.finished_at)
			IS DISTINCT FROM
			(OLD.id, OLD.project_id, OLD.status, OLD.click_kind, OLD.click_lon, OLD.click_lat, OLD.keep_point, OLD.reach, OLD.from_window,
				OLD.refusal_code, OLD.refusal, OLD.larger, OLD.check_note, OLD.created_at, OLD.finished_at)
			OR (NEW.proposal_id IS DISTINCT FROM OLD.proposal_id AND NEW.proposal_id IS NOT NULL)
			OR (NEW.job_id IS DISTINCT FROM OLD.job_id AND NEW.job_id IS NOT NULL)
		) THEN
			RAISE EXCEPTION 'a delineation request is finished once, and its outcome stays' USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER delineation_request_final BEFORE UPDATE ON delineation_request
	FOR EACH ROW EXECUTE FUNCTION delineation_request_final();

-- Its job is a delineate job of its own project (as yield_result_guard, 040):
-- on insert, and whenever the route links the job.
CREATE FUNCTION delineation_request_job() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NEW.job_id IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM job j WHERE j.id = NEW.job_id AND j.project_id = NEW.project_id AND j.kind = 'delineate'
		) THEN
			RAISE EXCEPTION 'job % is not a delineate job of this project', NEW.job_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER delineation_request_job BEFORE INSERT OR UPDATE OF job_id, project_id ON delineation_request
	FOR EACH ROW EXECUTE FUNCTION delineation_request_job();

ALTER TABLE delineation_request ENABLE ROW LEVEL SECURITY;
CREATE POLICY delineation_request_select ON delineation_request FOR SELECT USING (app_has_role(project_id, 'viewer'));
CREATE POLICY delineation_request_insert ON delineation_request FOR INSERT
	WITH CHECK (app_has_role(project_id, 'editor') AND created_by = app_current_user_id());
CREATE POLICY delineation_request_update ON delineation_request FOR UPDATE
	USING (app_has_role(project_id, 'editor')) WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY delineation_request_delete ON delineation_request FOR DELETE USING (app_has_role(project_id, 'editor'));
GRANT SELECT, INSERT, UPDATE, DELETE ON delineation_request TO water_app;

-- ---------------------------------------------------------------------------
-- 3. Cancelling a waiting delineate job
-- ---------------------------------------------------------------------------
-- Latest definition: 040_yield.sql. Only the kind list changes.
CREATE OR REPLACE FUNCTION app_cancel_job(p_id uuid) RETURNS text
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
		WHERE j.id = p_id AND j.kind IN ('yield', 'delineate')
		  AND (j.acting_user_id = uid OR app_has_role(j.project_id, 'editor'))
		RETURNING j.status INTO v_status;
		RETURN v_status;
	END
	$$;

-- ---------------------------------------------------------------------------
-- 4. Handing a claimed job back without spending its attempt
-- ---------------------------------------------------------------------------
-- The worker's own call (jobs/runner.ts, a JobRelease from the handler), as
-- app_finish_job: the lease token fences off a worker whose lease ran out.
-- The job is queued again after p_delay_seconds (past the rest of this tick),
-- and the attempt its claim counted is given back. Returns 'queued', or NULL
-- when the lease was lost.
CREATE FUNCTION app_release_job(p_id uuid, p_lease uuid, p_delay_seconds integer) RETURNS text
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_status text;
	BEGIN
		IF p_delay_seconds IS NULL OR p_delay_seconds < 0 OR p_delay_seconds > 3600 THEN
			RAISE EXCEPTION 'a release waits 0 to 3600 s' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		UPDATE job j SET
			status = 'queued',
			attempts = greatest(j.attempts - 1, 0),
			run_after = now() + make_interval(secs => p_delay_seconds),
			locked_until = NULL,
			lease_token = NULL
		WHERE j.id = p_id AND j.status = 'running' AND j.lease_token = p_lease
		RETURNING j.status INTO v_status;
		RETURN v_status;
	END
	$$;
REVOKE ALL ON FUNCTION app_release_job(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_release_job(uuid, uuid, integer) TO water_app;
