-- 107_series_source — where a series' values came from, and the unit they
-- were given in (issue #66, "Data quality tools": source and unit
-- provenance; docs/data-model.md § Series source and unit).
--
-- 032 records a series' product and version (CHIRPS v2.0 …). This records,
-- for any series, what 032 can't say:
--
--  * time_series.source: free text, e.g. a DWS station id ("DWS X1H001"),
--    an agency, a file name or a data feed. NULL = not recorded. Set by an
--    upload or merge that says it (a replace that doesn't say clears it, as
--    for the product), by a data feed on the series it creates, by an import
--    or copy, and by PATCH /projects/:id/series/:seriesId.
--  * time_series.source_unit / source_unit_factor: the unit the values were
--    given in before the series routes converted them to the kind's
--    canonical unit (engine units.ts), and the factor applied (1 = none).
--    Both or neither; NULL = not recorded (every series stored before this
--    migration). Written by the routes from the upload itself, never by
--    hand: the conversion is a fact of the upload. A merge into a series
--    holding values keeps the series' own, as it keeps its product.
--  * series_revision gets the same three columns, so a restore puts them
--    back with the values they describe (as 032 and 033 do).
--
-- Columns on existing tables: their RLS policies and water_app's table
-- grants already cover them, and they add no foreign key. Expand only:
-- nothing reads a missing column, and every column is NULL on existing rows.
-- The engine never reads them; a run records them in its input snapshot
-- (inputs.series[kind].origin) for the run comparison and the fit record.

ALTER TABLE time_series
	ADD COLUMN source             text CHECK (char_length(source) BETWEEN 1 AND 200 AND source !~ '[[:cntrl:]]'),
	ADD COLUMN source_unit        text CHECK (char_length(source_unit) BETWEEN 1 AND 20),
	ADD COLUMN source_unit_factor double precision CHECK (source_unit_factor > 0 AND source_unit_factor < 'Infinity'::float8),
	ADD CONSTRAINT time_series_source_unit CHECK ((source_unit IS NULL) = (source_unit_factor IS NULL));

COMMENT ON COLUMN time_series.source IS 'Where the values came from: a station id, agency, file or data feed, free text (107). NULL = not recorded.';
COMMENT ON COLUMN time_series.source_unit IS 'The unit the values were given in, before conversion to the stored unit (107). NULL with source_unit_factor = not recorded.';
COMMENT ON COLUMN time_series.source_unit_factor IS 'The factor that converted the given values to the stored unit, 1 = none (107).';

ALTER TABLE series_revision
	ADD COLUMN source             text,
	ADD COLUMN source_unit        text,
	ADD COLUMN source_unit_factor double precision;
