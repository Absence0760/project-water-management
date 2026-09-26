-- 037_auto_rerun — automatic re-runs after new data (roadmap WP-2.11;
-- docs/architecture.md § Background work, docs/data-model.md § Jobs and
-- § Run storage cap).
--
-- Expand-only:
--
--   1. model_run.trigger: what made the run. 'manual' (a person pressed Run,
--      queued a re-run, imported, or ran a scenario), 'auto' (the debounced
--      re-run after new data), 'forecast' (reserved for WP-2.12). Existing
--      rows are 'manual'. The storage cap (runs/execute.ts trimRuns) counts
--      each trigger on its own: an auto run never pushes a person's run out.
--
--   2. app_enqueue_rerun(): the debounced enqueue. New data (a merge, a
--      replace, a data feed; WP-2.9's API-key ingest too) queues one pending
--      `rerun` per project (dedupe key 'rerun', which the dedupe index already
--      scopes per project), due p_debounce from now. Each later call pushes
--      the pending auto re-run's run_after forward again, but never past
--      created_at + p_max_wait, so a constantly-feeding logger still gets runs.
--      Moving run_after is an UPDATE of a job row, which water_app has no
--      grant or policy for (016_jobs), so this is a SECURITY DEFINER function
--      like app_claim_jobs, and it re-checks what the job_insert policy
--      would: the caller is signed in and an editor of the project. It touches
--      only that project's pending re-run, and returns only its id and time.

ALTER TABLE model_run
	ADD COLUMN trigger text NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'auto', 'forecast'));
COMMENT ON COLUMN model_run.trigger IS
	'What made the run: manual (a person), auto (the debounced re-run after new data, WP-2.11), forecast (WP-2.12). The storage cap keeps each trigger''s newest runs separately (runs/execute.ts trimRuns).';

-- Queue (or push back) the project's automatic re-run.
--
--   * A pending auto re-run (queued): run_after moves to
--     LEAST(now() + p_debounce, created_at + p_max_wait). Its cause is updated.
--   * A pending manual re-run (queued from POST /projects/:id/jobs), or any
--     re-run failed and waiting to retry: left as it is. It reads the
--     project's inputs when it runs, so it covers the new data too.
--   * None pending (a re-run may be running: its job has status 'running',
--     so it isn't pending): a new auto re-run, due now() + p_debounce, as the
--     caller. The claim holds it back while the running one finishes
--     (app_claim_jobs), so data that arrived mid-run gets its own run.
--
-- p_cause is what brought the data: 'series' (a person's upload), 'feed'
-- (a data feed), 'ingest' (an API key). Returns the pending job's id, when it
-- is due, and whether this call created it.
CREATE FUNCTION app_enqueue_rerun(p_project uuid, p_debounce interval, p_max_wait interval, p_cause text)
	RETURNS TABLE (job_id uuid, due_at timestamptz, created boolean)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
	BEGIN
		IF uid IS NULL OR p_project IS NULL OR NOT app_has_role(p_project, 'editor') THEN
			RAISE EXCEPTION 'only an editor of the project can queue a re-run' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_debounce IS NULL OR p_debounce < interval '0' OR p_debounce > interval '1 day'
			OR p_max_wait IS NULL OR p_max_wait < p_debounce OR p_max_wait > interval '1 day' THEN
			RAISE EXCEPTION 'debounce 0 to 1 day, and a maximum wait from the debounce to 1 day' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		IF p_cause IS NULL OR p_cause NOT IN ('series', 'feed', 'ingest') THEN
			RAISE EXCEPTION 'unknown re-run cause' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		-- One enqueue at a time per project, to the end of the caller's
		-- transaction: two merges committing together each saw no pending
		-- job and queued one, and the loser's insert then hit the dedupe index.
		PERFORM pg_advisory_xact_lock(hashtextextended('job_rerun:' || p_project::text, 0));

		RETURN QUERY
			UPDATE job j SET run_after = LEAST(now() + p_debounce, j.created_at + p_max_wait),
				payload = jsonb_set(j.payload, '{cause}', to_jsonb(p_cause))
			WHERE j.project_id = p_project AND j.dedupe_key = 'rerun' AND j.status = 'queued' AND j.payload->>'trigger' = 'auto'
			RETURNING j.id, j.run_after, false;
		IF FOUND THEN RETURN; END IF;

		RETURN QUERY
			SELECT j.id, j.run_after, false FROM job j
			WHERE j.project_id = p_project AND j.dedupe_key = 'rerun' AND j.status IN ('queued', 'failed');
		IF FOUND THEN RETURN; END IF;

		-- job_enqueue stamps the caller as the acting user and resets the lifecycle.
		-- ON CONFLICT: a manual re-run (POST /jobs, which doesn't take the lock) queued in between.
		RETURN QUERY
			INSERT INTO job AS j (project_id, kind, payload, dedupe_key, run_after, acting_user_id)
			VALUES (p_project, 'rerun', jsonb_build_object('label', '', 'trigger', 'auto', 'cause', p_cause), 'rerun', now() + p_debounce, uid)
			ON CONFLICT (project_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'failed') DO NOTHING
			RETURNING j.id, j.run_after, true;
		IF FOUND THEN RETURN; END IF;

		RETURN QUERY
			SELECT j.id, j.run_after, false FROM job j
			WHERE j.project_id = p_project AND j.dedupe_key = 'rerun' AND j.status IN ('queued', 'failed');
	END
	$$;

REVOKE ALL ON FUNCTION app_enqueue_rerun(uuid, interval, interval, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_enqueue_rerun(uuid, interval, interval, text) TO water_app;
