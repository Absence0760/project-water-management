-- 260_feed_source_agera5_et0 — a daily reference evapotranspiration feed read
-- from our copy (issue #604 R5-E; docs/architecture.md § Our copy of the rain
-- data, docs/data-model.md § Data feeds, docs/data-sources.md agera5,
-- docs/model.md §2.4a "Daily reference ET").
--
-- data_feed.source accepts 'agera5_et0' beside 'chirps', 'chirps_gefs',
-- 'dws' and 'ecmwf_ens'. The CHECK is 253_feed_source_ecmwf.sql's (its latest
-- definition, data_feed_source_check); it is dropped and added again under the
-- same name in one statement, so the table is never without it. Adding it
-- scans data_feed, a few rows per project. feeds/config.ts FEED_SOURCES lists
-- the same five, and scripts/guards/data_sources.mjs checks that they agree.
--
-- An agera5_et0 feed writes the project's `evap_et0_mm` series from our copy
-- of AgERA5 (and NASA POWER's computed ET₀ on its newest days), read in the
-- worker's own feed_fetch job (feeds/fromMirrorEt0.ts); no request leaves for
-- the CDS or NASA from a feed. Its schedule is app_feed_next_attempt's
-- default (243, 253): a day after the last attempt, with the usual backoff.
-- The copy changes once a day at most, so no fixed slot is needed.
--
-- No table, policy, RLS, function or grant changes: data_feed's policies don't
-- look at the source.

ALTER TABLE data_feed
	DROP CONSTRAINT data_feed_source_check,
	ADD CONSTRAINT data_feed_source_check CHECK (source IN ('chirps', 'chirps_gefs', 'dws', 'ecmwf_ens', 'agera5_et0'));
