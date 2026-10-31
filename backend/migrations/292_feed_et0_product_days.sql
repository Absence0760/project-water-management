-- 292_feed_et0_product_days — which product a reference ET feed wrote on
-- each day (issue #604 R5-E; docs/data-model.md § Data feeds,
-- docs/data-sources.md § ERA5-Land, *Where the credits show*).
--
-- An `agera5_et0` feed writes AgERA5's value on a day its copy holds and
-- NASA POWER's otherwise (feeds/fromMirrorEt0.ts), and a run credits the
-- products whose values GR4J read (runs/execute.ts et0FeedDays, engine
-- et0ProductsRead). Until now the series didn't say which product a day
-- held, so the credit split the feed's days at its latest fetch's
-- last_meta.agera5Through: a POWER day the feed never re-read after
-- AgERA5's month landed (a pause longer than its 75-day re-read) was
-- credited to AgERA5 alone. Now the ingest records the days each product
-- wrote, and the credit reads that.
--
-- * Two datemultiranges on the series row, beside feed_days (031) and
--   hand_days (212), for the same reasons: every write already locks and
--   rewrites this row (series/merge.ts mergeSeries), so they change in the
--   same statement under the same RLS, with no second table to keep in step.
-- * Each is a subset of feed_days: a feed's merge records the product of
--   every day it writes (and forgets the product of a day it rewrites with
--   none), and any merge drops the days feed_days no longer holds (a
--   person's write releases them). Readers intersect with feed_days anyway.
-- * A feed day in neither is one written before this migration, or by a
--   caller that named no product: unknown, so the credit owes both.
-- * Cleared with feed_days: the trigger below (feed_id NULL: a person's
--   replace, the feed removed or re-targeted), and series/replace.ts.
--
-- Columns on an existing table: its RLS policies and water_app's table
-- grants already cover them, and they add no foreign key. Expand only: every
-- row starts NULL (no day recorded), which the credit reads as unknown.

ALTER TABLE time_series
	ADD COLUMN feed_agera5_days datemultirange,
	ADD COLUMN feed_power_days datemultirange,
	ADD CONSTRAINT time_series_feed_agera5_days_need_feed CHECK (feed_agera5_days IS NULL OR feed_id IS NOT NULL),
	ADD CONSTRAINT time_series_feed_power_days_need_feed CHECK (feed_power_days IS NULL OR feed_id IS NOT NULL);

COMMENT ON COLUMN time_series.feed_agera5_days IS
	'The days of feed_days an agera5_et0 feed wrote from AgERA5 (292). A feed day in neither this nor feed_power_days has no recorded product. NULL = none.';
COMMENT ON COLUMN time_series.feed_power_days IS
	'The days of feed_days an agera5_et0 feed wrote from NASA POWER (292). A feed day in neither this nor feed_agera5_days has no recorded product. NULL = none.';

-- From 031's definition: no feed, no feed days, and now no product days either.
CREATE OR REPLACE FUNCTION time_series_feed_days() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF NEW.feed_id IS NULL THEN
			NEW.feed_days := NULL;
			NEW.feed_agera5_days := NULL;
			NEW.feed_power_days := NULL;
		END IF;
		RETURN NEW;
	END
	$$;
DROP TRIGGER time_series_feed_days ON time_series;
CREATE TRIGGER time_series_feed_days BEFORE INSERT OR UPDATE OF feed_id, feed_days, feed_agera5_days, feed_power_days ON time_series
	FOR EACH ROW EXECUTE FUNCTION time_series_feed_days();
