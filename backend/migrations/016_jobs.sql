-- 016_jobs — the background job queue (roadmap WP-2.8, issue #10 part 1;
-- docs/architecture.md § Background work, docs/data-model.md § Jobs,
-- docs/security.md § Authorization).
--
-- The `job` table is the queue's source of truth in every environment: its
-- status, debounce (run_after), dedupe, retries and history. A transport (the
-- local worker's poll + LISTEN, or SQS in production) only wakes a worker;
-- what runs is always whatever this table says is due.
--
-- Who can do what:
--   * Enqueue (INSERT): an editor of the project, as themselves. The insert
--     trigger stamps the enqueuer as the job's acting user and resets every
--     lifecycle column, so an enqueue can't forge a running or finished job.
--   * Read (SELECT): any viewer of the project (the status UI).
--   * Nothing in the app UPDATEs or DELETEs a job row directly: water_app has
--     no such grant and there is no such policy. Claiming, finishing and the
--     30-day purge cross projects, so they are SECURITY DEFINER functions,
--     like app_accept_invites (004_email): pre-auth-style helpers that return
--     only the columns a worker needs to route a job, never its payload.
--   * A job runs as its acting user inside withUser, under normal RLS: the
--     worker reads the payload and does the work with that user's rights, and
--     a user who lost the role gets nothing (the job fails closed). There is
--     no principal that bypasses RLS.

CREATE TABLE job (
	id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id     uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- Every kind the roadmap names, so step 2's later work packages (feeds,
	-- alerts, reports) need no CHECK change to plug a handler in.
	kind           text NOT NULL CHECK (kind IN ('feed_fetch', 'feed_ingest', 'rerun', 'alert_eval', 'report_render')),
	-- Well under SQS's 256 KB, so a payload can always ride a message.
	payload        jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 262144),
	-- At most one pending (queued or failed-and-retrying) job per key per
	-- project (job_dedupe_idx), and a pending job waits while one with its
	-- key is running (app_claim_jobs).
	dedupe_key     text CHECK (dedupe_key IS NULL OR char_length(dedupe_key) BETWEEN 1 AND 200),
	status         text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'dead')),
	run_after      timestamptz NOT NULL DEFAULT now(),
	attempts       integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
	max_attempts   integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
	-- A running job's lease. A worker that dies leaves the job to be claimed
	-- again once the lease runs out; the token fences off the old worker.
	locked_until   timestamptz,
	lease_token    uuid,
	-- Sanitised by the worker (jobs/errors.ts): never raw database text.
	last_error     text CHECK (last_error IS NULL OR char_length(last_error) <= 500),
	acting_user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
	created_at     timestamptz NOT NULL DEFAULT now(),
	started_at     timestamptz,
	finished_at    timestamptz,
	CHECK ((status = 'running') = (locked_until IS NOT NULL AND lease_token IS NOT NULL)),
	CHECK ((status IN ('done', 'dead')) = (finished_at IS NOT NULL))
);
-- What the claim scans: due work by status and time.
CREATE INDEX job_due_idx ON job (status, run_after);
-- Covering indexes for every foreign key (catalogue.db.test.ts); project_id
-- leads the status list's order.
CREATE INDEX job_project_idx ON job (project_id, created_at DESC);
CREATE INDEX job_acting_user_idx ON job (acting_user_id);
CREATE UNIQUE INDEX job_dedupe_idx ON job (project_id, dedupe_key)
	WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'failed');
-- The purge: finished jobs by age.
CREATE INDEX job_finished_idx ON job (finished_at) WHERE finished_at IS NOT NULL;

COMMENT ON TABLE job IS
	'Background job queue, the source of truth for every transport (016_jobs, WP-2.8). water_app may SELECT (viewer) and INSERT (editor, as the acting user); claim, finish and purge go through the SECURITY DEFINER app_claim_jobs / app_finish_job / app_purge_jobs.';
COMMENT ON COLUMN job.status IS
	'queued (waiting for run_after) → running (leased) → done; or failed (an attempt failed, retry at run_after = now + 2^attempts minutes) → … → dead (out of attempts, or a failure no retry can fix).';
COMMENT ON COLUMN job.acting_user_id IS 'The editor who enqueued it. The job runs as this user under RLS and fails closed if they lost the role.';

-- An enqueue is a fresh queued job, as the signed-in user, due now or later
-- (at most a week out). Whatever else the caller sent is overwritten.
CREATE FUNCTION job_enqueue() RETURNS trigger
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
		NEW.created_at := now();
		NEW.run_after := GREATEST(COALESCE(NEW.run_after, now()), now());
		IF NEW.run_after > now() + interval '7 days' THEN
			RAISE EXCEPTION 'a job can be delayed by at most 7 days' USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER job_enqueue BEFORE INSERT ON job
	FOR EACH ROW EXECUTE FUNCTION job_enqueue();

-- Wakes the local worker (LISTEN job_queued, jobs/worker.ts) at commit. The
-- payload says nothing about the job: the worker reads the table.
CREATE FUNCTION job_notify() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		PERFORM pg_notify('job_queued', '');
		RETURN NULL;
	END
	$$;
CREATE TRIGGER job_notify AFTER INSERT ON job
	FOR EACH STATEMENT EXECUTE FUNCTION job_notify();

ALTER TABLE job ENABLE ROW LEVEL SECURITY;
CREATE POLICY job_select ON job FOR SELECT USING (app_has_role(project_id, 'viewer'));
CREATE POLICY job_insert ON job FOR INSERT
	WITH CHECK (app_has_role(project_id, 'editor') AND acting_user_id = app_current_user_id());

GRANT SELECT, INSERT ON job TO water_app;

-- Claim up to p_limit due jobs for p_lease: queued or failed jobs whose
-- run_after has come, and running jobs whose lease ran out (their worker
-- died). A job waits while another job with its dedupe key is running, so two
-- runs of the same work never overlap. FOR UPDATE SKIP LOCKED makes
-- concurrent claimers take disjoint rows. A running job whose lease ran out
-- with no attempts left is dead, not claimed again.
--
-- Returns routing columns only (no payload): the worker reads the payload as
-- the acting user, under RLS.
CREATE FUNCTION app_claim_jobs(p_limit integer, p_lease interval)
	RETURNS TABLE (id uuid, project_id uuid, kind text, acting_user_id uuid, lease_token uuid, attempts integer, max_attempts integer)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 OR p_lease IS NULL OR p_lease < interval '10 seconds' OR p_lease > interval '1 hour' THEN
			RAISE EXCEPTION 'claim 1–100 jobs for a lease of 10 s to 1 h' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		UPDATE job j SET status = 'dead', finished_at = now(), locked_until = NULL, lease_token = NULL,
			last_error = 'the worker stopped before the job finished, and it has no attempts left'
		WHERE j.status = 'running' AND j.locked_until < now() AND j.attempts >= j.max_attempts;
		RETURN QUERY
		WITH due AS (
			SELECT d.id FROM job d
			WHERE ((d.status IN ('queued', 'failed') AND d.run_after <= now())
				OR (d.status = 'running' AND d.locked_until < now()))
			  AND (d.dedupe_key IS NULL OR NOT EXISTS (
				SELECT 1 FROM job r
				WHERE r.project_id = d.project_id AND r.dedupe_key = d.dedupe_key AND r.status = 'running' AND r.id <> d.id))
			ORDER BY d.run_after, d.created_at
			LIMIT p_limit
			FOR UPDATE SKIP LOCKED
		), claimed AS (
			UPDATE job j SET status = 'running', attempts = j.attempts + 1, locked_until = now() + p_lease,
				lease_token = gen_random_uuid(), started_at = now()
			FROM due WHERE j.id = due.id
			RETURNING j.id, j.project_id, j.kind, j.acting_user_id, j.lease_token, j.attempts, j.max_attempts
		)
		SELECT * FROM claimed;
	END
	$$;

-- Record the outcome of a claimed job. Only the holder of the current lease
-- can: a worker whose lease ran out (and whose job someone else claimed)
-- gets NULL back and must roll back its work. A failure with attempts left
-- and p_retry is retried after 2^attempts minutes; otherwise it is dead.
-- p_error is stored as given (≤ 500 characters): the caller sanitises it.
-- Returns the job's new status.
CREATE FUNCTION app_finish_job(p_id uuid, p_lease uuid, p_ok boolean, p_error text DEFAULT NULL, p_retry boolean DEFAULT true)
	RETURNS text
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_status text;
	BEGIN
		UPDATE job j SET
			status = CASE WHEN p_ok THEN 'done' WHEN p_retry AND j.attempts < j.max_attempts THEN 'failed' ELSE 'dead' END,
			run_after = CASE WHEN NOT p_ok AND p_retry AND j.attempts < j.max_attempts
				THEN now() + make_interval(mins => power(2, j.attempts)::integer) ELSE j.run_after END,
			last_error = CASE WHEN p_ok THEN NULL ELSE left(COALESCE(NULLIF(p_error, ''), 'failed'), 500) END,
			finished_at = CASE WHEN p_ok OR NOT p_retry OR j.attempts >= j.max_attempts THEN now() END,
			locked_until = NULL,
			lease_token = NULL
		WHERE j.id = p_id AND j.status = 'running' AND j.lease_token = p_lease
		RETURNING j.status INTO v_status;
		RETURN v_status;
	END
	$$;

-- Delete finished (done or dead) jobs older than p_age (at least a day; the
-- tick passes 30 days). Returns how many went.
CREATE FUNCTION app_purge_jobs(p_age interval) RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		n integer;
	BEGIN
		IF p_age IS NULL OR p_age < interval '1 day' THEN
			RAISE EXCEPTION 'purge only jobs finished at least a day ago' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		DELETE FROM job WHERE status IN ('done', 'dead') AND finished_at < now() - p_age;
		GET DIAGNOSTICS n = ROW_COUNT;
		RETURN n;
	END
	$$;

-- Queue health for the tick's metric (the oldest due job's age alarms in
-- production): counts only, nothing about any project.
CREATE FUNCTION app_job_stats()
	RETURNS TABLE (due integer, running integer, oldest_due_seconds integer)
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT
			count(*) FILTER (WHERE status IN ('queued', 'failed') AND run_after <= now())::integer,
			count(*) FILTER (WHERE status = 'running')::integer,
			COALESCE(extract(epoch FROM now() - min(run_after) FILTER (WHERE status IN ('queued', 'failed') AND run_after <= now())), 0)::integer
		FROM job
	$$;

-- Only the app role runs the queue functions.
REVOKE ALL ON FUNCTION app_claim_jobs(integer, interval), app_finish_job(uuid, uuid, boolean, text, boolean),
	app_purge_jobs(interval), app_job_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_claim_jobs(integer, interval), app_finish_job(uuid, uuid, boolean, text, boolean),
	app_purge_jobs(interval), app_job_stats() TO water_app;
