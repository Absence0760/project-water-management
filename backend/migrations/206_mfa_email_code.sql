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
--
-- And the factor joins 205's one test and two removals (mfa_has_factor,
-- mfa_remove_factors, mfa_remove_factor), replaced below, so a confirmed
-- emailed code counts everywhere an authenticator does, and every removal (a
-- completed reset, a team admin's, the operator's, the owner's) takes it too.

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

REVOKE ALL ON FUNCTION app_mfa_email_send(bytea, text, interval, interval, integer), app_mfa_email_use(bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_mfa_email_send(bytea, text, interval, interval, integer), app_mfa_email_use(bytea, text) TO water_app;

-- ---------------------------------------------------------------------------
-- 205's one test and two removals learn the emailed code
-- ---------------------------------------------------------------------------
-- Same signatures, privileges and comments' meaning as 205 (CREATE OR REPLACE
-- keeps the grants: mfa_has_factor to water_app, the removals to nobody).
CREATE OR REPLACE FUNCTION mfa_has_factor(p_user uuid) RETURNS boolean
	LANGUAGE sql STABLE SET search_path = public
	AS $$
		SELECT EXISTS (SELECT 1 FROM user_totp WHERE user_id = p_user AND confirmed_at IS NOT NULL)
			OR EXISTS (SELECT 1 FROM user_email_otp WHERE user_id = p_user AND confirmed_at IS NOT NULL)
	$$;

-- The emailed factor goes, and with it the live code (a code already sent
-- can't sign in once the factor is off). The send log stays: it is the send
-- limit, and a removal mustn't reset it.
CREATE OR REPLACE FUNCTION mfa_remove_factors(p_user uuid, p_watermark timestamptz) RETURNS void
	LANGUAGE plpgsql SET search_path = public
	AS $$
	DECLARE
		v_ended integer;
	BEGIN
		IF p_watermark IS NULL THEN
			RAISE EXCEPTION 'mfa_remove_factors: a watermark is required' USING ERRCODE = '22023';
		END IF;
		DELETE FROM user_recovery_code WHERE user_id = p_user;
		DELETE FROM user_totp WHERE user_id = p_user;
		DELETE FROM user_email_otp WHERE user_id = p_user;
		UPDATE mfa_email_code SET code_hash = NULL, purpose = NULL, expires_at = NULL WHERE user_id = p_user;
		DELETE FROM mfa_reset_cancel c USING mfa_reset r WHERE c.reset_id = r.id AND r.user_id = p_user AND r.ended_at IS NULL;
		UPDATE mfa_reset SET ended_at = now(), end_reason = 'factor_removed', confirm_hash = NULL
		WHERE user_id = p_user AND ended_at IS NULL;
		GET DIAGNOSTICS v_ended = ROW_COUNT;
		IF v_ended > 0 THEN
			INSERT INTO account_security_event (user_id, kind) VALUES (p_user, 'mfa.reset_cancelled');
		END IF;
		UPDATE app_user SET sessions_revoked_at = p_watermark WHERE id = p_user;
	END
	$$;

CREATE OR REPLACE FUNCTION mfa_remove_factor(p_user uuid, p_method text, p_watermark timestamptz) RETURNS boolean
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF p_watermark IS NULL THEN
			RAISE EXCEPTION 'mfa_remove_factor: a watermark is required' USING ERRCODE = '22023';
		END IF;
		IF p_method = 'totp' THEN
			DELETE FROM user_totp WHERE user_id = p_user;
		ELSIF p_method = 'email' THEN
			DELETE FROM user_email_otp WHERE user_id = p_user;
			UPDATE mfa_email_code SET code_hash = NULL, purpose = NULL, expires_at = NULL WHERE user_id = p_user;
		ELSE
			RAISE EXCEPTION 'mfa_remove_factor: unknown factor %', p_method USING ERRCODE = '22023';
		END IF;
		IF NOT mfa_has_factor(p_user) THEN
			PERFORM mfa_remove_factors(p_user, p_watermark);
			RETURN false;
		END IF;
		UPDATE app_user SET sessions_revoked_at = p_watermark WHERE id = p_user;
		RETURN true;
	END
	$$;

-- ---------------------------------------------------------------------------
-- The account's security log: the emailed code added and removed
-- ---------------------------------------------------------------------------
ALTER TABLE account_security_event DROP CONSTRAINT account_security_event_kind_check;
ALTER TABLE account_security_event ADD CONSTRAINT account_security_event_kind_check CHECK (kind IN (
	'mfa.enrolled',             -- an authenticator added (first code confirmed)
	'mfa.disabled',             -- the authenticator removed
	'mfa.recovery_used',        -- a recovery code signed in
	'mfa.recovery_regenerated', -- a new set of recovery codes replaced the old
	'mfa.reset_requested',      -- asked for a reset at the sign-in's code step (205)
	'mfa.reset_confirmed',      -- followed the link: the 3-day wait started (205)
	'mfa.reset_cancelled',      -- a wait ended without a reset (205)
	'mfa.reset_completed',      -- the wait ended: every second factor removed (205)
	'mfa.reset_by_admin',       -- a team admin removed every second factor (205)
	'mfa.reset_by_operator',    -- the operator removed them (205; deployment.md § Runbooks 14)
	'mfa.email_enrolled',       -- emailed codes turned on (first code confirmed, 206)
	'mfa.email_disabled'        -- emailed codes turned off (206)
));
