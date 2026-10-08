-- 206_mfa_email_code — an emailed one-time code as a second factor, beside
-- or instead of the authenticator app (operator decision, 2026-10-08;
-- docs/security.md § Two-step sign-in → Code by email, docs/data-model.md
-- § Two-step sign-in).
--
-- Hydrologists find authenticator apps hard. Now an account can turn on
-- "Email me a code": after the password, a 6-digit code sent to the account's
-- confirmed address. It is the weaker factor (whoever reads the inbox can also
-- reset the password), and the Account page says so; the app stays offered
-- first.
--
-- Three tables:
--   user_email_otp  the factor itself: the account's own row (RLS, every
--                   command), unconfirmed until the first emailed code comes
--                   back, like user_totp (150).
--   mfa_email_code  the one live code per account, as an HMAC-SHA256 under a
--                   key the database never sees (auth/emailCode.ts), with its
--                   purpose and expiry. Deny-all: written and used up only
--                   through app_mfa_email_send / app_mfa_email_use (SECURITY
--                   DEFINER, the current user only), so no caller can plant a
--                   code of its choosing or skip the send limits.
--   mfa_email_send  when codes were emailed, for the send limits (a minute
--                   between sends, a cap per hour): an email costs money and
--                   a stream of them is abuse. Deny-all, a day at most.
-- All go with the account (ON DELETE CASCADE).

-- ---------------------------------------------------------------------------
-- The factor
-- ---------------------------------------------------------------------------
CREATE TABLE user_email_otp (
	user_id      uuid PRIMARY KEY REFERENCES app_user (id) ON DELETE CASCADE,
	-- Null while enrolment waits for its first emailed code (POST /auth/mfa/email/confirm):
	-- an unconfirmed row signs nobody in and requires nothing.
	confirmed_at timestamptz,
	created_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE user_email_otp IS
	'A person''s emailed-code second factor (206): whether it is on. Own row only, for every command.';

ALTER TABLE user_email_otp ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_email_otp_own ON user_email_otp FOR ALL
	USING (user_id = app_current_user_id())
	WITH CHECK (user_id = app_current_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON user_email_otp TO water_app;

-- ---------------------------------------------------------------------------
-- The live code: one per account, replaced by every send, good once
-- ---------------------------------------------------------------------------
CREATE TABLE mfa_email_code (
	user_id    uuid PRIMARY KEY REFERENCES app_user (id) ON DELETE CASCADE,
	-- HMAC-SHA256 of the account, the purpose and the code (auth/emailCode.ts);
	-- null once used (the row stays as the send limit's lock).
	code_hash  bytea CHECK (octet_length(code_hash) = 32),
	-- 'enrol': confirms a pending factor; 'use': signs in, steps up, or
	-- confirms an action, with a confirmed factor.
	purpose    text CHECK (purpose IN ('enrol', 'use')),
	expires_at timestamptz,
	CHECK ((code_hash IS NULL) = (purpose IS NULL) AND (purpose IS NULL) = (expires_at IS NULL))
);
COMMENT ON TABLE mfa_email_code IS
	'The emailed second-factor code (206), as an HMAC: one per account, 10 minutes, good once. Only app_mfa_email_send and app_mfa_email_use touch it.';

ALTER TABLE mfa_email_code ENABLE ROW LEVEL SECURITY;
CREATE POLICY mfa_email_code_none ON mfa_email_code USING (false) WITH CHECK (false);
GRANT SELECT, INSERT, UPDATE, DELETE ON mfa_email_code TO water_app;

CREATE TABLE mfa_email_send (
	id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	user_id uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
	sent_at timestamptz NOT NULL DEFAULT now()
);
-- Covers the foreign key, and the per-account count.
CREATE INDEX mfa_email_send_user_idx ON mfa_email_send (user_id, sent_at);
-- The day-old prune.
CREATE INDEX mfa_email_send_sent_idx ON mfa_email_send (sent_at);
COMMENT ON TABLE mfa_email_send IS
	'When second-factor codes were emailed (206), for the send limits: a day at most. Only app_mfa_email_send touches it.';

ALTER TABLE mfa_email_send ENABLE ROW LEVEL SECURITY;
CREATE POLICY mfa_email_send_none ON mfa_email_send USING (false) WITH CHECK (false);
GRANT SELECT, INSERT, UPDATE, DELETE ON mfa_email_send TO water_app;

-- Store a new code for the current user, unless a send limit holds it back:
-- the seconds to wait (> 0: nothing stored, send nothing), or 0 (stored; the
-- caller emails it). Under the account's row lock, so parallel sends queue
-- and can't all pass the limit. Limits: p_gap between sends, and at most
-- p_per_hour in a rolling hour. The new code replaces any live one, whatever
-- its purpose. Refused without a user.
CREATE FUNCTION app_mfa_email_send(p_hash bytea, p_purpose text, p_ttl interval, p_gap interval, p_per_hour integer) RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
		v_last timestamptz;
		v_count integer;
		v_frees timestamptz;
	BEGIN
		IF uid IS NULL THEN
			RAISE EXCEPTION 'app_mfa_email_send: not allowed' USING ERRCODE = '42501';
		END IF;
		IF p_hash IS NULL OR octet_length(p_hash) <> 32 OR p_purpose IS NULL OR p_purpose NOT IN ('enrol', 'use')
			OR p_ttl IS NULL OR p_ttl <= interval '0' OR p_gap IS NULL OR p_per_hour IS NULL OR p_per_hour < 1 THEN
			RAISE EXCEPTION 'app_mfa_email_send: bad arguments' USING ERRCODE = '22023';
		END IF;
		DELETE FROM mfa_email_send WHERE sent_at < now() - interval '1 day';
		INSERT INTO mfa_email_code (user_id) VALUES (uid) ON CONFLICT (user_id) DO NOTHING;
		PERFORM 1 FROM mfa_email_code WHERE user_id = uid FOR UPDATE;
		SELECT max(sent_at) INTO v_last FROM mfa_email_send WHERE user_id = uid;
		IF v_last IS NOT NULL AND v_last + p_gap > now() THEN
			RETURN greatest(1, ceil(extract(epoch FROM v_last + p_gap - now())))::integer;
		END IF;
		SELECT count(*)::integer INTO v_count FROM mfa_email_send WHERE user_id = uid AND sent_at > now() - interval '1 hour';
		IF v_count >= p_per_hour THEN
			-- When enough of the hour's sends have aged out to leave room for one more.
			SELECT sent_at + interval '1 hour' INTO v_frees FROM mfa_email_send
				WHERE user_id = uid AND sent_at > now() - interval '1 hour'
				ORDER BY sent_at OFFSET (v_count - p_per_hour) LIMIT 1;
			RETURN greatest(1, ceil(extract(epoch FROM v_frees - now())))::integer;
		END IF;
		INSERT INTO mfa_email_send (user_id) VALUES (uid);
		UPDATE mfa_email_code SET code_hash = p_hash, purpose = p_purpose, expires_at = now() + p_ttl WHERE user_id = uid;
		RETURN 0;
	END
	$$;

-- Use up the current user's code if it is this one, for this purpose, and
-- not expired: true once, then false (the code is gone). A wrong code leaves
-- the live one in place; the code throttle (app_mfa_attempt, 150) counts
-- every check before this runs.
CREATE FUNCTION app_mfa_email_use(p_hash bytea, p_purpose text) RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
		v_found boolean;
	BEGIN
		IF uid IS NULL THEN
			RAISE EXCEPTION 'app_mfa_email_use: not allowed' USING ERRCODE = '42501';
		END IF;
		UPDATE mfa_email_code SET code_hash = NULL, purpose = NULL, expires_at = NULL
			WHERE user_id = uid AND code_hash = p_hash AND purpose = p_purpose AND expires_at > clock_timestamp()
			RETURNING true INTO v_found;
		RETURN coalesce(v_found, false);
	END
	$$;

-- Void the current user's live code, if any (the factor turned off).
CREATE FUNCTION app_mfa_email_void() RETURNS void
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF app_current_user_id() IS NULL THEN
			RAISE EXCEPTION 'app_mfa_email_void: not allowed' USING ERRCODE = '42501';
		END IF;
		UPDATE mfa_email_code SET code_hash = NULL, purpose = NULL, expires_at = NULL WHERE user_id = app_current_user_id();
	END
	$$;

REVOKE ALL ON FUNCTION app_mfa_email_send(bytea, text, interval, interval, integer), app_mfa_email_use(bytea, text), app_mfa_email_void() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_mfa_email_send(bytea, text, interval, interval, integer), app_mfa_email_use(bytea, text), app_mfa_email_void() TO water_app;

-- ---------------------------------------------------------------------------
-- The account's security log: the emailed code added and removed
-- ---------------------------------------------------------------------------
ALTER TABLE account_security_event DROP CONSTRAINT account_security_event_kind_check;
ALTER TABLE account_security_event ADD CONSTRAINT account_security_event_kind_check CHECK (kind IN (
	'mfa.enrolled',             -- an authenticator added (first code confirmed)
	'mfa.disabled',             -- the authenticator removed
	'mfa.recovery_used',        -- a recovery code signed in
	'mfa.recovery_regenerated', -- a new set of recovery codes replaced the old
	'mfa.email_enrolled',       -- emailed codes turned on (first code confirmed, 206)
	'mfa.email_disabled'        -- emailed codes turned off (206)
));
