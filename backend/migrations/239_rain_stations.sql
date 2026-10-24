-- 239_rain_stations — a rainfall station's MAP, its source and its place, on
-- the catchment rain series (issue #553 round 1; docs/data-model.md §
-- Rainfall stations, docs/model.md §2.4h).
--
-- A rainfall station is a catchment rain series: kind rain_catchment_mm with
-- no site (site_node_id NULL). A project may have several, told apart by
-- name (001's UNIQUE (project_id, kind, name)). Each now carries its own mean
-- annual precipitation and where it came from, and optionally its
-- coordinates (engine SeriesMeta.station, RainStationMeta { mapMm,
-- mapSource, lat, lon }). It replaces settings.unitRain.gaugeMapMm /
-- gaugeMapSource, the one catchment gauge's MAP: the run builder takes the
-- station's MAP in its place, so runs stay bit-identical.
--
-- * time_series.station_map_mm / station_map_source: the station's MAP, mm,
--   and its source. Bounds as the engine's MAP_MM_MIN / MAP_MM_MAX
--   (1–12 000) and PE_SOURCE_MAX (600), and a MAP needs its source (engine
--   mapMmError, which the API applies), as 209's node.map_mm / map_source.
-- * time_series.station_lat / station_lon: where the station is, WGS84
--   degrees (−90..90, −180..180), both or neither.
-- * Only a station has them (time_series_station_only): every station column
--   is NULL unless kind = 'rain_catchment_mm' AND site_node_id IS NULL. A
--   unit-sited gauge series (209) has none; a later round turns those into
--   stations assigned to their unit.
-- * The data step copies each project's stored settings.unitRain.gaugeMapMm
--   and gaugeMapSource onto the catchment rain series a run reads: of the
--   series with no site, the first rain_catchment_mm by the name's bytes
--   (runs/execute.ts loadLiveInput, DISTINCT ON (site_node_id, kind) ORDER
--   BY site_node_id NULLS FIRST, kind, name COLLATE "C"; docs/data-model.md §
--   Which series a run reads). Only a pair the engine would use (mapMmError
--   passes: a number in bounds with a non-blank source of at most 600
--   characters); a project without such a series copies nothing. The
--   baseline settings are project.settings; a scenario can't set unitRain
--   (no settings.set path for it, engine scenario/ops.ts), and a run or model
--   revision keeps the settings it was made with (records of the past), so
--   only project.settings is read. The settings JSON is left as it is
--   (expand only): today's code still reads gaugeMapMm from it, and a later
--   migration drops it once the code reads the station.
--
-- Columns on an existing project table (001's time_series): its RLS policies
-- (the viewer/editor policies and 039's API-key policies, all row-level), its
-- same-project triggers and its table-level grant to water_app (001) already
-- cover them; no new foreign key, so no new index, and no new function. No
-- trigger fires on the data step's UPDATE (031's, 084's and 209's fire only on
-- feed_id / feed_days / site_node_id / kind, or on INSERT). Expand only: older
-- code writes rows that pass every new check (it sets no station column).

ALTER TABLE time_series
	ADD COLUMN station_map_mm double precision
		CONSTRAINT time_series_station_map_mm_range CHECK (station_map_mm IS NULL OR (station_map_mm >= 1 AND station_map_mm <= 12000)),
	ADD COLUMN station_map_source text
		CONSTRAINT time_series_station_map_source_text CHECK (station_map_source IS NULL OR (char_length(station_map_source) BETWEEN 1 AND 600 AND station_map_source ~ '\S')),
	ADD COLUMN station_lat double precision
		CONSTRAINT time_series_station_lat_range CHECK (station_lat IS NULL OR (station_lat >= -90 AND station_lat <= 90)),
	ADD COLUMN station_lon double precision
		CONSTRAINT time_series_station_lon_range CHECK (station_lon IS NULL OR (station_lon >= -180 AND station_lon <= 180)),
	ADD CONSTRAINT time_series_station_map_needs_source CHECK (station_map_mm IS NULL OR station_map_source IS NOT NULL),
	ADD CONSTRAINT time_series_station_lat_lon_together CHECK ((station_lat IS NULL) = (station_lon IS NULL)),
	ADD CONSTRAINT time_series_station_only CHECK (
		(station_map_mm IS NULL AND station_map_source IS NULL AND station_lat IS NULL AND station_lon IS NULL)
		OR (kind = 'rain_catchment_mm' AND site_node_id IS NULL)
	);

COMMENT ON COLUMN time_series.station_map_mm IS
	'A rainfall station''s mean annual precipitation, mm (1-12000; 239_rain_stations, issue #553); NULL = none. Only on a station: kind rain_catchment_mm with no site.';
COMMENT ON COLUMN time_series.station_map_source IS
	'Where time_series.station_map_mm came from (a dataset or study, and its period; at most 600 characters). Required with a MAP.';
COMMENT ON COLUMN time_series.station_lat IS
	'A rainfall station''s latitude, WGS84 degrees (-90..90), with station_lon or not at all; NULL = not known.';
COMMENT ON COLUMN time_series.station_lon IS
	'A rainfall station''s longitude, WGS84 degrees (-180..180), with station_lat or not at all; NULL = not known.';

-- data step: settings.unitRain gauge MAP -> the station a run reads
UPDATE time_series t
SET station_map_mm = g.map_mm, station_map_source = g.map_source
FROM (
	SELECT DISTINCT ON (s.project_id) s.id, (p.settings -> 'unitRain' ->> 'gaugeMapMm')::double precision AS map_mm, p.settings -> 'unitRain' ->> 'gaugeMapSource' AS map_source
	FROM project p
	JOIN time_series s ON s.project_id = p.id AND s.kind = 'rain_catchment_mm' AND s.site_node_id IS NULL
	WHERE jsonb_typeof(p.settings -> 'unitRain' -> 'gaugeMapMm') = 'number'
	  AND (p.settings -> 'unitRain' ->> 'gaugeMapMm')::double precision BETWEEN 1 AND 12000
	  AND jsonb_typeof(p.settings -> 'unitRain' -> 'gaugeMapSource') = 'string'
	  AND (p.settings -> 'unitRain' ->> 'gaugeMapSource') ~ '\S'
	  AND char_length(p.settings -> 'unitRain' ->> 'gaugeMapSource') <= 600
	ORDER BY s.project_id, s.name COLLATE "C"
) g
WHERE t.id = g.id AND t.station_map_mm IS NULL;
