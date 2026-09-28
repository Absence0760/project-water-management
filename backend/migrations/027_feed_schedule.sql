-- 027_feed_schedule — the feed scheduler claims and queues each feed in one
-- transaction, CHIRPS-GEFS feeds wait for the day's issue, and a dropped
-- older forecast issue still counts as a check (issues #32, #33;
-- docs/architecture.md § Data feeds, docs/data-model.md § Data feeds).
-- Starts from 018_feeds.sql, the latest definition of each function here.
--
-- #32: 018's app_claim_due_feeds stamped last_scheduled_at on a whole batch
-- in one transaction, and feeds/schedule.ts queued each `feed_fetch` in
-- another. A failure between the two (a database blip on the third enqueue,
-- a worker killed mid-tick) left the rest claimed with no job for a whole
-- interval. Now the scheduler lists due feeds (app_due_feeds, no stamp),
-- then for each one opens a transaction as the feed's acting user, claims it
-- (app_claim_feed) and queues its fetch there: both commit or neither does.
-- app_claim_due_feeds goes in the same file rather than a later contract
-- step: nothing is deployed yet, so no running worker still calls it.
--
-- #33: CHC publishes each CHIRPS-GEFS issue around 08:26–08:30 UTC, and an
-- ingest keeps only the newest issue, so a daily forecast feed whose
-- schedule drifted before that stayed a day behind. A daily chirps_gefs
-- feed is now due once the latest 08:45 UTC has passed since it was last
-- scheduled, rather than a day after it (app_feed_is_due).
--
-- Every function pins search_path; the SECURITY DEFINER ones are revoked
-- from PUBLIC and granted to water_app. No table or foreign key changes.

-- Is a feed due at p_now? Enabled-ness and the acting user are the callers'
-- filters; this is the timing, shared by the listing and the claim so they
-- can't disagree:
--   * never scheduled: due;
--   * a daily chirps_gefs feed: due when the latest 08:45 UTC (today's once
--     it has passed, else yesterday's) is after its last schedule, so each
--     fetch reads a published issue;
--   * any other feed: due a day (or an hour, for hourly) after its last
--     schedule, with a minute's slack so a feed claimed a few seconds into
--     one tick isn't missed by the tick at the same time next day;
--   * while failing, also due after a backoff of 15 min × 2^(failures − 1),
--     capped at the interval.
-- UTC throughout, whatever the session's TimeZone.
CREATE FUNCTION app_feed_is_due(p_source text, p_schedule text, p_failures integer, p_last timestamptz, p_now timestamptz)
	RETURNS boolean
	LANGUAGE sql IMMUTABLE SET search_path = public
	AS $$
		SELECT p_last IS NULL
			OR CASE WHEN p_source = 'chirps_gefs' AND p_schedule = 'daily' THEN
				p_last < (
					SELECT CASE WHEN s <= p_now THEN s ELSE s - interval '1 day' END
					FROM (SELECT (date_trunc('day', p_now AT TIME ZONE 'UTC') + interval '8 hours 45 minutes') AT TIME ZONE 'UTC' AS s) slot
				)
			ELSE
				p_last <= p_now + interval '1 minute' - CASE p_schedule WHEN 'hourly' THEN interval '1 hour' ELSE interval '1 day' END
			END
			OR (p_failures > 0 AND p_last <= p_now + interval '1 minute' - LEAST(
				CASE p_schedule WHEN 'hourly' THEN interval '1 hour' ELSE interval '1 day' END,
				make_interval(mins => 15 * power(2, LEAST(p_failures, 10) - 1)::integer)
			))
	$$;

-- The scheduler (feeds/schedule.ts), with no user: up to p_limit due feeds
-- (every enabled one with p_all, for `pnpm dev:feeds:run`), the
-- longest-waiting first. Stamps nothing: app_claim_feed claims each one in
-- the transaction that queues its fetch. Returns routing columns only.
CREATE FUNCTION app_due_feeds(p_limit integer, p_all boolean DEFAULT false)
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
		  AND (p_all OR app_feed_is_due(f.source, f.schedule, f.consecutive_failures, f.last_scheduled_at, now()))
		ORDER BY f.last_scheduled_at NULLS FIRST, f.id
		LIMIT p_limit;
	END
	$$;

-- Claim one feed for the transaction's user, who must be its acting user
-- (the scheduler runs this inside withUser, then queues the fetch as that
-- user under RLS, before COMMIT). True when claimed: still enabled, still
-- this user's, still due (or p_all), and not being claimed by another tick
-- right now (SKIP LOCKED). Stamps last_scheduled_at; a rollback undoes it.
CREATE FUNCTION app_claim_feed(p_feed uuid, p_all boolean DEFAULT false)
	RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_id uuid;
	BEGIN
		SELECT f.id INTO v_id FROM data_feed f
		WHERE f.id = p_feed AND f.enabled AND f.acting_user_id IS NOT NULL
		  AND f.acting_user_id = app_current_user_id()
		  AND (p_all OR app_feed_is_due(f.source, f.schedule, f.consecutive_failures, f.last_scheduled_at, now()))
		FOR UPDATE SKIP LOCKED;
		IF v_id IS NULL THEN
			RETURN false;
		END IF;
		UPDATE data_feed f SET last_scheduled_at = now() WHERE f.id = v_id;
		RETURN true;
	END
	$$;

-- A fetch that worked but whose forecast issue is older than the one the
-- feed already merged (feeds/ingest.ts drops it untouched): the source was
-- checked, so stamp last_attempt_at, and nothing else. As the feed's acting
-- user, who must still be an editor (as for app_record_feed_result).
CREATE FUNCTION app_record_feed_checked(p_feed uuid) RETURNS void
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_project uuid;
	BEGIN
		SELECT f.project_id INTO v_project FROM data_feed f WHERE f.id = p_feed;
		IF v_project IS NULL OR NOT app_has_role(v_project, 'editor') THEN
			RAISE EXCEPTION 'not permitted' USING ERRCODE = 'insufficient_privilege';
		END IF;
		UPDATE data_feed f SET last_attempt_at = now() WHERE f.id = p_feed;
	END
	$$;

DROP FUNCTION app_claim_due_feeds(integer, boolean);

REVOKE ALL ON FUNCTION app_feed_is_due(text, text, integer, timestamptz, timestamptz), app_due_feeds(integer, boolean),
	app_claim_feed(uuid, boolean), app_record_feed_checked(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_due_feeds(integer, boolean), app_claim_feed(uuid, boolean), app_record_feed_checked(uuid) TO water_app;

COMMENT ON TABLE data_feed IS
	'Scheduled data feeds (018_feeds, WP-2.10; 027_feed_schedule). water_app: SELECT (viewer), INSERT/UPDATE/DELETE (owner); health columns only through the SECURITY DEFINER app_record_feed_result / app_record_feed_checked / app_feed_schedule_failed; the scheduler lists through app_due_feeds and claims through app_claim_feed.';
