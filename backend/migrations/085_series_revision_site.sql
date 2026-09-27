-- 085_series_revision_site — a series revision keeps a flow record's site
-- (084_gauge_records), so a restore puts the record back at its gauge
-- (issue #64 follow-up; docs/data-model.md § Gauge records).
--
-- Until now a revision kept the values, the product and version (032) and the
-- day boundary (033), but not time_series.site_node_id: a deleted gauge
-- record restored from its revision came back with no site, which is the
-- outlet, and so could quietly become the record the outlet calibrates
-- against.
--
-- * recordSeriesRevision (history/record.ts) writes the series' site as the
--   revision is recorded, before the change; the series restore
--   (history/routes.ts) sets it back when it differs, through the
--   same-project trigger on time_series (084), and refuses (409) when the
--   gauge has since left the model rather than put it at the outlet.
-- * A plain uuid like time_series.site_node_id: a revision outlives its
--   gauge, and no foreign key means no covering index.
-- * Existing revisions get NULL. A revision recorded before this migration
--   of a record that was at a gauge (possible only since 084, days earlier)
--   restores to the outlet, as before; no backfill can know its site.
-- * series_revision's grants (SELECT, INSERT, 030) and policies cover the
--   new column; it stays append-only for water_app. Farmers never read
--   series_revision (viewer and above, 030), which the catalogue's farmer
--   list now says.

ALTER TABLE series_revision ADD COLUMN site_node_id uuid;

COMMENT ON COLUMN series_revision.site_node_id IS
	'The series'' site when the revision was recorded (085; time_series.site_node_id, 084): the gauge node a flow record was measured at, NULL = the outlet. A restore puts it back.';
