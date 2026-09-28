-- 101_invite_throttle — a daily cap on adding people by email (issue #51,
-- adversary finding 3; docs/security.md § Password reset, email
-- verification and invites).
--
-- Any signed-in user can create a project and so own one, and adding a
-- member or a farmer by email (POST /projects/:id/members, /farmers,
-- /farmers/bulk, POST /teams/:id/members) answered without a limit: a verified
-- account was added and an unknown address invited, so the answers told
-- which addresses have accounts, and every invite mailed the inviter's text
-- (the project's name) to an address they chose. This caps both: every
-- address an add names counts, before it is looked up, per inviting user
-- and per project or team, in a fixed 24-hour window
-- (invites/invites.ts INVITE_CAP). A refused add counts nothing, so
-- hammering never extends the wait. A dry run of the bulk add counts too:
-- its preview says which rows would be added and which invited.
--
-- The bucket is 'user:', 'project:' or 'team:' and the id. Rows are deleted
-- once their window is over (at the next add), so nothing here outlives a
-- day or so; a deleted account's row goes with its window.

CREATE TABLE invite_throttle (
	bucket       text PRIMARY KEY CHECK (bucket ~ '^(user|project|team):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
	window_start timestamptz NOT NULL DEFAULT now(),
	attempts     integer NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);
-- Housekeeping deletes rows by age.
CREATE INDEX invite_throttle_window_idx ON invite_throttle (window_start);

-- Only the SECURITY DEFINER function below touches it; the deny-all policy
-- keeps direct access closed (the signup_throttle pattern, 079).
ALTER TABLE invite_throttle ENABLE ROW LEVEL SECURITY;
CREATE POLICY invite_throttle_none ON invite_throttle USING (false) WITH CHECK (false);
GRANT SELECT, INSERT, UPDATE, DELETE ON invite_throttle TO water_app;

-- Count p_count addresses added by the signed-in user to a project
-- (p_kind 'project', as its owner) or a team ('team', as its admin).
-- Returns 0 to go ahead (counted in both buckets), or the seconds until the
-- fuller bucket's window ends (nothing counted). Anyone else, or no user, is
-- refused with an error: the route has checked the role already, so this
-- only stops a caller from using up another project's allowance.
CREATE FUNCTION app_invite_attempt(p_kind text, p_target uuid, p_count integer, p_user_limit integer, p_target_limit integer, p_window interval)
	RETURNS integer
	LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_user_bucket text := 'user:' || app_current_user_id()::text;
		v_target_bucket text := p_kind || ':' || p_target::text;
		v_user invite_throttle;
		v_target invite_throttle;
		v_wait integer := 0;
		v_allowed boolean := false;
	BEGIN
		IF p_kind = 'project' THEN
			v_allowed := coalesce(app_has_role(p_target, 'owner'), false);
		ELSIF p_kind = 'team' THEN
			v_allowed := coalesce(app_team_role(p_target) = 'admin', false);
		END IF;
		IF app_current_user_id() IS NULL OR p_target IS NULL OR p_count IS NULL OR p_count < 1 OR NOT v_allowed THEN
			RAISE EXCEPTION 'app_invite_attempt: not allowed' USING ERRCODE = '42501';
		END IF;
		-- Housekeeping, and the end of a window: its row goes.
		DELETE FROM invite_throttle WHERE window_start <= now() - p_window;
		INSERT INTO invite_throttle (bucket) VALUES (v_user_bucket), (v_target_bucket) ON CONFLICT (bucket) DO NOTHING;
		-- Row locks, always the user's first: concurrent adds are counted one by one.
		SELECT * INTO v_user FROM invite_throttle WHERE bucket = v_user_bucket FOR UPDATE;
		SELECT * INTO v_target FROM invite_throttle WHERE bucket = v_target_bucket FOR UPDATE;
		IF v_user.attempts + p_count > p_user_limit THEN
			v_wait := greatest(v_wait, greatest(1, ceil(extract(epoch FROM v_user.window_start + p_window - now())))::integer);
		END IF;
		IF v_target.attempts + p_count > p_target_limit THEN
			v_wait := greatest(v_wait, greatest(1, ceil(extract(epoch FROM v_target.window_start + p_window - now())))::integer);
		END IF;
		IF v_wait > 0 THEN
			RETURN v_wait;
		END IF;
		UPDATE invite_throttle SET attempts = attempts + p_count WHERE bucket IN (v_user_bucket, v_target_bucket);
		RETURN 0;
	END
	$$;

REVOKE ALL ON FUNCTION app_invite_attempt(text, uuid, integer, integer, integer, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_invite_attempt(text, uuid, integer, integer, integer, interval) TO water_app;
