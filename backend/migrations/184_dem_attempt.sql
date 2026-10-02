-- 184_dem_attempt — a per-account cap on elevation-model work (delineate,
-- start from the map, divide), counted before the work and including the
-- attempts that end refused or failed (docs/security.md § Map uploads).
--
-- Before, the "30 a project an hour" caps (175, 178) counted only stored
-- proposals: a refused (422 too_large) or failed (503) attempt stored none,
-- so it never counted, though it had already spent up to the 20 s budget
-- and ~0.5 GB reading and routing the DEM; the count ran in its own
-- transaction before the work, so parallel POSTs all passed it; and a new
-- project reset it. One account could keep every API Lambda slot busy.
--
-- Now each route calls app_dem_attempt before the DEM work, in the same
-- transaction as its role check. It serialises the account's attempts on an
-- advisory lock, refuses ('in_flight') when the account already has
-- p_in_flight attempts running (started within p_lease and not finished, so
-- a Lambda that died mid-attempt frees its slot once the lease runs out),
-- refuses ('hourly') once p_per_hour attempts started in the last hour,
-- across every project, and otherwise records the attempt and returns its
-- id. app_dem_attempt_done marks it finished, whatever the outcome. The
-- per-project proposal caps stay as they were.
--
-- Personal data: the row names the account (ON DELETE CASCADE, so it goes
-- with the account) and the kind of request, nothing else; rows go once a
-- day old. Not exported (auth/export.ts USER_FK_COVERAGE), as
-- account_mail_quota (078): a count for a cap, a day at most.

CREATE TABLE dem_attempt (
	id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id     uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
	kind        text NOT NULL CHECK (kind IN ('delineation', 'start', 'divide')),
	started_at  timestamptz NOT NULL DEFAULT now(),
	finished_at timestamptz
);
COMMENT ON TABLE dem_attempt IS
	'Elevation-model requests per account for the hourly and in-flight caps (184). SECURITY DEFINER access only; rows go after a day.';
-- Covers the foreign key, and both counts.
CREATE INDEX dem_attempt_user_idx ON dem_attempt (user_id, started_at);
-- Housekeeping deletes rows by age.
CREATE INDEX dem_attempt_started_idx ON dem_attempt (started_at);

-- As account_mail_quota: the app touches it only through the functions below.
ALTER TABLE dem_attempt ENABLE ROW LEVEL SECURITY;
CREATE POLICY dem_attempt_none ON dem_attempt USING (false) WITH CHECK (false);
GRANT SELECT, INSERT, UPDATE, DELETE ON dem_attempt TO water_app;

-- Returns the new attempt's id, or 'in_flight' / 'hourly' when refused.
CREATE FUNCTION app_dem_attempt(p_kind text, p_per_hour integer, p_in_flight integer, p_lease interval) RETURNS text
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_user uuid := app_current_user_id();
		v_id uuid;
	BEGIN
		IF v_user IS NULL THEN
			RAISE EXCEPTION 'app_dem_attempt needs a signed-in user' USING ERRCODE = '42501';
		END IF;
		-- Serialise one account's attempts, so parallel requests can't all pass the counts.
		PERFORM pg_advisory_xact_lock(hashtext('dem_attempt:' || v_user::text));
		DELETE FROM dem_attempt WHERE started_at <= now() - interval '1 day';
		IF (SELECT count(*) FROM dem_attempt
			WHERE user_id = v_user AND finished_at IS NULL AND started_at > now() - p_lease) >= p_in_flight THEN
			RETURN 'in_flight';
		END IF;
		IF (SELECT count(*) FROM dem_attempt WHERE user_id = v_user AND started_at > now() - interval '1 hour') >= p_per_hour THEN
			RETURN 'hourly';
		END IF;
		INSERT INTO dem_attempt (user_id, kind) VALUES (v_user, p_kind) RETURNING id INTO v_id;
		RETURN v_id::text;
	END
	$$;
REVOKE ALL ON FUNCTION app_dem_attempt(text, integer, integer, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_dem_attempt(text, integer, integer, interval) TO water_app;

-- Marks the caller's own attempt finished (any outcome): frees its in-flight slot; it still counts for the hour.
CREATE FUNCTION app_dem_attempt_done(p_id uuid) RETURNS void
	LANGUAGE sql SECURITY DEFINER SET search_path = public
	AS $$
	UPDATE dem_attempt SET finished_at = now() WHERE id = p_id AND user_id = app_current_user_id() AND finished_at IS NULL;
	$$;
REVOKE ALL ON FUNCTION app_dem_attempt_done(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_dem_attempt_done(uuid) TO water_app;
