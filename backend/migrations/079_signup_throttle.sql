-- 079_signup_throttle — slow sign-up down, per client address and in all
-- (docs/security.md § Password reset, email verification and invites).
--
-- POST /auth/register answers 409 for a taken address (sign-up is not
-- email-first), so it can tell whether an address has an account. The WAF's
-- per-IP rule allows 100 /api/auth/* requests per 5 minutes; this makes an
-- enumeration or an account-spam run far slower than that: a fixed window per
-- client address (auth/signupThrottle.ts: 10 an hour) and one ceiling for
-- every sign-up together (500 an hour), both well above real use. It lives in
-- Postgres because Lambda instances share nothing.
--
-- Every attempt that passes validation counts, before the address is looked
-- at, so a taken and a free address are answered alike once throttled. A
-- refused attempt doesn't count, so hammering never extends the wait.
--
-- The bucket is 'global', or 'client:' and a SHA-256 of the client address
-- (the app never stores the address itself). Rows are deleted once their
-- window is over (at the next sign-up), so nothing here outlives an hour or so.

CREATE TABLE signup_throttle (
	bucket       text PRIMARY KEY CHECK (bucket = 'global' OR bucket ~ '^client:[0-9a-f]{64}$'),
	window_start timestamptz NOT NULL DEFAULT now(),
	attempts     integer NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);
-- Housekeeping deletes rows by age.
CREATE INDEX signup_throttle_window_idx ON signup_throttle (window_start);

-- Only the SECURITY DEFINER function below touches it; the deny-all policy
-- keeps direct access closed (the login_throttle pattern, 005).
ALTER TABLE signup_throttle ENABLE ROW LEVEL SECURITY;
CREATE POLICY signup_throttle_none ON signup_throttle USING (false) WITH CHECK (false);
GRANT SELECT, INSERT, UPDATE, DELETE ON signup_throttle TO water_app;

-- Count one sign-up attempt from p_client (a 'client:<sha256>' bucket).
-- Returns 0 to go ahead (the attempt is counted in both buckets), or the
-- seconds until the fuller bucket's window ends (nothing counted). A window
-- starts at a bucket's first attempt and lasts p_window.
CREATE FUNCTION app_signup_attempt(p_client text, p_client_limit integer, p_global_limit integer, p_window interval) RETURNS integer
	LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_global signup_throttle;
		v_client signup_throttle;
		v_wait integer := 0;
	BEGIN
		IF p_client IS NULL OR p_client !~ '^client:[0-9a-f]{64}$' THEN
			RAISE EXCEPTION 'app_signup_attempt: bad client bucket';
		END IF;
		-- Housekeeping, and the end of a client's window: its row goes.
		DELETE FROM signup_throttle WHERE window_start <= now() - p_window AND bucket <> 'global';
		INSERT INTO signup_throttle (bucket) VALUES ('global'), (p_client) ON CONFLICT (bucket) DO NOTHING;
		-- Row locks, always global first: concurrent sign-ups are counted one by one.
		SELECT * INTO v_global FROM signup_throttle WHERE bucket = 'global' FOR UPDATE;
		SELECT * INTO v_client FROM signup_throttle WHERE bucket = p_client FOR UPDATE;
		-- A window that is over starts again (a client's row was deleted and
		-- recreated above; the global row is kept and reset).
		IF v_global.window_start <= now() - p_window THEN
			UPDATE signup_throttle SET window_start = now(), attempts = 0 WHERE bucket = 'global' RETURNING * INTO v_global;
		END IF;
		IF v_client.attempts >= p_client_limit THEN
			v_wait := greatest(v_wait, greatest(1, ceil(extract(epoch FROM v_client.window_start + p_window - now())))::integer);
		END IF;
		IF v_global.attempts >= p_global_limit THEN
			v_wait := greatest(v_wait, greatest(1, ceil(extract(epoch FROM v_global.window_start + p_window - now())))::integer);
		END IF;
		IF v_wait > 0 THEN
			RETURN v_wait;
		END IF;
		UPDATE signup_throttle SET attempts = attempts + 1 WHERE bucket IN ('global', p_client);
		RETURN 0;
	END
	$$;

REVOKE ALL ON FUNCTION app_signup_attempt(text, integer, integer, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_signup_attempt(text, integer, integer, interval) TO water_app;
