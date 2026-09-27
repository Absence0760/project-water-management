-- 070_login_device_trust — a device that signed in to an address before keeps
-- its own sign-in lockout, so a stranger can't keep the owner out.
--
-- 005's lockout is keyed by the typed address alone. Anyone can lock it, and
-- one wrong guess each time a lock ends locks it again, so a script could keep
-- the owner out indefinitely (a password reset cleared the count, but the
-- script re-locked it within five guesses). Now a browser that proved it knows
-- the password for an address (a correct sign-in, a password reset, a sign-up
-- or a password change) holds a signed `wm_device` cookie for that address
-- (auth/device.ts). Its attempts count here, per (address, device), instead
-- of on the address's shared record: the same 5 free attempts, the same
-- doubling up to 15 minutes, but only that device's own guesses lock it.
-- Everyone else, an attacker included, is on the shared record as before.
-- The cookie's MAC covers the account's session watermark, so a reset,
-- a password change or "sign out everywhere" retires every older device.
-- See docs/security.md § Authentication.

CREATE TABLE login_device_throttle (
	email           citext NOT NULL CHECK (length(email) BETWEEN 1 AND 254),
	-- The cookie's random device id (16 bytes, base64url). Not a credential:
	-- the cookie is only honoured with its MAC, which is never stored.
	device          text NOT NULL CHECK (device ~ '^[A-Za-z0-9_-]{22}$'),
	failures        integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
	locked_until    timestamptz,
	last_attempt_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (email, device)
);
COMMENT ON TABLE login_device_throttle IS
	'Sign-in lockout per (address, trusted device) (070). SECURITY DEFINER access only; rows go after a day without attempts.';
-- Housekeeping deletes rows by age.
CREATE INDEX login_device_throttle_last_attempt_idx ON login_device_throttle (last_attempt_at);

-- As login_throttle: the app touches it only through the functions below.
ALTER TABLE login_device_throttle ENABLE ROW LEVEL SECURITY;
CREATE POLICY login_device_throttle_none ON login_device_throttle USING (false) WITH CHECK (false);

-- app_login_attempt (005) for one device of an address: records the attempt
-- unless that device is locked, and returns the seconds left on its lock, or
-- 0 to go ahead. A lock is never extended by attempts made during it.
CREATE FUNCTION app_login_device_attempt(p_email citext, p_device text, p_free integer, p_base interval, p_max interval) RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_failures integer;
		v_locked timestamptz;
	BEGIN
		DELETE FROM login_device_throttle WHERE last_attempt_at < now() - interval '1 day';
		INSERT INTO login_device_throttle (email, device) VALUES (p_email, p_device) ON CONFLICT (email, device) DO NOTHING;
		SELECT failures, locked_until INTO v_failures, v_locked
			FROM login_device_throttle WHERE email = p_email AND device = p_device FOR UPDATE;
		IF v_locked IS NOT NULL AND v_locked > now() THEN
			RETURN greatest(1, ceil(extract(epoch FROM v_locked - now())))::integer;
		END IF;
		v_failures := v_failures + 1;
		UPDATE login_device_throttle SET
			failures = v_failures,
			last_attempt_at = now(),
			locked_until = CASE WHEN v_failures >= p_free
				THEN now() + least(p_base * power(2, least(v_failures - p_free, 20)), p_max)
				ELSE NULL END
		WHERE email = p_email AND device = p_device;
		RETURN 0;
	END
	$$;

-- A correct password on a trusted device clears that device's count only:
-- the shared record, which strangers fill, stays as it is.
CREATE FUNCTION app_login_device_succeeded(p_email citext, p_device text) RETURNS void
	LANGUAGE sql SECURITY DEFINER SET search_path = public
	AS $$
		DELETE FROM login_device_throttle WHERE email = p_email AND device = p_device
	$$;

-- From 005: a correct password on the shared record, a password reset or a
-- password change clears the address's record, and now its devices' too.
CREATE OR REPLACE FUNCTION app_login_succeeded(p_email citext) RETURNS void
	LANGUAGE sql SECURITY DEFINER SET search_path = public
	AS $$
		DELETE FROM login_throttle WHERE email = p_email;
		DELETE FROM login_device_throttle WHERE email = p_email;
	$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON login_device_throttle TO water_app;
