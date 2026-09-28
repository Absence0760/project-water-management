-- 102_session_revocation — signing out ends that session on the server
-- (issue #51, adversary finding 4; docs/security.md § Sessions).
--
-- A session is a 7-day HS256 JWT in an HttpOnly cookie. POST /auth/logout
-- only cleared the cookie, so a copy of it (a shared computer, a proxy log,
-- malware) kept working for up to 7 days after its owner signed out. Only
-- "sign out everywhere", a password change and a reset (the
-- app_user.sessions_revoked_at watermark) ended sessions.
--
-- Every session now carries a random id (the JWT's `jti`, auth/session.ts).
-- POST /auth/logout records it here, and readSessionClaims refuses a token
-- whose id is recorded, in the same one statement that reads the watermark
-- (app_session_state). A row is kept until the token would have expired
-- anyway, then deleted at the next sign-out.
--
-- Only the SECURITY DEFINER functions below touch the table; the deny-all
-- policy keeps direct access closed (the signup_throttle pattern, 079).
-- app_session_state runs before any user is known (every authenticated
-- request); app_revoke_session records only a session of the signed-in user.

-- Keyed by the account and the id together: a session id recorded by
-- another account (which would need that session's cookie) never blocks or
-- counts as its owner's sign-out. The key also covers the foreign key
-- (catalogue.db.test.ts).
CREATE TABLE revoked_session (
	user_id    uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
	jti        uuid NOT NULL,
	expires_at timestamptz NOT NULL,
	revoked_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (user_id, jti)
);
-- Housekeeping by age.
CREATE INDEX revoked_session_expires_idx ON revoked_session (expires_at);

ALTER TABLE revoked_session ENABLE ROW LEVEL SECURITY;
-- Deny-all, one policy per command it grants: no UPDATE policy, since a row
-- is write-once (catalogue.db.test.ts NO_UPDATE).
CREATE POLICY revoked_session_none_select ON revoked_session FOR SELECT USING (false);
CREATE POLICY revoked_session_none_insert ON revoked_session FOR INSERT WITH CHECK (false);
CREATE POLICY revoked_session_none_delete ON revoked_session FOR DELETE USING (false);
-- No UPDATE: a row is only ever inserted or aged out, and revoked_at
-- records a one-way event (final-columns.security.db.test.ts).
GRANT SELECT, INSERT, DELETE ON revoked_session TO water_app;

-- The session check's one statement: the account's watermark (as
-- app_session_revoked_at, 068) and whether this session was signed out.
-- No row: the account doesn't exist.
CREATE FUNCTION app_session_state(p_user uuid, p_jti uuid) RETURNS TABLE (sessions_revoked_at timestamptz, revoked boolean)
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT u.sessions_revoked_at, EXISTS (SELECT 1 FROM revoked_session r WHERE r.user_id = u.id AND r.jti = p_jti)
		FROM app_user u WHERE u.id = p_user
	$$;

-- Sign out one session of the signed-in user: p_jti until p_expires (the
-- token's own expiry). Expired rows go first. Refused without a user.
CREATE FUNCTION app_revoke_session(p_jti uuid, p_expires timestamptz) RETURNS void
	LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF app_current_user_id() IS NULL OR p_jti IS NULL OR p_expires IS NULL THEN
			RAISE EXCEPTION 'app_revoke_session: not allowed' USING ERRCODE = '42501';
		END IF;
		DELETE FROM revoked_session WHERE expires_at <= now();
		INSERT INTO revoked_session (user_id, jti, expires_at) VALUES (app_current_user_id(), p_jti, p_expires)
			ON CONFLICT (user_id, jti) DO NOTHING;
	END
	$$;

REVOKE ALL ON FUNCTION app_session_state(uuid, uuid), app_revoke_session(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_session_state(uuid, uuid), app_revoke_session(uuid, timestamptz) TO water_app;
