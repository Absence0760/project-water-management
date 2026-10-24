-- 241_station_input_series — a run's rainfall station inputs name the series
-- they were read from (issue #553 round 2; docs/data-model.md § Rainfall
-- stations, § Stored run inputs).
--
-- Under settings.rainStations a run reads every rainfall station's record
-- (a rain_catchment_mm series with no site, 239) under the key
-- `rain_station_mm#<series id>` (engine stationSeriesKey;
-- runs/stationInput.ts). run_input_series.series_id records which series an
-- input was read from (056), and three things read it: the API-key ingest
-- hold's "what a person last accepted" (app_api_key_accepted_series, 188;
-- series/hold.ts step 2), and a series download's columns from the latest
-- run that read it (export/routes.ts loadReadingRun). Until now a station's
-- key could carry no series_id: run_input_series_series_kind (latest
-- definition 084) takes the key's kind as the part before an `@`, and
-- `rain_station_mm#…` is no stored kind. So a manual run never counted as a
-- person accepting a station other than the one it also read as
-- rain_catchment_mm, and a key pushing to such a station was judged
-- against its own pushes only (the weak `own` limit), however often the
-- model was run.
--
-- The trigger now also takes a station key: its series_id must be the
-- series the key names (the id after `#`), a rain_catchment_mm series of
-- the project. Not its site, as 084 doesn't check a gauge record's: an
-- editor may site the series between the run reading its inputs and storing
-- them, and the stored values are what the run used either way. Every other
-- key is checked exactly as before (the CHIRPS at a station's cell,
-- `rain_chirps_station_mm#…`, is no series, so its series_id stays NULL and
-- any other is refused, as before).
--
-- A function only (CREATE OR REPLACE from 084, its latest definition; the
-- trigger from 056 still calls it). search_path pinned. No table, column,
-- policy, grant or foreign key changes.

CREATE OR REPLACE FUNCTION run_input_series_series_kind() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF NEW.series_id IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM time_series t
			WHERE t.project_id = NEW.project_id AND t.id = NEW.series_id
			  AND (
				t.kind = split_part(NEW.kind, '@', 1)
				OR (NEW.kind = 'rain_station_mm#' || t.id::text AND t.kind = 'rain_catchment_mm')
			  )
		) THEN
			RAISE EXCEPTION 'a run input of kind % names a series of another kind', NEW.kind USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END
	$$;
