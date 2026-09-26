-- 033_series_day_boundary — how a series' days were built from sub-daily
-- readings (issue #40 (b) amendment 5; docs/data-model.md § Series day
-- boundary, docs/model.md §2.4e).
--
-- South African manual gauges are read at 08:00 and the reading is booked to
-- the previous day; an automatic station reports midnight to midnight. A
-- rain-source period that replaces a manual record with an automatic station
-- (settings.rainSource) should see the station's rain in the same windows,
-- or a storm straddling midnight lands on the wrong day. So an upload of
-- hourly or other sub-daily readings is added up into days in the window the
-- person picks, and the series records which:
--
--  * time_series.day_boundary: '08:00' = each day is 08:00 to 08:00 the next
--    morning, booked to the day it starts (the manual-gauge convention);
--    '00:00' = midnight to midnight. NULL = uploaded as daily values (or not
--    recorded). A replace (PUT) says what it holds, or clears it; a merge
--    that says one into a series holding days of the other is refused (409),
--    the same splice rule as 032's product/version guard. water_app's
--    existing table grants and RLS policies cover the new column.
--  * series_revision.day_boundary: kept with the values, so a restore puts
--    the boundary back with them (as 032 does for the product/version).

ALTER TABLE time_series
	ADD COLUMN day_boundary text CHECK (day_boundary IN ('00:00', '08:00'));

ALTER TABLE series_revision
	ADD COLUMN day_boundary text;

COMMENT ON COLUMN time_series.day_boundary IS
	'Sub-daily readings added up into days in this window, booked to the day it starts: 08:00 (manual-gauge day) or 00:00 (midnight). NULL = daily values as uploaded (033).';
