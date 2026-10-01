-- 153_gauge_stations — the gauging stations the map proposes as a catchment's
-- observed-flow source (issue #326 Part B, "B-gauge"; docs/maps.md § Gauging
-- stations, docs/data-model.md § Catchment map).
--
-- In this file:
--  * gauge_station_reference: a reference dataset of flow-gauging stations
--    (a DWS station code such as A2H012, its name, river, position, the
--    catchment area it gauges and the dates its record spans), loaded by the
--    operator with `pnpm import:gauge-stations` (never by the app). The app
--    reads it to *propose* the nearest stations to the catchment's outlet;
--    the modeller picks one, and it only fills the DWS feed's station field,
--    which they still save. Global, not per project: any signed-in user reads
--    it; water_app never writes it (like quaternary_reference, 152).
--  * The repo ships only an invented, synthetic dataset (drainage region Z,
--    which DWS doesn't use, codes like Z1H001). The DWS station catalogue's
--    terms for commercial reuse are unconfirmed (docs/maps.md § Sources), so
--    the real catalogue is loaded only from the operator's own download once
--    they are, and never committed.
--  * No PostGIS (WP-3.12): a position is lon/lat columns; the distance is
--    computed in backend/src/geo/stations.ts (haversine), after a bounding-box
--    first pass on the index below.

CREATE TABLE gauge_station_reference (
	-- A DWS station code: drainage region letter, a digit, the station type
	-- letter (H river gauge, R reservoir, …), three digits. The committed
	-- synthetic dataset uses region Z, which DWS doesn't.
	code           text PRIMARY KEY CHECK (code ~ '^[A-Z][0-9][A-Z][0-9]{3}$'),
	name           text NOT NULL DEFAULT '' CHECK (char_length(name) <= 200),
	river          text NOT NULL DEFAULT '' CHECK (char_length(river) <= 200),
	lon            double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
	lat            double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
	-- The catchment area upstream of the station, km², as published; NULL = not given.
	catchment_km2  double precision CHECK (catchment_km2 IS NULL OR catchment_km2 > 0),
	-- The first and last day of the station's record; record_end NULL = still open (or not given).
	record_start   date,
	record_end     date,
	-- Which load it came from: 'synthetic' (the repo's invented fixture) or the operator's label ('DWS 2026-10').
	dataset        text NOT NULL CHECK (char_length(dataset) BETWEEN 1 AND 50),
	-- Shown with every proposal: the catalogue, its URL and the date it was downloaded.
	source         text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 500),
	loaded_at      timestamptz NOT NULL DEFAULT now(),
	CHECK (record_start IS NULL OR record_end IS NULL OR record_start <= record_end)
);
CREATE INDEX gauge_station_reference_pos_idx ON gauge_station_reference (lat, lon);
CREATE INDEX gauge_station_reference_dataset_idx ON gauge_station_reference (dataset);

COMMENT ON TABLE gauge_station_reference IS
	'Flow-gauging stations (code, river, position, record dates), loaded by the operator (pnpm import:gauge-stations), read-only to the app; the map proposes the nearest as the observed-flow source (153, issue #326). The repo ships a synthetic dataset only.';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE gauge_station_reference ENABLE ROW LEVEL SECURITY;
-- Public reference data: anyone signed in reads it; the app never writes it.
CREATE POLICY gauge_station_reference_select ON gauge_station_reference FOR SELECT USING (app_current_user_id() IS NOT NULL);

GRANT SELECT ON gauge_station_reference TO water_app;
