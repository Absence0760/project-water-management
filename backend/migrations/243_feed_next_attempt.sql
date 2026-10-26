-- 243_feed_next_attempt — when the scheduler next tries a feed, from the same
-- rule that decides whether it is due (issue #586, Round 4: a failing feed's
-- row said "tries again later" with no time; docs/architecture.md § Data
-- feeds → Throttling, docs/data-model.md § Data feeds).
--
-- app_feed_next_attempt returns the first instant at which app_feed_is_due
-- turns true for a feed last scheduled at p_last: NULL when it has never been
-- scheduled (due at once). app_feed_is_due (242_feed_refused_backoff.sql, its
-- latest definition) is rewritten as "never scheduled, or that instant has
-- come", so the backoff arithmetic lives in one place and the time the panel
-- shows can't drift from the scheduler. The two are equivalent to 242's body:
--   * chirps_gefs: due when some 08:45 UTC slot lies in (p_last, p_now], that
--     is when the first slot after p_last is at or before p_now;
--   * any other feed: p_last <= p_now + 1 min − 1 day, that is
--     p_last + 1 day − 1 min <= p_now;
--   * failing: likewise p_last + backoff − 1 min <= p_now, the backoff
--     15 min × 2^(failures − 1), or 2 h × 2^(failures − 1) after a refusal,
--     capped at the day.
-- feeds.db.test.ts checks the new app_feed_is_due against a frozen copy of
-- 242's body on a grid of feeds and instants.
--
-- Both are STABLE, not IMMUTABLE as 242 declared: adding a day to a
-- timestamptz depends on the session's TimeZone, so neither may be folded
-- or used in an index. Same signature for app_feed_is_due, so CREATE OR
-- REPLACE keeps its grants (242 revoked PUBLIC's; the database's default
-- privileges still give water_app EXECUTE, harmless for a function that reads
-- no table). The new function reads no table either, and the feed list calls
-- it as water_app (feeds/store.ts COLS), so water_app is granted EXECUTE
-- explicitly. No table, policy or RLS changes.

CREATE FUNCTION app_feed_next_attempt(p_source text, p_schedule text, p_failures integer, p_last timestamptz, p_last_error text)
	RETURNS timestamptz
	LANGUAGE sql STABLE SET search_path = public
	AS $$
		SELECT CASE WHEN p_last IS NULL THEN NULL ELSE LEAST(
			CASE WHEN p_source = 'chirps_gefs' THEN (
				SELECT CASE WHEN s > p_last THEN s ELSE s + interval '1 day' END
				FROM (SELECT (date_trunc('day', p_last AT TIME ZONE 'UTC') + interval '8 hours 45 minutes') AT TIME ZONE 'UTC' AS s) slot
			)
			ELSE p_last + interval '1 day' - interval '1 minute'
			END,
			CASE WHEN p_failures > 0 THEN p_last - interval '1 minute' + LEAST(
				interval '1 day',
				make_interval(mins => CASE WHEN starts_with(coalesce(p_last_error, ''), 'the source refused this server’s requests') THEN 120 ELSE 15 END
					* power(2, LEAST(p_failures, 10) - 1)::integer)
			) END
		) END
	$$;

-- LEAST ignores NULL, so a feed with no failures takes its schedule's instant.
CREATE OR REPLACE FUNCTION app_feed_is_due(p_source text, p_schedule text, p_failures integer, p_last timestamptz, p_now timestamptz, p_last_error text)
	RETURNS boolean
	LANGUAGE sql STABLE SET search_path = public
	AS $$
		SELECT p_last IS NULL OR app_feed_next_attempt(p_source, p_schedule, p_failures, p_last, p_last_error) <= p_now
	$$;

REVOKE ALL ON FUNCTION app_feed_next_attempt(text, text, integer, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_feed_next_attempt(text, text, integer, timestamptz, text) TO water_app;
