-- 305_job_next_due — how soon the next queued job comes due, so a worker
-- tick keeps running the jobs that come due while it still has time
-- (jobs/runner.ts runTick `waitDueMs`; docs/architecture.md § Background
-- work).
--
-- A tick claimed due jobs until none was due, then stopped. A job queued to
-- run a few seconds later (a data feed's backfill queues its next window
-- CACHED_NEXT_SECONDS = 5 s on, feeds/ingest.ts) was then not due, and in
-- production nothing woke the worker for it (only the API sends wake
-- messages, infra/jobs.tf): it waited for the 5-minute EventBridge tick. A
-- CHIRPS backfill read from our copy moved one window a tick (2026-11-02).
--
-- app_next_job_due(p_projects): seconds from now() until the soonest pending
-- (queued, or failed and waiting to retry) job that isn't due yet, or NULL
-- when there is none. Only jobs still in the future: a due job the claim
-- skipped (one with its dedupe key is running) is the running one's
-- worker's to follow, and counting it would have a waiting tick spin.
-- p_projects scopes it as app_claim_jobs does (123): NULL for every project.
-- The worker only (no signed-in user, no API key: alert_worker_context,
-- 051), like the other sweeps: a session never learns another project's
-- queue. Reads job_due_idx (status, run_after).
CREATE FUNCTION app_next_job_due(p_projects uuid[] DEFAULT NULL)
	RETURNS double precision
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker reads the queue''s next due job' USING ERRCODE = 'insufficient_privilege';
		END IF;
		RETURN (
			SELECT extract(epoch FROM min(j.run_after) - now())::double precision
			FROM job j
			WHERE j.status IN ('queued', 'failed') AND j.run_after > now()
			  AND (p_projects IS NULL OR j.project_id = ANY (p_projects))
		);
	END
	$$;

REVOKE ALL ON FUNCTION app_next_job_due(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_next_job_due(uuid[]) TO water_app;
