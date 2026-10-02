-- 186_map_compute_throttle — an hourly cap on tracing a dam from the water
-- occurrence raster, counted before the work (round-4 hardening;
-- docs/security.md § Input handling › Tracing a dam).
--
-- POST …/map/dam-trace, and the re-trace when a traced outline is saved
-- (POST …/map/features with `traced`), read the raster (ranged S3 reads in
-- production) and flood-fill up to a 512-cell window on the API, with no
-- cap at all: one account could keep API slots busy with traces. This
-- counts every attempt, before the work, under a row lock (so parallel
-- requests are counted one by one), per signed-in user (across projects,
-- since a user can make projects) and per project, in a fixed one-hour
-- window (delineation/throttle.ts MAP_COMPUTE_CAPS). The elevation-model
-- routes (delineate, start, divide) have their own cap (184_dem_attempt).
-- The kind column of the bucket leaves room for another map computation.
--
-- The bucket is 'user:' or 'project:', the id, ':' and the kind. Rows are
-- deleted once their window is over (at the next attempt), so nothing here
-- outlives an hour or so.

CREATE TABLE map_compute_throttle (
	bucket       text PRIMARY KEY CHECK (bucket ~ '^(user|project):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:trace$'),
	window_start timestamptz NOT NULL DEFAULT now(),
	attempts     integer NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);
-- Housekeeping deletes rows by age.
CREATE INDEX map_compute_throttle_window_idx ON map_compute_throttle (window_start);

COMMENT ON TABLE map_compute_throttle IS
	'Attempts at tracing a dam per user and per project in a one-hour window (186). Only app_map_compute_attempt touches it.';

-- Only the SECURITY DEFINER function below touches it; the deny-all policy
-- keeps direct access closed (the invite_throttle pattern, 101).
ALTER TABLE map_compute_throttle ENABLE ROW LEVEL SECURITY;
CREATE POLICY map_compute_throttle_none ON map_compute_throttle USING (false) WITH CHECK (false);
GRANT SELECT, INSERT, UPDATE, DELETE ON map_compute_throttle TO water_app;

-- Count one attempt of kind p_kind by the signed-in user on project
-- p_project, where they are at least an editor. Returns 0 to go ahead
-- (counted in both buckets), or the seconds until the fuller bucket's window
-- ends (nothing counted). Anyone else, or no user, is refused with an error:
-- the route has checked the role already, so this only stops a caller from
-- using up another project's allowance.
CREATE FUNCTION app_map_compute_attempt(p_project uuid, p_kind text, p_user_limit integer, p_project_limit integer)
	RETURNS integer
	LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_user_bucket text;
		v_project_bucket text;
		v_user map_compute_throttle;
		v_project map_compute_throttle;
		v_wait integer := 0;
	BEGIN
		IF app_current_user_id() IS NULL OR p_project IS NULL OR p_kind IS NULL OR p_kind <> 'trace'
			OR p_user_limit IS NULL OR p_user_limit < 1 OR p_project_limit IS NULL OR p_project_limit < 1
			OR NOT coalesce(app_has_role(p_project, 'editor'), false) THEN
			RAISE EXCEPTION 'app_map_compute_attempt: not allowed' USING ERRCODE = '42501';
		END IF;
		v_user_bucket := 'user:' || app_current_user_id()::text || ':' || p_kind;
		v_project_bucket := 'project:' || p_project::text || ':' || p_kind;
		-- Housekeeping, and the end of a window: its row goes.
		DELETE FROM map_compute_throttle WHERE window_start <= now() - interval '1 hour';
		INSERT INTO map_compute_throttle (bucket) VALUES (v_user_bucket), (v_project_bucket) ON CONFLICT (bucket) DO NOTHING;
		-- Row locks, always the user's first: concurrent attempts are counted one by one.
		SELECT * INTO v_user FROM map_compute_throttle WHERE bucket = v_user_bucket FOR UPDATE;
		SELECT * INTO v_project FROM map_compute_throttle WHERE bucket = v_project_bucket FOR UPDATE;
		IF v_user.attempts + 1 > p_user_limit THEN
			v_wait := greatest(v_wait, greatest(1, ceil(extract(epoch FROM v_user.window_start + interval '1 hour' - now())))::integer);
		END IF;
		IF v_project.attempts + 1 > p_project_limit THEN
			v_wait := greatest(v_wait, greatest(1, ceil(extract(epoch FROM v_project.window_start + interval '1 hour' - now())))::integer);
		END IF;
		IF v_wait > 0 THEN
			RETURN v_wait;
		END IF;
		UPDATE map_compute_throttle SET attempts = attempts + 1 WHERE bucket IN (v_user_bucket, v_project_bucket);
		RETURN 0;
	END
	$$;

REVOKE ALL ON FUNCTION app_map_compute_attempt(uuid, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_map_compute_attempt(uuid, text, integer, integer) TO water_app;
