-- 307_dem_attempt_channels_budget — the elevation model's channel tiles get
-- their own budget, apart from delineation's (docs/maps.md § The elevation
-- model's channels, docs/security.md § Map uploads).
--
-- Until now a channel tile computed for the Map (GET …/map/channels, not one
-- served from the cache) began a 'delineation' attempt (184), so it counted
-- against the same 60-an-hour, 2-at-once cap as delineate, start and divide.
-- With the DEM rivers layer (layers=channels) drawing them outside
-- Delineate, exploring new ground could spend the hour and then refuse the
-- delineation the editor came to run: a background layer starving the tool.
--
-- Now a channel tile begins a 'channels' attempt, and app_dem_attempt counts
-- each kind against its own pool: 'channels' against the channel tiles alone,
-- every other kind against the others alone (as before). The caller still
-- passes each pool's limits (attempt.ts DEM_ATTEMPTS, CHANNEL_ATTEMPTS). The
-- same advisory lock serialises one account's attempts of both pools.
--
-- Expand only: the old backend calls with 'delineation' for a tile, which
-- lands in the delineation pool as it always did; no row changes.
-- Starts from 184's definition, the only one.

ALTER TABLE dem_attempt DROP CONSTRAINT dem_attempt_kind_check;
ALTER TABLE dem_attempt ADD CONSTRAINT dem_attempt_kind_check CHECK (kind IN ('delineation', 'start', 'divide', 'channels'));

COMMENT ON TABLE dem_attempt IS
	'Elevation-model requests per account for the hourly and in-flight caps (184; channel tiles counted apart since 307). SECURITY DEFINER access only; rows go after a day.';

-- Returns the new attempt's id, or 'in_flight' / 'hourly' when refused, counting only p_kind's pool.
CREATE OR REPLACE FUNCTION app_dem_attempt(p_kind text, p_per_hour integer, p_in_flight integer, p_lease interval) RETURNS text
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_user uuid := app_current_user_id();
		v_channels boolean := p_kind = 'channels';
		v_id uuid;
	BEGIN
		IF v_user IS NULL THEN
			RAISE EXCEPTION 'app_dem_attempt needs a signed-in user' USING ERRCODE = '42501';
		END IF;
		-- Serialise one account's attempts, so parallel requests can't all pass the counts.
		PERFORM pg_advisory_xact_lock(hashtext('dem_attempt:' || v_user::text));
		DELETE FROM dem_attempt WHERE started_at <= now() - interval '1 day';
		IF (SELECT count(*) FROM dem_attempt
			WHERE user_id = v_user AND (kind = 'channels') = v_channels
				AND finished_at IS NULL AND started_at > now() - p_lease) >= p_in_flight THEN
			RETURN 'in_flight';
		END IF;
		IF (SELECT count(*) FROM dem_attempt
			WHERE user_id = v_user AND (kind = 'channels') = v_channels
				AND started_at > now() - interval '1 hour') >= p_per_hour THEN
			RETURN 'hourly';
		END IF;
		INSERT INTO dem_attempt (user_id, kind) VALUES (v_user, p_kind) RETURNING id INTO v_id;
		RETURN v_id::text;
	END
	$$;
-- CREATE OR REPLACE keeps 184's grants; restated so the file reads whole.
REVOKE ALL ON FUNCTION app_dem_attempt(text, integer, integer, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_dem_attempt(text, integer, integer, interval) TO water_app;
