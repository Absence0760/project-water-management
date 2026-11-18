-- 322_feed_claim_no_key_update — the scheduler's claim on a feed, and an
-- ingest taking its fetch, no longer deadlock with a "Run now" on that feed
-- (docs/architecture.md § Data feeds → Schedule); and the due-feed listing
-- can be scoped to some projects (end of file).
--
-- app_claim_feed locked the feed's row FOR UPDATE, then the tick queued the
-- feed's fetch (job, unique on its dedupe key while queued). "Run now" goes
-- the other way round: it queues the fetch first, then takes a token from the
-- feed's bucket (app_feed_take_run_now), whose first insert into
-- data_feed_run_now checks its foreign key with a FOR KEY SHARE lock on the
-- same feed row. FOR UPDATE conflicts with FOR KEY SHARE, so a press that
-- queued its job just before a tick claimed the feed waited on the tick's row
-- lock while the tick's insert waited on the press's job: Postgres broke the
-- deadlock (40P01) by failing one of them, and the press answered 500 while
-- the tick's job ran (seen in e2e: station-api-feed.spec.ts, with
-- data-feeds.spec.ts's ticks scheduling every due feed, issue #784).
--
-- The claim only stamps last_scheduled_at, never the row's key, so FOR NO
-- KEY UPDATE is the lock it needs: it still conflicts with itself (two ticks
-- never claim one feed; SKIP LOCKED as before) and with FOR UPDATE (a
-- delete), but not with a foreign key's FOR KEY SHARE. Only the lock strength
-- changes; the rest is 276's definition.
--
-- app_take_feed_fetch (029) has the same shape: an ingest locks the row FOR
-- UPDATE, clears fetch_job_id and the window (none of them a key), and the
-- same transaction then queues a backfill's next window (feeds/ingest.ts
-- continueBackfill), so a press during an ingest could meet it the same way.
-- It takes FOR NO KEY UPDATE too: a second ingest of one answer still waits
-- for the first (the lock conflicts with itself). The rest is 029's.
--
-- app_due_feeds (276's definition) takes an optional p_projects, as
-- app_claim_jobs did in 123: NULL (the default, and production's tick, which
-- still calls it with two arguments) lists every project's due feeds exactly
-- as before; an array lists only those projects' due feeds, filtered before
-- the LIMIT. The e2e suite's scoped tick (`worker.ts --once --project <id>`)
-- uses it so a test's tick never queues another test's new feed (a new feed
-- is due at once), whose card then showed a fetch waiting that nothing would
-- run (issue #784); filtering a capped all-project listing afterwards would
-- schedule nothing once more feeds of other projects were due ahead. A new
-- argument changes the signature, so the old function is dropped (nothing
-- depends on it) and its grants given again, as 027 gave them.
DROP FUNCTION app_due_feeds(integer, boolean);

CREATE FUNCTION app_due_feeds(p_limit integer, p_all boolean DEFAULT false, p_projects uuid[] DEFAULT NULL)
	RETURNS TABLE (id uuid, project_id uuid, acting_user_id uuid)
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
			RAISE EXCEPTION 'list 1–500 feeds' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		RETURN QUERY
		SELECT f.id, f.project_id, f.acting_user_id FROM data_feed f
		WHERE f.enabled AND f.acting_user_id IS NOT NULL
		  AND (p_projects IS NULL OR f.project_id = ANY (p_projects))
		  AND (p_all OR (app_feed_is_due(f.source, f.schedule, f.consecutive_failures, f.last_scheduled_at, now(), f.last_error)
		                 AND NOT app_feed_fetch_out(f.fetch_job_id, now())))
		ORDER BY f.last_scheduled_at NULLS FIRST, f.id
		LIMIT p_limit;
	END
	$$;

REVOKE ALL ON FUNCTION app_due_feeds(integer, boolean, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_due_feeds(integer, boolean, uuid[]) TO water_app;

CREATE OR REPLACE FUNCTION app_claim_feed(p_feed uuid, p_all boolean DEFAULT false)
	RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_id uuid;
	BEGIN
		SELECT f.id INTO v_id FROM data_feed f
		WHERE f.id = p_feed AND f.enabled AND f.acting_user_id IS NOT NULL
		  AND f.acting_user_id = app_current_user_id()
		  AND (p_all OR (app_feed_is_due(f.source, f.schedule, f.consecutive_failures, f.last_scheduled_at, now(), f.last_error)
		                 AND NOT app_feed_fetch_out(f.fetch_job_id, now())))
		FOR NO KEY UPDATE SKIP LOCKED;
		IF v_id IS NULL THEN
			RETURN false;
		END IF;
		UPDATE data_feed f SET last_scheduled_at = now() WHERE f.id = v_id;
		RETURN true;
	END
	$$;

CREATE OR REPLACE FUNCTION app_take_feed_fetch(p_feed uuid, p_job uuid)
	RETURNS TABLE (window_start date, window_end date)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_project uuid;
	BEGIN
		SELECT f.project_id INTO v_project FROM data_feed f WHERE f.id = p_feed;
		IF v_project IS NULL OR NOT app_has_role(v_project, 'editor') THEN
			RAISE EXCEPTION 'not permitted' USING ERRCODE = 'insufficient_privilege';
		END IF;
		RETURN QUERY
		WITH taken AS (
			SELECT f.id, f.fetch_start AS s, f.fetch_end AS e FROM data_feed f
			WHERE f.id = p_feed AND f.fetch_job_id = p_job
			FOR NO KEY UPDATE
		)
		UPDATE data_feed f SET fetch_job_id = NULL, fetch_start = NULL, fetch_end = NULL
		FROM taken WHERE f.id = taken.id
		RETURNING taken.s, taken.e;
	END
	$$;
