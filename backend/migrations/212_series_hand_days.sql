-- 212_series_hand_days — which days of a series a person typed in by hand
-- (issue #477, "daily series: correct or fill a day"; docs/data-model.md §
-- Days edited by hand).
--
-- A daily series could only be uploaded or filled by a data feed. A person
-- can now set or clear one day of it (PUT /projects/:id/series/:seriesId/
-- days/:date). An edited record must never pass as the raw one, so each
-- series remembers the days whose value was typed in, and the Data tab marks
-- them.
--
-- * time_series.hand_days: a datemultirange like feed_days (031), on the
--   row every write already locks and rewrites (series/merge.ts mergeSeries,
--   series/replace.ts replaceSeries), so it changes in the same statement,
--   under the same RLS (time_series_update: an editor). NULL = no day.
-- * A hand edit adds its day, even one it cleared (a blank typed in on
--   purpose is an edit too). A person's upload or paste that writes a day
--   releases it: the value is the file's now. Replacing the series whole
--   releases them all.
-- * A data feed and an API key's ingest never write a hand-edited day:
--   mergeSeries keeps the stored value there, as a feed keeps an uploaded
--   value (031). Otherwise the next fetch or push would quietly undo the
--   correction.
-- * series_revision.hand_days: a revision keeps the days with the values
--   they mark, so a restore puts the marks back (as 085 and 107 do).
--
-- Columns on existing tables: their RLS policies and water_app's table
-- grants already cover them, and they add no foreign key. Expand only:
-- every row starts with NULL (no day edited by hand, which is true: nothing
-- could edit a day before this).

ALTER TABLE time_series ADD COLUMN hand_days datemultirange;

COMMENT ON COLUMN time_series.hand_days IS
	'The days a person typed in by hand (212): set or cleared one day at a time. A person''s upload or paste that writes a day releases it, a replace releases all; a data feed or API key never writes one. NULL = none.';

ALTER TABLE series_revision ADD COLUMN hand_days datemultirange;

COMMENT ON COLUMN series_revision.hand_days IS
	'The series'' days edited by hand when the revision was recorded (212; time_series.hand_days). A restore puts them back.';
