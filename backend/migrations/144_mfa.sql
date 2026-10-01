-- 144_mfa — two-step sign-in: TOTP (RFC 6238) with recovery codes (issue
-- #282; docs/security.md § Two-step sign-in, docs/data-model.md § Accounts).
--
-- One phished password could publish a restriction to a catchment's farmers
-- or decide a licence application. Now an account can add an authenticator
-- app; once it has, signing in needs a code from it (or a recovery code)
-- after the password, and the session records that it did (the JWT's `amr`,
-- auth/session.ts). Project owners, team admins and assessors must have one
-- before the actions those roles exist for (auth/stepUp.ts).
--
-- The secret is sealed by the backend (AES-256-GCM under APP_ENCRYPTION_KEY,
-- auth/secretBox.ts) before it gets here, bound to its account, so this table
-- never holds a usable seed and a row copied to another account won't open.
-- Recovery codes are stored as SHA-256 (they are high-entropy random codes)
-- and each is deleted when used.
--
-- Every table here is the account's own: RLS shows a person only their own
-- rows, and nobody else's, whatever their role. The code throttle is
-- reachable only through its SECURITY DEFINER functions, like login_throttle
-- (005), so a person can't clear their own count. All go with the account
-- (ON DELETE CASCADE).

-- ---------------------------------------------------------------------------
-- The authenticator
-- ---------------------------------------------------------------------------
CREATE TABLE user_totp (
	user_id        uuid PRIMARY KEY REFERENCES app_user (id) ON DELETE CASCADE,
	-- secretBox.ts's sealed form: version · IV · tag · ciphertext of 20 bytes.
	secret_enc     bytea NOT NULL CHECK (octet_length(secret_enc) BETWEEN 30 AND 200),
	-- Null while enrolment waits for its first code (POST /auth/mfa/totp/confirm):
	-- an unconfirmed secret signs nobody in and requires nothing.
	confirmed_at   timestamptz,
	-- The last time step a code was accepted for: a code from it or an earlier
	-- step is refused, so a code can't be replayed (RFC 6238 § 5.2).
	last_used_step bigint CHECK (last_used_step >= 0),
	created_at     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE user_totp IS
	'A person''s authenticator app (144, issue #282): the sealed TOTP secret. Own row only, for every command.';

ALTER TABLE user_totp ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_totp_own ON user_totp FOR ALL
	USING (user_id = app_current_user_id())
	WITH CHECK (user_id = app_current_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON user_totp TO water_app;

-- ---------------------------------------------------------------------------
-- Recovery codes: ten, each good once
-- ---------------------------------------------------------------------------
CREATE TABLE user_recovery_code (
	user_id    uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
	code_hash  bytea NOT NULL CHECK (octet_length(code_hash) = 32),
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (user_id, code_hash)
);
COMMENT ON TABLE user_recovery_code IS
	'A person''s unused recovery codes (144), as SHA-256. Deleted when used or replaced. Own rows only.';

ALTER TABLE user_recovery_code ENABLE ROW LEVEL SECURITY;
-- No UPDATE: a code is issued, then used (deleted) or replaced (deleted).
CREATE POLICY user_recovery_code_own_select ON user_recovery_code FOR SELECT USING (user_id = app_current_user_id());
CREATE POLICY user_recovery_code_own_insert ON user_recovery_code FOR INSERT WITH CHECK (user_id = app_current_user_id());
CREATE POLICY user_recovery_code_own_delete ON user_recovery_code FOR DELETE USING (user_id = app_current_user_id());
GRANT SELECT, INSERT, DELETE ON user_recovery_code TO water_app;

-- ---------------------------------------------------------------------------
-- The code throttle: 5 wrong codes lock the account's code checks
-- ---------------------------------------------------------------------------
-- Keyed by the account (the password already proved which one), counted
-- before the code is checked, under a row lock, like login_throttle (005).
-- Every code check counts here: the sign-in step, confirming an enrolment,
-- turning two-step sign-in off and replacing the recovery codes, so a
-- stolen session can't guess codes any faster than the sign-in page.
CREATE TABLE mfa_throttle (
	user_id         uuid PRIMARY KEY REFERENCES app_user (id) ON DELETE CASCADE,
	failures        integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
	locked_until    timestamptz,
	last_attempt_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mfa_throttle_last_attempt_idx ON mfa_throttle (last_attempt_at);

ALTER TABLE mfa_throttle ENABLE ROW LEVEL SECURITY;
CREATE POLICY mfa_throttle_none ON mfa_throttle USING (false) WITH CHECK (false);
GRANT SELECT, INSERT, UPDATE, DELETE ON mfa_throttle TO water_app;

-- One code check for the current user, unless locked: the seconds left on
-- the lock (> 0: refuse without checking), or 0 to go ahead. Counts as a
-- failure until app_mfa_succeeded clears it. The p_free-th failure in a row
-- locks for p_base, doubling with each further attempt, capped at p_max; a
-- day without attempts forgets it. Refused without a user.
CREATE FUNCTION app_mfa_attempt(p_free integer, p_base interval, p_max interval) RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
		v_failures integer;
		v_locked timestamptz;
	BEGIN
		IF uid IS NULL THEN
			RAISE EXCEPTION 'app_mfa_attempt: not allowed' USING ERRCODE = '42501';
		END IF;
		DELETE FROM mfa_throttle WHERE last_attempt_at < now() - interval '1 day';
		INSERT INTO mfa_throttle (user_id) VALUES (uid) ON CONFLICT (user_id) DO NOTHING;
		SELECT failures, locked_until INTO v_failures, v_locked FROM mfa_throttle WHERE user_id = uid FOR UPDATE;
		IF v_locked IS NOT NULL AND v_locked > now() THEN
			RETURN greatest(1, ceil(extract(epoch FROM v_locked - now())))::integer;
		END IF;
		v_failures := v_failures + 1;
		UPDATE mfa_throttle SET
			failures = v_failures,
			last_attempt_at = now(),
			locked_until = CASE WHEN v_failures >= p_free
				THEN now() + least(p_base * power(2, least(v_failures - p_free, 20)), p_max)
				ELSE NULL END
		WHERE user_id = uid;
		RETURN 0;
	END
	$$;

-- A right code clears the current user's count.
CREATE FUNCTION app_mfa_succeeded() RETURNS void
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF app_current_user_id() IS NULL THEN
			RAISE EXCEPTION 'app_mfa_succeeded: not allowed' USING ERRCODE = '42501';
		END IF;
		DELETE FROM mfa_throttle WHERE user_id = app_current_user_id();
	END
	$$;

REVOKE ALL ON FUNCTION app_mfa_attempt(integer, interval, interval), app_mfa_succeeded() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_mfa_attempt(integer, interval, interval), app_mfa_succeeded() TO water_app;

-- ---------------------------------------------------------------------------
-- The account's own security log
-- ---------------------------------------------------------------------------
-- audit_event is a project's log (030, project_id NOT NULL); these events
-- belong to no project. Append-only: a person reads and adds their own,
-- never changes or removes one (a thief who turned the factor off can't
-- erase that they did). In the data-subject export (securityEvents).
CREATE TABLE account_security_event (
	id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	user_id    uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
	kind       text NOT NULL CHECK (kind IN (
		'mfa.enrolled',             -- an authenticator added (first code confirmed)
		'mfa.disabled',             -- two-step sign-in turned off
		'mfa.recovery_used',        -- a recovery code signed in
		'mfa.recovery_regenerated'  -- a new set of recovery codes replaced the old
	)),
	created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_security_event_user_idx ON account_security_event (user_id, created_at DESC);
COMMENT ON TABLE account_security_event IS
	'A person''s own sign-in security events (144): two-step sign-in added, turned off, a recovery code used. Append-only, own rows only.';

ALTER TABLE account_security_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY account_security_event_own_select ON account_security_event FOR SELECT USING (user_id = app_current_user_id());
CREATE POLICY account_security_event_own_insert ON account_security_event FOR INSERT WITH CHECK (user_id = app_current_user_id());
GRANT SELECT, INSERT ON account_security_event TO water_app;
