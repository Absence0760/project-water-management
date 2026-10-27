-- 253_feed_source_ecmwf — a second forecast source, the ECMWF ENS mean read
-- from our copy (issue #604 D17, R4-C; docs/architecture.md § Our copy of
-- the rain data, docs/data-model.md § Data feeds, docs/data-sources.md
-- ecmwf-ens).
--
-- 1. data_feed.source accepts 'ecmwf_ens' beside 'chirps', 'chirps_gefs'
--    and 'dws'. The CHECK is 018_feeds.sql's inline one
--    (data_feed_source_check), never changed since; it is dropped and added
--    again under the same name in one statement, so the table is never
--    without it. Adding it scans data_feed, a few rows per project.
--    feeds/config.ts FEED_SOURCES lists the same four, and
--    scripts/guards/data_sources.mjs checks that they agree.
--
-- 2. app_feed_next_attempt (243_feed_next_attempt.sql, its latest
--    definition) gives an ECMWF feed its own daily slot, 14:00 UTC, as a
--    CHIRPS-GEFS feed has 08:45: the copy's ECMWF job (infra/ecmwf.tf) runs
--    every 20 minutes from 10:00 to 13:40 UTC while ECMWF publishes the 00
--    UTC run's 0.1° files (~09:40) and the job reads them at a request a
--    second (~13 minutes an issue), so at 14:00 today's issue is in the copy
--    on a normal day. A feed scheduled any time of day instead (the rule for
--    every other source) would land before it most days and read
--    yesterday's issue. Everything else is 243's body unchanged: the
--    failure backoff, and app_feed_is_due, which calls this function and so
--    picks the slot up without being replaced. Same signature, so CREATE OR
--    REPLACE keeps 243's grants (water_app EXECUTE, PUBLIC revoked).
--
-- No table, policy, RLS or grant changes: data_feed's policies don't look at
-- the source.

ALTER TABLE data_feed
	DROP CONSTRAINT data_feed_source_check,
	ADD CONSTRAINT data_feed_source_check CHECK (source IN ('chirps', 'chirps_gefs', 'dws', 'ecmwf_ens'));

CREATE OR REPLACE FUNCTION app_feed_next_attempt(p_source text, p_schedule text, p_failures integer, p_last timestamptz, p_last_error text)
	RETURNS timestamptz
	LANGUAGE sql STABLE SET search_path = public
	AS $$
		SELECT CASE WHEN p_last IS NULL THEN NULL ELSE LEAST(
			CASE WHEN p_source IN ('chirps_gefs', 'ecmwf_ens') THEN (
				SELECT CASE WHEN s > p_last THEN s ELSE s + interval '1 day' END
				FROM (
					SELECT (date_trunc('day', p_last AT TIME ZONE 'UTC')
						+ CASE WHEN p_source = 'chirps_gefs' THEN interval '8 hours 45 minutes' ELSE interval '14 hours' END) AT TIME ZONE 'UTC' AS s
				) slot
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
