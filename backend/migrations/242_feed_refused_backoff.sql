-- 242_feed_refused_backoff — a feed the source refused (HTTP 403) backs off
-- for hours, not minutes (docs/architecture.md § Data feeds → Throttling,
-- docs/data-model.md § Data feeds).
--
-- On 2026-10-25 CHC's file server answered the production fetcher HTTP 403
-- for most of the day: a ban on each fetcher environment's outbound address
-- for the volume it asked. The live client now leaves a refusing host alone
-- for an hour (feeds/http.ts REFUSED_PAUSE_SECONDS), but that is per
-- process: a fresh environment asks again, and the feed, failing, was due
-- again 15 minutes later, then 30, so the source kept being asked about
-- every quarter hour. Now a failing feed whose last error is a refusal waits
-- 2 h × 2^(failures − 1) instead of 15 min × 2^(failures − 1), capped at the
-- day as before (a refused feed still tries once a day, as its schedule
-- would). Any other failure keeps 15 minutes, doubling.
--
-- A refusal is read from the stored message, which the backend writes
-- (feeds/errors.ts feedErrorMessage: never upstream text) and starts with
-- FEED_REFUSED_PREFIX for a FeedRefusedError; feeds.db.test.ts pins the two
-- to each other. No new column: the message is the feed's health already,
-- and the next success clears it (app_record_feed_result, 018).
--
-- app_feed_is_due gains p_last_error (from 111_feed_daily_only.sql, its
-- latest definition), so the 5-argument form is dropped, and app_due_feeds
-- and app_claim_feed (027_feed_schedule.sql, their latest definitions; same
-- signatures, so CREATE OR REPLACE keeps their grants) pass the feed's
-- last_error. Nothing else calls app_feed_is_due, and a running backend
-- calls only those two, so this needs no expand step. No table, policy or
-- grant to water_app changes; the new function is revoked from PUBLIC as
-- 027 revoked the old one.

-- Is a feed due at p_now? As 111, with the failing backoff chosen by the
-- last error:
--   * never scheduled: due;
--   * a chirps_gefs feed: due when the latest 08:45 UTC (today's once it has
--     passed, else yesterday's) is after its last schedule;
--   * any other feed: due a day after its last schedule, with a minute's
--     slack;
--   * while failing, also due after a backoff of 15 min × 2^(failures − 1),
--     or 2 h × 2^(failures − 1) when the last error is a refusal (HTTP 403),
--     either capped at the day.
CREATE FUNCTION app_feed_is_due(p_source text, p_schedule text, p_failures integer, p_last timestamptz, p_now timestamptz, p_last_error text)
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
				make_interval(mins => CASE WHEN starts_with(coalesce(p_last_error, ''), 'the source refused this server’s requests') THEN 120 ELSE 15 END
					* power(2, LEAST(p_failures, 10) - 1)::integer)
			))
	$$;

CREATE OR REPLACE FUNCTION app_due_feeds(p_limit integer, p_all boolean DEFAULT false)
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
		  AND (p_all OR app_feed_is_due(f.source, f.schedule, f.consecutive_failures, f.last_scheduled_at, now(), f.last_error))
		ORDER BY f.last_scheduled_at NULLS FIRST, f.id
		LIMIT p_limit;
	END
	$$;

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
		  AND (p_all OR app_feed_is_due(f.source, f.schedule, f.consecutive_failures, f.last_scheduled_at, now(), f.last_error))
		FOR UPDATE SKIP LOCKED;
		IF v_id IS NULL THEN
			RETURN false;
		END IF;
		UPDATE data_feed f SET last_scheduled_at = now() WHERE f.id = v_id;
		RETURN true;
	END
	$$;

DROP FUNCTION app_feed_is_due(text, text, integer, timestamptz, timestamptz);

REVOKE ALL ON FUNCTION app_feed_is_due(text, text, integer, timestamptz, timestamptz, text) FROM PUBLIC;
