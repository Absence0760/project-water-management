-- 005_login_throttle — per-address sign-in lockout with exponential backoff.
--
-- Keyed by the email address typed into the sign-in form, NOT by account, so
-- an address with no account is throttled exactly like one that has one and
-- the lockout can't be used to discover accounts. The WAF's per-IP rate limit
-- stays the first line; this stops a slow, distributed guess at one account.
-- See docs/security.md § Authentication.

CREATE TABLE login_throttle (
	email           citext PRIMARY KEY CHECK (length(email) BETWEEN 1 AND 254),
	-- Attempts since the last successful sign-in (counted before the password
	-- check, so concurrent guesses can't all slip past the lock).
	failures        integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
	locked_until    timestamptz,
	last_attempt_at timestamptz NOT NULL DEFAULT now()
);
-- Housekeeping deletes rows by age.
CREATE INDEX login_throttle_last_attempt_idx ON login_throttle (last_attempt_at);

-- Sign-in happens before there is a user, so the app only touches this table
-- through the SECURITY DEFINER functions below. The deny-all policy keeps
-- direct access closed (and satisfies the catalogue rule that every RLS table
-- has a policy).
ALTER TABLE login_throttle ENABLE ROW LEVEL SECURITY;
CREATE POLICY login_throttle_none ON login_throttle USING (false) WITH CHECK (false);

-- Record a sign-in attempt for p_email, unless the address is locked.
-- Returns the seconds left on the lock (> 0: refuse without checking the
-- password), or 0 to go ahead. The attempt counts as a failure until
-- app_login_succeeded clears it. Reaching p_free attempts locks the address
-- for p_base, doubling with each further attempt, capped at p_max.
-- Counters reset after a day without attempts.
CREATE FUNCTION app_login_attempt(p_email citext, p_free integer, p_base interval, p_max interval) RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_failures integer;
		v_locked timestamptz;
	BEGIN
		DELETE FROM login_throttle WHERE last_attempt_at < now() - interval '1 day';
		INSERT INTO login_throttle (email) VALUES (p_email) ON CONFLICT (email) DO NOTHING;
		-- Row lock: concurrent attempts for one address are counted one by one.
		SELECT failures, locked_until INTO v_failures, v_locked FROM login_throttle WHERE email = p_email FOR UPDATE;
		IF v_locked IS NOT NULL AND v_locked > now() THEN
			RETURN greatest(1, ceil(extract(epoch FROM v_locked - now())))::integer;
		END IF;
		v_failures := v_failures + 1;
		UPDATE login_throttle SET
			failures = v_failures,
			last_attempt_at = now(),
			locked_until = CASE WHEN v_failures >= p_free
				THEN now() + least(p_base * power(2, least(v_failures - p_free, 20)), p_max)
				ELSE NULL END
		WHERE email = p_email;
		RETURN 0;
	END
	$$;

-- A correct password (or a password reset) clears the address's record.
CREATE FUNCTION app_login_succeeded(p_email citext) RETURNS void
	LANGUAGE sql SECURITY DEFINER SET search_path = public
	AS $$
		DELETE FROM login_throttle WHERE email = p_email
	$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON login_throttle TO water_app;
