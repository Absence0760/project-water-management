-- 274_evaporation_stations — the DWS evaporation stations whose daily pan
-- record the Calibration page proposes as the A-pan (issue #646 item 6;
-- docs/maps.md § Evaporation stations, docs/data-model.md § Catchment map,
-- docs/data-sources.md § dws-evaporation).
--
-- In this file:
--  * evaporation_station_reference: a reference dataset of evaporation
--    stations (a DWS weather-station code such as A2E001, its name, the pan
--    it reads, Class-A or Symons, its position) with the station's verified
--    daily pan record (mm a day from start_date, NULL for a missing day),
--    loaded by the operator with `pnpm import:evaporation-stations` (never by
--    the app). The app reads it to *propose* the nearest stations to the
--    catchment boundary; the modeller picks one (and, for a Symons pan, the
--    S→A equation), and only then are the A-pan row and the daily series
--    written, as a settings revision citing the station. Global, not per
--    project: any signed-in user reads it; water_app never writes it (like
--    gauge_station_reference, 156).
--  * The repo ships only an invented dataset (drainage region Z, which DWS
--    doesn't use: codes like Z1E001). DWS's permission recorded on
--    2026-10-28 covers verified daily flow only, so the real records are
--    loaded only into the operator's own database until it is extended to
--    evaporation stations; production's reference load refuses the kind
--    (backend/src/geo/referenceLoad.ts).
--  * days_with_value is stored with the record so the station list never
--    reads the values array; the loader writes both (a CHECK keeps it within
--    the record's length).
--  * No PostGIS (WP-3.12): a position is lon/lat columns; the distance is
--    computed in backend/src/geo/evaporationStations.ts, after a bounding-box
--    first pass on the index below.

CREATE TABLE evaporation_station_reference (
	-- A DWS station code: drainage region letter, a digit, E (a weather station), three digits.
	code            text PRIMARY KEY CHECK (code ~ '^[A-Z][0-9]E[0-9]{3}$'),
	name            text NOT NULL DEFAULT '' CHECK (char_length(name) <= 200),
	-- The pan the record was read from: a US Class-A pan or a sunken Symons pan.
	pan             text NOT NULL CHECK (pan IN ('class_a', 'symons')),
	lon             double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
	lat             double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
	-- The daily record: "values"[1] is start_date's pan evaporation, mm; NULL = no reading that day.
	start_date      date NOT NULL,
	"values"        double precision[] NOT NULL CHECK (
		cardinality("values") BETWEEN 1 AND 21960
		AND array_ndims("values") = 1
		AND 0 <= ALL ("values") AND 50 >= ALL ("values")
	),
	days_with_value integer NOT NULL CHECK (days_with_value >= 1 AND days_with_value <= cardinality("values")),
	-- Which load it came from: 'synthetic' (the repo's invented fixture) or the operator's label ('DWS 2026-11').
	dataset         text NOT NULL CHECK (char_length(dataset) BETWEEN 1 AND 50),
	-- Shown with every proposal and cited in the revision: the records, the reply's reference, the date.
	source          text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 500),
	loaded_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evaporation_station_reference_pos_idx ON evaporation_station_reference (lat, lon);
CREATE INDEX evaporation_station_reference_dataset_idx ON evaporation_station_reference (dataset);

COMMENT ON TABLE evaporation_station_reference IS
	'DWS evaporation stations (code, pan type, position) with each one''s daily pan record, loaded by the operator (pnpm import:evaporation-stations), read-only to the app; the Calibration page proposes the nearest as the A-pan (274, issue #646). The repo ships a synthetic dataset only; production refuses the load until DWS''s permission covers evaporation records.';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE evaporation_station_reference ENABLE ROW LEVEL SECURITY;
-- Public reference data: anyone signed in reads it; the app never writes it.
CREATE POLICY evaporation_station_reference_select ON evaporation_station_reference FOR SELECT USING (app_current_user_id() IS NOT NULL);

GRANT SELECT ON evaporation_station_reference TO water_app;
