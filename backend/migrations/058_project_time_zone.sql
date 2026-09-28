-- 058_project_time_zone — the project's own time zone (issue #45;
-- docs/data-model.md § Projects, docs/api.md § Projects and § Export).
--
-- Expand-only:
--
--   project.time_zone text, 'Africa/Johannesburg' by default: an IANA zone
--   name. The dates a project's downloads carry in their file names are the
--   calendar day there, not UTC's, so a South African export made after
--   local midnight (22:00–24:00 UTC) is named for the day it was made rather
--   than the day before (backend/src/export/csv.ts exportFilename). Every
--   existing project takes the default: the app so far serves South African
--   catchments, the same default report schedules use (023_reports.sql).
--
--   The API accepts only a zone the runtime knows (Intl, as report
--   schedules: backend/src/reports/due.ts isValidTimeZone); the CHECK below
--   bounds the text for any other writer, as report_schedule.timezone does.
--
-- Access is unchanged: project_select (001) lets every member read the row,
-- project_update (002) lets an editor change it, and water_app's table-level
-- grant on project (001) covers the new column.

ALTER TABLE project
	ADD COLUMN time_zone text NOT NULL DEFAULT 'Africa/Johannesburg' CHECK (char_length(time_zone) BETWEEN 1 AND 64);
