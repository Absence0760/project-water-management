-- 018_feeds — scheduled data feeds (roadmap WP-2.10, issue #10 part 2;
-- docs/architecture.md § Data feeds, docs/data-model.md § Data feeds,
-- docs/security.md § Data feeds).
--
-- A data_feed row says: fetch this source (CHIRPS rainfall, the CHIRPS-GEFS
-- forecast, or a DWS gauge) for these grid cells / this station, and merge
-- what comes back into this series of the project. The job queue
-- (016_jobs.sql) does the work: the worker's tick claims due feeds
-- (app_claim_due_feeds) and queues a `feed_fetch` job for each, as the feed's
-- acting user; the fetch's result is merged by that user under RLS.
--
-- Who can do what:
--   * Read (SELECT): any viewer of the project (the feed-status panel).
--   * Attach, change, remove (INSERT / UPDATE / DELETE): owners. The trigger
--     stamps the owner who last saved the feed as its acting user, and keeps
--     the health columns out of a direct write: an owner can't forge "last
--     success". Health changes only through app_record_feed_result (the
--     acting user, an editor at run time) and app_feed_schedule_failed (the
--     scheduler, when the acting user can no longer queue work).
--   * The acting user must still be an editor when the fetch runs (the job
--     fails closed otherwise); a feed whose acting user deleted their account
--     keeps its row, with no acting user, and is skipped until an owner saves
--     it again.

CREATE TABLE data_feed (
	id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id           uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	source               text NOT NULL CHECK (source IN ('chirps', 'chirps_gefs', 'dws')),
	-- Cells or a station (feeds/config.ts validates per source). Small.
	config               jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object' AND octet_length(config::text) <= 8192),
	-- The series the values merge into: time_series (project_id, kind, name).
	target_kind          text NOT NULL CHECK (char_length(target_kind) BETWEEN 1 AND 40),
	target_name          text NOT NULL DEFAULT '' CHECK (char_length(target_name) <= 100),
	enabled              boolean NOT NULL DEFAULT true,
	schedule             text NOT NULL DEFAULT 'daily' CHECK (schedule IN ('daily', 'hourly')),
	acting_user_id       uuid REFERENCES app_user(id) ON DELETE SET NULL,
	created_by           uuid REFERENCES app_user(id) ON DELETE SET NULL,
	created_at           timestamptz NOT NULL DEFAULT now(),
	updated_at           timestamptz NOT NULL DEFAULT now(),
	-- Health: written only by app_record_feed_result / app_feed_schedule_failed.
	last_scheduled_at    timestamptz,
	last_attempt_at      timestamptz,
	last_success_at      timestamptz,
	last_data_date       date,
	last_value           double precision,
	consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
	-- Sanitised by the fetcher (feeds/errors.ts): never raw upstream or database text.
	last_error           text CHECK (last_error IS NULL OR char_length(last_error) <= 500),
	-- What the source said about the last fetch (days read, preliminary days, quality codes). Small.
	last_meta            jsonb CHECK (last_meta IS NULL OR (jsonb_typeof(last_meta) = 'object' AND octet_length(last_meta::text) <= 4096)),
	-- One feed per series: two feeds writing one series would fight.
	UNIQUE (project_id, target_kind, target_name)
);
-- Covering indexes for every foreign key (catalogue.db.test.ts); project_id
-- is covered by the unique constraint's index.
CREATE INDEX data_feed_acting_user_idx ON data_feed (acting_user_id);
CREATE INDEX data_feed_created_by_idx ON data_feed (created_by);
-- What the scheduler scans.
CREATE INDEX data_feed_due_idx ON data_feed (last_scheduled_at) WHERE enabled AND acting_user_id IS NOT NULL;

COMMENT ON TABLE data_feed IS
	'Scheduled data feeds (018_feeds, WP-2.10). water_app: SELECT (viewer), INSERT/UPDATE/DELETE (owner); health columns only through the SECURITY DEFINER app_record_feed_result / app_feed_schedule_failed; the scheduler claims through app_claim_due_feeds.';
COMMENT ON COLUMN data_feed.acting_user_id IS 'The owner who last saved the feed. Fetches run as this user under RLS and need editor at run time. NULL after that account is deleted: the feed is skipped until an owner saves it.';

-- A direct insert or update (as water_app, from the routes) stamps the
-- acting user and leaves the health columns alone: a new feed starts with
-- none, and a saved one keeps what it had, except that re-enabling or
-- re-targeting clears the failure count so the next tick fetches at once.
-- Only water_app's writes are stamped: the SECURITY DEFINER functions below
-- run as the table's owner, so their health updates pass through (as does a
-- maintenance fix by the owner role).
CREATE FUNCTION data_feed_stamp() RETURNS trigger
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
CREATE TRIGGER data_feed_stamp BEFORE INSERT OR UPDATE ON data_feed
	FOR EACH ROW EXECUTE FUNCTION data_feed_stamp();

ALTER TABLE data_feed ENABLE ROW LEVEL SECURITY;
CREATE POLICY data_feed_select ON data_feed FOR SELECT USING (app_has_role(project_id, 'viewer'));
CREATE POLICY data_feed_insert ON data_feed FOR INSERT
	WITH CHECK (app_has_role(project_id, 'owner') AND acting_user_id = app_current_user_id());
CREATE POLICY data_feed_update ON data_feed FOR UPDATE
	USING (app_has_role(project_id, 'owner'))
	WITH CHECK (app_has_role(project_id, 'owner') AND acting_user_id = app_current_user_id());
CREATE POLICY data_feed_delete ON data_feed FOR DELETE USING (app_has_role(project_id, 'owner'));

GRANT SELECT, INSERT, UPDATE, DELETE ON data_feed TO water_app;

-- The scheduler (jobs/runner.ts → feeds/schedule.ts), with no user: claim up
-- to p_limit due feeds, stamping last_scheduled_at so the next tick doesn't
-- claim them again. Due: enabled, with an acting user, and not scheduled
-- within its interval (a day, or an hour), or, while it is failing, within a
-- backoff of 15 min x 2^(failures - 1), capped at the interval. p_all claims
-- every enabled feed whatever its schedule (`pnpm dev:feeds:run`). Returns
-- routing columns only: the fetch reads the feed as its acting user.
CREATE FUNCTION app_claim_due_feeds(p_limit integer, p_all boolean DEFAULT false)
	RETURNS TABLE (id uuid, project_id uuid, acting_user_id uuid)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
			RAISE EXCEPTION 'claim 1–500 feeds' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		RETURN QUERY
		WITH due AS (
			SELECT f.id FROM data_feed f
			WHERE f.enabled AND f.acting_user_id IS NOT NULL
			  -- A minute's slack, so a feed claimed a few seconds into one
			  -- tick isn't missed by the tick at the same time next day.
			  AND (p_all OR f.last_scheduled_at IS NULL OR f.last_scheduled_at <= now() + interval '1 minute' - LEAST(
				CASE f.schedule WHEN 'hourly' THEN interval '1 hour' ELSE interval '1 day' END,
				CASE WHEN f.consecutive_failures > 0
					THEN make_interval(mins => 15 * power(2, LEAST(f.consecutive_failures, 10) - 1)::integer)
					ELSE interval '1 day' END
			  ))
			ORDER BY f.last_scheduled_at NULLS FIRST
			LIMIT p_limit
			FOR UPDATE SKIP LOCKED
		), claimed AS (
			UPDATE data_feed f SET last_scheduled_at = now()
			FROM due WHERE f.id = due.id
			RETURNING f.id, f.project_id, f.acting_user_id
		)
		SELECT * FROM claimed;
	END
	$$;

-- A fetch's outcome, recorded by the job that ran it, as the feed's acting
-- user (who must still be an editor of the project). p_error is stored as
-- given (≤ 500 characters): the caller sanitises it. The newest data date
-- (and its value) only moves forward.
CREATE FUNCTION app_record_feed_result(p_feed uuid, p_ok boolean, p_last_date date, p_last_value double precision, p_error text, p_meta jsonb)
	RETURNS void
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_project uuid;
	BEGIN
		SELECT f.project_id INTO v_project FROM data_feed f WHERE f.id = p_feed;
		IF v_project IS NULL OR NOT app_has_role(v_project, 'editor') THEN
			RAISE EXCEPTION 'not permitted' USING ERRCODE = 'insufficient_privilege';
		END IF;
		UPDATE data_feed f SET
			last_attempt_at = now(),
			last_success_at = CASE WHEN p_ok THEN now() ELSE f.last_success_at END,
			consecutive_failures = CASE WHEN p_ok THEN 0 ELSE f.consecutive_failures + 1 END,
			last_error = CASE WHEN p_ok THEN NULL ELSE left(COALESCE(NULLIF(p_error, ''), 'failed'), 500) END,
			last_meta = CASE WHEN p_ok THEN p_meta ELSE f.last_meta END,
			last_value = CASE WHEN p_ok AND p_last_date IS NOT NULL AND (f.last_data_date IS NULL OR p_last_date >= f.last_data_date)
				THEN p_last_value ELSE f.last_value END,
			last_data_date = CASE WHEN p_ok AND p_last_date IS NOT NULL THEN GREATEST(f.last_data_date, p_last_date) ELSE f.last_data_date END
		WHERE f.id = p_feed;
	END
	$$;

-- The scheduler couldn't queue a fetch as the feed's acting user (they lost
-- the editor role): a failure the owners can see and fix by saving the feed.
-- Only this fixed message is stored.
CREATE FUNCTION app_feed_schedule_failed(p_feed uuid) RETURNS void
	LANGUAGE sql SECURITY DEFINER SET search_path = public
	AS $$
		UPDATE data_feed SET
			last_attempt_at = now(),
			consecutive_failures = consecutive_failures + 1,
			last_error = 'the owner who set up this feed can no longer edit the project: an owner must save the feed again'
		WHERE id = p_feed
	$$;

-- The production worker receives a fetch result from the `ingest-results`
-- queue with no user context (lambda-worker.ts). This names the project and
-- acting user it belongs to, and only for a real feed_fetch job of that feed,
-- so a message can't route data anywhere else. The worker then queues the
-- `feed_ingest` job as that user, under RLS.
CREATE FUNCTION app_feed_fetch_job(p_job uuid, p_feed uuid)
	RETURNS TABLE (project_id uuid, acting_user_id uuid)
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT j.project_id, j.acting_user_id FROM job j
		JOIN data_feed f ON f.id = p_feed AND f.project_id = j.project_id
		WHERE j.id = p_job AND j.kind = 'feed_fetch' AND j.payload ->> 'feedId' = p_feed::text
	$$;

REVOKE ALL ON FUNCTION app_claim_due_feeds(integer, boolean), app_record_feed_result(uuid, boolean, date, double precision, text, jsonb),
	app_feed_schedule_failed(uuid), app_feed_fetch_job(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_claim_due_feeds(integer, boolean), app_record_feed_result(uuid, boolean, date, double precision, text, jsonb),
	app_feed_schedule_failed(uuid), app_feed_fetch_job(uuid, uuid) TO water_app;
