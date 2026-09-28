-- 031_feed_days — a data feed replaces only the days it wrote itself (issue #30;
-- docs/architecture.md § Data feeds, docs/data-model.md § Data feeds).
--
-- Until now a feed owned every day it fetched in its target series: on a day
-- the source had a value, that value replaced whatever was there, including a
-- value the user uploaded or imported. Now each series remembers which of its
-- days a feed wrote, and a fetch replaces only those (so final CHIRPS still
-- replaces preliminary CHIRPS, and a re-read still revises), fills empty days,
-- and keeps every other value (feeds/ingest.ts counts them in last_meta.kept).
--
-- * On the series row, not a side table: every write to a series already
--   locks and rewrites this row (series/merge.ts mergeInto, PUT), so the days
--   it releases change in the same statement, under the same RLS
--   (time_series_update: an editor), with no second table to keep in step.
-- * feed_days is a datemultirange: a feed writes runs of days, so a year of
--   CHIRPS is one range, and dates (not array offsets) don't move when the
--   series is extended backwards. Meaningful only with feed_id: the trigger
--   below clears it whenever feed_id is NULL.
-- * One feed per series (data_feed's UNIQUE target), so one feed_id suffices.
--   The composite foreign key keeps it to a feed of the same project.
-- * A user's write releases the days it covers: PUT the whole series,
--   POST …/series/merge the days it sends (the user wins, even with the same
--   value). Removing the feed (ON DELETE SET NULL) or re-targeting it (the
--   trigger on data_feed) releases all its days: they become ordinary data.
-- * No backfill: days a feed wrote before this migration are nobody's, so a
--   feed keeps them as they are (nothing is deployed yet).

-- For the composite foreign key below (id is already unique on its own).
ALTER TABLE data_feed ADD CONSTRAINT data_feed_project_id_id_key UNIQUE (project_id, id);

ALTER TABLE time_series
	ADD COLUMN feed_id uuid,
	ADD COLUMN feed_days datemultirange,
	ADD CONSTRAINT time_series_feed_days_need_feed CHECK (feed_days IS NULL OR feed_id IS NOT NULL),
	-- SET NULL (feed_id) only: project_id stays. Removing a feed hands its days back.
	ADD CONSTRAINT time_series_feed_fkey FOREIGN KEY (project_id, feed_id)
		REFERENCES data_feed (project_id, id) ON DELETE SET NULL (feed_id);
-- Covers the foreign key (catalogue.db.test.ts).
CREATE INDEX time_series_feed_idx ON time_series (project_id, feed_id);

COMMENT ON COLUMN time_series.feed_id IS 'The data feed that wrote feed_days (031_feed_days); NULL: no day is a feed''s.';
COMMENT ON COLUMN time_series.feed_days IS 'The days feed_id wrote and may replace (031_feed_days). A user''s write releases the days it covers; removing or re-targeting the feed releases all.';

-- No feed, no feed days: also clears them when the foreign key's SET NULL fires.
CREATE FUNCTION time_series_feed_days() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF NEW.feed_id IS NULL THEN
			NEW.feed_days := NULL;
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER time_series_feed_days BEFORE INSERT OR UPDATE OF feed_id, feed_days ON time_series
	FOR EACH ROW EXECUTE FUNCTION time_series_feed_days();

-- Re-targeting a feed releases the days it wrote in the old series: they say
-- nothing about the new one, and the feed no longer writes there. Runs as the
-- saving owner (an editor, so time_series_update allows it), under RLS.
CREATE FUNCTION data_feed_release_days() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		UPDATE time_series SET feed_id = NULL WHERE project_id = OLD.project_id AND feed_id = OLD.id;
		RETURN NULL;
	END
	$$;
CREATE TRIGGER data_feed_release_days AFTER UPDATE OF target_kind, target_name ON data_feed
	FOR EACH ROW WHEN (OLD.target_kind IS DISTINCT FROM NEW.target_kind OR OLD.target_name IS DISTINCT FROM NEW.target_name)
	EXECUTE FUNCTION data_feed_release_days();
