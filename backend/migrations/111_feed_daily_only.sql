-- 111_feed_daily_only — every data feed runs daily, and "Run now" is
-- rate-limited per feed (issue #69; docs/architecture.md § Data feeds,
-- docs/data-model.md § Data feeds, docs/api.md § Data feeds).
--
-- 1. No hourly schedule. None of the sources publishes more often than
--    daily: CHIRPS once a day at most (preliminary pentads), CHIRPS-GEFS one
--    issue a day around 08:30 UTC (and an hourly GEFS feed skipped the 08:45
--    UTC slot that 027 added for it), and verified DWS flow lags by months.
--    An hourly feed read the same days 24 times a day. Hourly feeds become
--    daily, the column's CHECK allows only 'daily', and app_feed_is_due loses
--    its hourly branches (from 027_feed_schedule.sql, its latest definition).
--    The column and the API field stay (value 'daily' only), so a client
--    that sends `schedule: 'daily'` keeps working. The UPDATE runs as the
--    table's owner, so data_feed_stamp (032's definition) lets it through
--    untouched (it stamps only water_app's writes): the feeds keep their
--    acting user, health and last_scheduled_at, and the next daily slot
--    after their last schedule picks them up.
--
-- 2. "Run now" has a token bucket per feed, data_feed_run_now: capacity and
--    refill come from the backend (feeds/routes.ts RUN_NOW_RATE, 6 presses,
--    one back every 10 minutes), as app_api_key_take's do (039), so the route,
--    its tests and the docs cite one constant; the function bounds both. A
--    separate table rather than columns on data_feed, like api_key_throttle:
--    an owner writes data_feed directly, so bucket columns there would have
--    to be fenced off in data_feed_stamp; here water_app has a policy that
--    matches no row (the grant is the catalogue's rule for every app table)
--    and only the SECURITY DEFINER app_feed_take_run_now reads or writes it.
--    The row goes with its feed (ON DELETE CASCADE). It holds no personal
--    information: no user column, so nothing for the account export or
--    deletion to cover.
--
-- Every function pins search_path; the SECURITY DEFINER one is revoked from
-- PUBLIC and granted to water_app. The new foreign key is the primary key,
-- so it has its covering index.

-- ---------------------------------------------------------------------------
-- 1. Daily only
-- ---------------------------------------------------------------------------
UPDATE data_feed SET schedule = 'daily' WHERE schedule = 'hourly';
ALTER TABLE data_feed DROP CONSTRAINT data_feed_schedule_check;
ALTER TABLE data_feed ADD CONSTRAINT data_feed_schedule_check CHECK (schedule = 'daily');
COMMENT ON COLUMN data_feed.schedule IS 'Always daily (111_feed_daily_only): no source publishes more often. Kept for the API''s schedule field.';

-- Is a feed due at p_now? As 027, without the hourly interval:
--   * never scheduled: due;
--   * a chirps_gefs feed: due when the latest 08:45 UTC (today's once it has
--     passed, else yesterday's) is after its last schedule, so each fetch
--     reads a published issue;
--   * any other feed: due a day after its last schedule, with a minute's
--     slack so a feed claimed a few seconds into one tick isn't missed by the
--     tick at the same time next day;
--   * while failing, also due after a backoff of 15 min × 2^(failures − 1),
--     capped at the day.
-- p_schedule is kept so app_due_feeds and app_claim_feed (027) call it
-- unchanged; every feed's is 'daily' now. UTC throughout, whatever the
-- session's TimeZone.
CREATE OR REPLACE FUNCTION app_feed_is_due(p_source text, p_schedule text, p_failures integer, p_last timestamptz, p_now timestamptz)
	RETURNS boolean
	LANGUAGE sql IMMUTABLE SET search_path = public
	AS $$
		SELECT p_last IS NULL
			OR CASE WHEN p_source = 'chirps_gefs' THEN
				p_last < (
					SELECT CASE WHEN s <= p_now THEN s ELSE s - interval '1 day' END
					FROM (SELECT (date_trunc('day', p_now AT TIME ZONE 'UTC') + interval '8 hours 45 minutes') AT TIME ZONE 'UTC' AS s) slot
				)
			ELSE
				p_last <= p_now + interval '1 minute' - interval '1 day'
			END
			OR (p_failures > 0 AND p_last <= p_now + interval '1 minute' - LEAST(
				interval '1 day',
				make_interval(mins => 15 * power(2, LEAST(p_failures, 10) - 1)::integer)
			))
	$$;

-- ---------------------------------------------------------------------------
-- 2. The "Run now" bucket
-- ---------------------------------------------------------------------------
CREATE TABLE data_feed_run_now (
	feed_id     uuid PRIMARY KEY REFERENCES data_feed(id) ON DELETE CASCADE,
	tokens      double precision NOT NULL CHECK (tokens >= 0),
	refilled_at timestamptz NOT NULL
);
ALTER TABLE data_feed_run_now ENABLE ROW LEVEL SECURITY;
CREATE POLICY data_feed_run_now_none ON data_feed_run_now USING (false) WITH CHECK (false);
GRANT SELECT, INSERT, UPDATE, DELETE ON data_feed_run_now TO water_app;
COMMENT ON TABLE data_feed_run_now IS
	'"Run now" token bucket per feed (111_feed_daily_only). water_app matches no row; only app_feed_take_run_now reads or writes it.';

-- Take one "Run now" press from the feed's bucket: p_capacity presses, one
-- back every p_refill_seconds. For an editor of the feed's project (as
-- app_feed_fetch_now). Returns 0 to go ahead, or the seconds until a press is
-- back (nothing taken). The route calls it only for a press that queued a
-- fetch or pulled a waiting one forward, inside that press's transaction,
-- so a refusal rolls the enqueue back; a press that found a fetch already
-- due takes nothing. The row lock counts concurrent presses one by one.
CREATE FUNCTION app_feed_take_run_now(p_feed uuid, p_capacity integer, p_refill_seconds integer) RETURNS integer
	LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_project uuid;
		v_tokens double precision;
		v_at timestamptz;
		v_now timestamptz;
	BEGIN
		IF p_capacity IS NULL OR p_capacity < 1 OR p_capacity > 100 OR p_refill_seconds IS NULL OR p_refill_seconds < 1 OR p_refill_seconds > 86400 THEN
			RAISE EXCEPTION 'capacity 1–100, refill 1–86400 s' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		SELECT f.project_id INTO v_project FROM data_feed f WHERE f.id = p_feed;
		IF v_project IS NULL OR NOT app_has_role(v_project, 'editor') THEN
			RAISE EXCEPTION 'not permitted' USING ERRCODE = 'insufficient_privilege';
		END IF;
		INSERT INTO data_feed_run_now (feed_id, tokens, refilled_at) VALUES (p_feed, p_capacity, clock_timestamp())
			ON CONFLICT (feed_id) DO NOTHING;
		SELECT b.tokens, b.refilled_at INTO v_tokens, v_at FROM data_feed_run_now b WHERE b.feed_id = p_feed FOR UPDATE;
		-- After the lock: a press that waited refills from when it got it.
		v_now := clock_timestamp();
		v_tokens := least(p_capacity, v_tokens + greatest(0, extract(epoch FROM v_now - v_at)) / p_refill_seconds);
		IF v_tokens < 1 THEN
			UPDATE data_feed_run_now SET tokens = v_tokens, refilled_at = v_now WHERE feed_id = p_feed;
			RETURN greatest(1, ceil((1 - v_tokens) * p_refill_seconds))::integer;
		END IF;
		UPDATE data_feed_run_now SET tokens = v_tokens - 1, refilled_at = v_now WHERE feed_id = p_feed;
		RETURN 0;
	END
	$$;

REVOKE ALL ON FUNCTION app_feed_take_run_now(uuid, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_feed_take_run_now(uuid, integer, integer) TO water_app;
