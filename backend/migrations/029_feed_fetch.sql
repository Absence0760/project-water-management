-- 029_feed_fetch — the fetch a data feed is waiting on (issues #29 and #31;
-- docs/architecture.md § Data feeds, docs/data-model.md § Data feeds).
--
-- In production a feed_fetch job hands its request to the fetcher Lambda and
-- finishes; the answer comes back later on the `ingest-results` queue, which
-- can redeliver and reorder. Until now the ingest had no trusted record of
-- what was asked for, so it could neither check the answer's days against the
-- requested window nor tell a late answer from the newest one: a delayed or
-- redelivered result re-merged older values over newer ones (#31).
--
-- In this file:
--  * data_feed.fetch_job_id / fetch_start / fetch_end: the newest fetch sent
--    for the feed and the days it asked for. Written only through the two
--    SECURITY DEFINER functions below (the trigger keeps them out of an
--    owner's direct write and clears them on insert and re-target). No
--    foreign key to job: finished jobs are purged, and the columns are
--    cleared once the answer is applied anyway.
--  * app_begin_feed_fetch: the feed_fetch job records itself and its window
--    before sending the request (as the acting user, an editor, for a running
--    feed_fetch job of that feed).
--  * app_take_feed_fetch: the feed_ingest job claims the window for the fetch
--    it answers, clearing it in the same statement. Only the newest fetch's
--    answer finds it, and only once: an older fetch's answer, or a redelivery
--    of an answer already applied, gets no row and is dropped. The row lock
--    serialises two ingests of one answer.
--
-- How far a fetch read (#29) needs no column: the ingest writes the window's
-- end into last_meta as `through` from the window it checked, and
-- feeds/fetch.ts fetchWindow moves past an empty stretch with it.

ALTER TABLE data_feed
	ADD COLUMN fetch_job_id uuid,
	ADD COLUMN fetch_start  date,
	ADD COLUMN fetch_end    date,
	ADD CONSTRAINT data_feed_fetch_window CHECK (
		(fetch_job_id IS NULL AND fetch_start IS NULL AND fetch_end IS NULL)
		OR (fetch_job_id IS NOT NULL AND fetch_start IS NOT NULL AND fetch_end IS NOT NULL)
	);

COMMENT ON COLUMN data_feed.fetch_job_id IS 'The newest feed_fetch job sent to the fetcher whose answer is not yet applied (029). Only app_begin_feed_fetch / app_take_feed_fetch write it.';
COMMENT ON COLUMN data_feed.fetch_start IS 'First day that fetch asked for (inclusive); the ingest refuses an answer with a day before it.';
COMMENT ON COLUMN data_feed.fetch_end IS 'Last day that fetch asked for (inclusive); the ingest refuses an answer with a day after it. Before fetch_start for an empty window (a startDate in the future): any day is refused.';

-- From 018_feeds.sql's definition (the latest), with the fetch columns kept
-- out of a direct write like the health columns.
CREATE OR REPLACE FUNCTION data_feed_stamp() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
	BEGIN
		IF current_user <> 'water_app' THEN
			RETURN NEW; -- a SECURITY DEFINER health update, or the owner role
		END IF;
		IF uid IS NULL THEN
			RAISE EXCEPTION 'a data feed needs a signed-in user' USING ERRCODE = 'insufficient_privilege';
		END IF;
		NEW.acting_user_id := uid;
		NEW.updated_at := now();
		IF TG_OP = 'INSERT' THEN
			NEW.created_by := uid;
			NEW.created_at := now();
			NEW.last_scheduled_at := NULL;
			NEW.last_attempt_at := NULL;
			NEW.last_success_at := NULL;
			NEW.last_data_date := NULL;
			NEW.last_value := NULL;
			NEW.consecutive_failures := 0;
			NEW.last_error := NULL;
			NEW.last_meta := NULL;
			NEW.fetch_job_id := NULL;
			NEW.fetch_start := NULL;
			NEW.fetch_end := NULL;
		ELSE
			NEW.id := OLD.id;
			NEW.project_id := OLD.project_id;
			NEW.created_by := OLD.created_by;
			NEW.created_at := OLD.created_at;
			NEW.last_attempt_at := OLD.last_attempt_at;
			NEW.last_success_at := OLD.last_success_at;
			NEW.last_value := OLD.last_value;
			NEW.last_meta := OLD.last_meta;
			NEW.last_error := OLD.last_error;
			NEW.fetch_job_id := OLD.fetch_job_id;
			NEW.fetch_start := OLD.fetch_start;
			NEW.fetch_end := OLD.fetch_end;
			IF NEW.source IS DISTINCT FROM OLD.source OR NEW.config IS DISTINCT FROM OLD.config
				OR NEW.target_kind IS DISTINCT FROM OLD.target_kind OR NEW.target_name IS DISTINCT FROM OLD.target_name THEN
				-- A different place or series: its data so far says nothing about the new one.
				NEW.last_data_date := NULL;
				NEW.last_value := NULL;
				NEW.last_success_at := NULL;
				NEW.last_meta := NULL;
				NEW.last_error := NULL;
				NEW.consecutive_failures := 0;
				NEW.last_scheduled_at := NULL;
				-- An answer for the old settings is dropped anyway (the feed's version changed).
				NEW.fetch_job_id := NULL;
				NEW.fetch_start := NULL;
				NEW.fetch_end := NULL;
			ELSE
				NEW.last_data_date := OLD.last_data_date;
				NEW.consecutive_failures := OLD.consecutive_failures;
				-- Saving (or re-enabling) makes it due now.
				NEW.last_scheduled_at := CASE WHEN NEW.enabled AND NOT OLD.enabled THEN NULL ELSE OLD.last_scheduled_at END;
			END IF;
		END IF;
		RETURN NEW;
	END
	$$;

-- A feed_fetch job, about to send its request to the fetcher, records itself
-- and the days it asks for. The caller must be an editor running that very
-- job: a running feed_fetch job of this feed, in its project, as the caller.
CREATE FUNCTION app_begin_feed_fetch(p_feed uuid, p_job uuid, p_start date, p_end date)
	RETURNS void
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_project uuid;
	BEGIN
		SELECT f.project_id INTO v_project FROM data_feed f WHERE f.id = p_feed;
		IF v_project IS NULL OR NOT app_has_role(v_project, 'editor') OR NOT EXISTS (
			SELECT 1 FROM job j
			WHERE j.id = p_job AND j.project_id = v_project AND j.kind = 'feed_fetch' AND j.status = 'running'
			  AND j.payload ->> 'feedId' = p_feed::text AND j.acting_user_id = app_current_user_id()
		) THEN
			RAISE EXCEPTION 'not permitted' USING ERRCODE = 'insufficient_privilege';
		END IF;
		-- An empty window (end before start: a startDate in the future) is
		-- allowed: the fetch reads nothing, and the ingest refuses any day.
		IF p_start IS NULL OR p_end IS NULL THEN
			RAISE EXCEPTION 'a fetch window needs a start and an end' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		UPDATE data_feed f SET fetch_job_id = p_job, fetch_start = p_start, fetch_end = p_end WHERE f.id = p_feed;
	END
	$$;

-- A feed_ingest job claims the window of the fetch it answers, and clears it:
-- one row back when p_job is the feed's newest fetch and its answer is not yet
-- applied, none otherwise (drop the answer). FOR UPDATE makes a second ingest
-- of the same answer wait for the first, then find the columns cleared.
CREATE FUNCTION app_take_feed_fetch(p_feed uuid, p_job uuid)
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
			FOR UPDATE
		)
		UPDATE data_feed f SET fetch_job_id = NULL, fetch_start = NULL, fetch_end = NULL
		FROM taken WHERE f.id = taken.id
		RETURNING taken.s, taken.e;
	END
	$$;

REVOKE ALL ON FUNCTION app_begin_feed_fetch(uuid, uuid, date, date), app_take_feed_fetch(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_begin_feed_fetch(uuid, uuid, date, date), app_take_feed_fetch(uuid, uuid) TO water_app;
