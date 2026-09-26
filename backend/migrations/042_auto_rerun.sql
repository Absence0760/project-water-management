-- 042_auto_rerun — automatic re-runs after new data (roadmap WP-2.11;
-- docs/architecture.md § Background work, docs/data-model.md § Jobs and
-- § Run storage cap).
--
-- Expand-only:
--
--   1. model_run.trigger: what made the run. 'manual' (a person pressed Run,
--      queued a re-run, imported, or ran a scenario), 'auto' (the debounced
--      re-run after new data), 'forecast' (a forecast-mode run, WP-2.12,
--      runs/execute.ts). Existing rows are 'manual'. The storage cap (runs/execute.ts trimRuns) counts
--      each trigger on its own: an auto run never pushes a person's run out.
--
--   2. app_enqueue_rerun(): the debounced enqueue behind the new-data hook
--      (backend/src/series/newData.ts onSeriesDaysChanged). New data (a merge,
--      a replace, a data feed, an API key's ingest) queues one pending
--      `rerun` per project (dedupe key 'rerun', which the dedupe index already
--      scopes per project), due settings.autoRun.debounceMinutes from now. Each
--      later call pushes the pending auto re-run's run_after forward again, but
--      never past created_at + 2 h, so a constantly-feeding logger still gets
--      runs. It does nothing unless the project turned automatic runs on.
--      SECURITY DEFINER, like app_claim_jobs, because:
--        - moving run_after is an UPDATE of a job row, which water_app has no
--          grant or policy for (016_jobs);
--        - an API key's transaction has no user and can't read the project's
--          settings, yet its ingest is new data too.
--      It touches only that project's pending re-run and returns only its id
--      and time.
--
--   3. app_rerun_acting_user(): who a re-run queued in this transaction runs
--      as: the signed-in user when they are an editor of the project, or,
--      when the transaction acts as a live API key of this project
--      (039_api_keys: app_api_key_project('series:write') = p_project), the
--      key's creator (api_key.created_by). The re-run then runs as that
--      person under RLS, and fails closed if they are no longer an editor by
--      then (jobs/runner.ts), like any job. A key whose creator's account was
--      deleted (created_by NULL) has nobody to run as: app_enqueue_rerun
--      skips the re-run (no job, no row) rather than refuse, so the key's
--      ingest still commits.
--
--   4. job_enqueue (replaced from its latest definition, 040_yield.sql): a
--      SECURITY DEFINER caller with no signed-in user (app_enqueue_rerun for
--      an API key) may name the acting user itself. Everything else is as
--      before: a signed-in enqueuer is always stamped as the acting user, and
--      a plain insert with no user is refused.

ALTER TABLE model_run
	ADD COLUMN trigger text NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'auto', 'forecast'));
COMMENT ON COLUMN model_run.trigger IS
	'What made the run: manual (a person), auto (the debounced re-run after new data, WP-2.11), forecast (WP-2.12). The storage cap keeps each trigger''s newest runs separately (runs/execute.ts trimRuns).';

-- 3. Who a re-run queued now runs as (see the header), or NULL: nobody may queue one.
CREATE FUNCTION app_rerun_acting_user(p_project uuid) RETURNS uuid
	LANGUAGE sql STABLE SET search_path = public
	AS $$
		SELECT CASE
			WHEN app_current_user_id() IS NOT NULL THEN CASE WHEN app_has_role(p_project, 'editor') THEN app_current_user_id() END
			WHEN app_api_key_project('series:write') = p_project THEN (SELECT k.created_by FROM api_key k WHERE k.id = app_current_api_key_id())
		END
	$$;

-- 4. From 040_yield.sql's job_enqueue (016's, also clearing progress and the cancel flag), with the one new case.
CREATE OR REPLACE FUNCTION job_enqueue() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
	BEGIN
		IF uid IS NOT NULL THEN
			NEW.acting_user_id := uid;
		-- No signed-in user: only a SECURITY DEFINER function (running as the
		-- schema owner, so current_user differs from the connection's
		-- session_user) may queue, and it names the acting user itself.
		ELSIF current_user = session_user OR NEW.acting_user_id IS NULL THEN
			RAISE EXCEPTION 'a job needs a signed-in user' USING ERRCODE = 'insufficient_privilege';
		END IF;
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

-- 2. Queue (or push back) the project's automatic re-run.
--
--   * Automatic runs off (settings.autoRun.enabled isn't true): nothing, no row.
--   * A pending auto re-run (queued): run_after moves to
--     LEAST(now() + debounce, created_at + 2 h). Its cause is updated.
--   * A pending manual re-run (queued from POST /projects/:id/jobs), or any
--     re-run failed and waiting to retry: left as it is. It reads the
--     project's inputs when it runs, so it covers the new data too.
--   * None pending (a re-run may be running: its job has status 'running',
--     so it isn't pending): a new auto re-run, due now() + debounce, as
--     app_rerun_acting_user. The claim holds it back while the running one
--     finishes (app_claim_jobs), so data that arrived mid-run gets its own run.
--
-- The debounce is settings.autoRun.debounceMinutes when it is a whole number
-- from 0 to 120, else 15: the same defaults as backend/src/runs/autoRun.ts
-- resolveAutoRun (autoRun.db.test.ts holds the two together).
--
-- p_cause is what brought the data: 'series' (a person's upload), 'feed'
-- (a data feed), 'ingest' (an API key). Returns the pending job's id, when it
-- is due, and whether this call created it.
CREATE FUNCTION app_enqueue_rerun(p_project uuid, p_cause text)
	RETURNS TABLE (job_id uuid, due_at timestamptz, created boolean)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_actor uuid := app_rerun_acting_user(p_project);
		v_auto jsonb;
		v_debounce interval;
		v_max_wait constant interval := interval '120 minutes';
	BEGIN
		IF v_actor IS NULL THEN
			-- A live key of this project whose creator's account was deleted:
			-- skip the re-run, never roll the key's ingest back.
			IF app_current_user_id() IS NULL AND app_api_key_project('series:write') = p_project THEN
				RETURN;
			END IF;
			RAISE EXCEPTION 'only an editor of the project can queue a re-run' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_cause IS NULL OR p_cause NOT IN ('series', 'feed', 'ingest') THEN
			RAISE EXCEPTION 'unknown re-run cause' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		SELECT p.settings->'autoRun' INTO v_auto FROM project p WHERE p.id = p_project;
		IF v_auto IS NULL OR jsonb_typeof(v_auto) <> 'object' OR (v_auto->'enabled') IS DISTINCT FROM 'true'::jsonb THEN
			RETURN;
		END IF;
		v_debounce := make_interval(mins => CASE
			WHEN jsonb_typeof(v_auto->'debounceMinutes') = 'number'
				AND (v_auto->>'debounceMinutes')::numeric BETWEEN 0 AND 120
				AND (v_auto->>'debounceMinutes')::numeric = trunc((v_auto->>'debounceMinutes')::numeric)
			THEN (v_auto->>'debounceMinutes')::integer ELSE 15 END);
		-- One enqueue at a time per project, to the end of the caller's
		-- transaction: two merges committing together each saw no pending
		-- job and queued one, and the loser's insert then hit the dedupe index.
		PERFORM pg_advisory_xact_lock(hashtextextended('job_rerun:' || p_project::text, 0));

		RETURN QUERY
			UPDATE job j SET run_after = LEAST(now() + v_debounce, j.created_at + v_max_wait),
				payload = jsonb_set(j.payload, '{cause}', to_jsonb(p_cause))
			WHERE j.project_id = p_project AND j.dedupe_key = 'rerun' AND j.status = 'queued' AND j.payload->>'trigger' = 'auto'
			RETURNING j.id, j.run_after, false;
		IF FOUND THEN RETURN; END IF;

		RETURN QUERY
			SELECT j.id, j.run_after, false FROM job j
			WHERE j.project_id = p_project AND j.dedupe_key = 'rerun' AND j.status IN ('queued', 'failed');
		IF FOUND THEN RETURN; END IF;

		-- job_enqueue stamps a signed-in caller as the acting user (v_actor is
		-- that user then), and takes v_actor as given for a key (see 4).
		-- ON CONFLICT: a manual re-run (POST /jobs, which doesn't take the lock) queued in between.
		RETURN QUERY
			INSERT INTO job AS j (project_id, kind, payload, dedupe_key, run_after, acting_user_id)
			VALUES (p_project, 'rerun', jsonb_build_object('label', '', 'trigger', 'auto', 'cause', p_cause), 'rerun', now() + v_debounce, v_actor)
			ON CONFLICT (project_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'failed') DO NOTHING
			RETURNING j.id, j.run_after, true;
		IF FOUND THEN RETURN; END IF;

		RETURN QUERY
			SELECT j.id, j.run_after, false FROM job j
			WHERE j.project_id = p_project AND j.dedupe_key = 'rerun' AND j.status IN ('queued', 'failed');
	END
	$$;

REVOKE ALL ON FUNCTION app_enqueue_rerun(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_enqueue_rerun(uuid, text) TO water_app;
