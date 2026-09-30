-- A job claim scoped to some projects. app_claim_jobs takes an optional
-- p_projects: NULL (the default, and every production caller: the worker
-- Lambda, the local worker loop) claims across every project as before; an
-- array claims only those projects' jobs, and marks dead only their expired
-- running jobs. The e2e suite's tick uses it (`worker.ts --once --project
-- <id>`, e2e/support/jobs.ts): Playwright's workers share one e2e database,
-- and a global tick run by one test claimed another test's freshly queued
-- job, so that test saw "Running…" where it asserted "Queued".
--
-- The rest is 016_jobs.sql's definition as it was. A new argument changes
-- the signature, so the old function is dropped (nothing depends on it) and
-- its grants given again.
DROP FUNCTION app_claim_jobs(integer, interval);

CREATE FUNCTION app_claim_jobs(p_limit integer, p_lease interval, p_projects uuid[] DEFAULT NULL)
	RETURNS TABLE (id uuid, project_id uuid, kind text, acting_user_id uuid, lease_token uuid, attempts integer, max_attempts integer)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 OR p_lease IS NULL OR p_lease < interval '10 seconds' OR p_lease > interval '1 hour' THEN
			RAISE EXCEPTION 'claim 1–100 jobs for a lease of 10 s to 1 h' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		UPDATE job j SET status = 'dead', finished_at = now(), locked_until = NULL, lease_token = NULL,
			last_error = 'the worker stopped before the job finished, and it has no attempts left'
		WHERE j.status = 'running' AND j.locked_until < now() AND j.attempts >= j.max_attempts
		  AND (p_projects IS NULL OR j.project_id = ANY (p_projects));
		RETURN QUERY
		WITH due AS (
			SELECT d.id FROM job d
			WHERE ((d.status IN ('queued', 'failed') AND d.run_after <= now())
				OR (d.status = 'running' AND d.locked_until < now()))
			  AND (p_projects IS NULL OR d.project_id = ANY (p_projects))
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

REVOKE ALL ON FUNCTION app_claim_jobs(integer, interval, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_claim_jobs(integer, interval, uuid[]) TO water_app;
