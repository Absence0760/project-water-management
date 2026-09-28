-- 004_email — email verification, password reset, session revocation, and
-- invitations for people who don't have an account yet.
--
-- Tokens: the backend generates 32 random bytes, mails them base64url-encoded,
-- and stores only their SHA-256 hash here. A database read (backup, replica,
-- log of a query) therefore never yields a usable link. Tokens are
-- single-use: consuming one deletes it. See docs/security.md § "Email tokens".

-- ---------------------------------------------------------------------------
-- app_user additions
-- ---------------------------------------------------------------------------

-- NULL = the owner of this address has not proven they receive mail at it.
ALTER TABLE app_user ADD COLUMN email_verified_at timestamptz;
-- Session watermark: a session JWT issued before this instant is rejected
-- (backend/src/auth/session.ts). Set by a password reset.
ALTER TABLE app_user ADD COLUMN sessions_revoked_at timestamptz;

-- Accounts that predate verification are grandfathered as verified, so
-- existing users aren't nagged by the "verify your email" banner.
UPDATE app_user SET email_verified_at = created_at WHERE email_verified_at IS NULL;

-- ---------------------------------------------------------------------------
-- Email tokens (verify + reset) for existing accounts
-- ---------------------------------------------------------------------------

CREATE TYPE email_token_purpose AS ENUM ('verify', 'reset');

CREATE TABLE email_token (
	id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
	purpose    email_token_purpose NOT NULL,
	-- SHA-256 of the token that was mailed. Never the token itself.
	token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
	expires_at timestamptz NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);
-- Covers the FK and the per-user cooldown lookup.
CREATE INDEX email_token_user_idx ON email_token (user_id, purpose, created_at DESC);

-- Tokens are issued and consumed before anyone is signed in, so the app works
-- on them only through the SECURITY DEFINER functions below. The policies
-- limit direct access to the signed-in user's own rows (which the app doesn't
-- need, but a policy-less RLS table would be flagged by the catalogue tests).
ALTER TABLE email_token ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_token_select ON email_token FOR SELECT USING (user_id = app_current_user_id());
CREATE POLICY email_token_insert ON email_token FOR INSERT WITH CHECK (user_id = app_current_user_id());
CREATE POLICY email_token_update ON email_token FOR UPDATE
	USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());
CREATE POLICY email_token_delete ON email_token FOR DELETE USING (user_id = app_current_user_id());

-- Issue a token unless one of the same purpose was issued within p_cooldown
-- (per-address throttle that holds across Lambda instances, unlike an
-- in-memory limiter). Any older token of the same purpose is replaced, so only
-- the newest link works. Returns false when throttled (nothing is stored).
CREATE FUNCTION app_issue_email_token(
	p_user uuid, p_purpose email_token_purpose, p_hash bytea, p_ttl interval, p_cooldown interval
) RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		-- Serialise concurrent requests for the same user + purpose so two
		-- simultaneous calls can't both pass the cooldown check.
		PERFORM pg_advisory_xact_lock(hashtext(p_user::text || ':' || p_purpose::text));
		IF EXISTS (
			SELECT 1 FROM email_token
			WHERE user_id = p_user AND purpose = p_purpose AND created_at > now() - p_cooldown
		) THEN
			RETURN false;
		END IF;
		DELETE FROM email_token WHERE user_id = p_user AND purpose = p_purpose;
		INSERT INTO email_token (user_id, purpose, token_hash, expires_at)
		VALUES (p_user, p_purpose, p_hash, now() + p_ttl);
		RETURN true;
	END
	$$;

-- Consume a token: deletes it (single use) and returns its user, or NULL when
-- the token is unknown, already used, of another purpose, or expired.
CREATE FUNCTION app_consume_email_token(p_hash bytea, p_purpose email_token_purpose) RETURNS uuid
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_user uuid;
		v_expires timestamptz;
	BEGIN
		DELETE FROM email_token WHERE token_hash = p_hash AND purpose = p_purpose
			RETURNING user_id, expires_at INTO v_user, v_expires;
		-- Housekeeping: drop long-dead tokens so the table stays small.
		DELETE FROM email_token WHERE expires_at < now() - interval '7 days';
		IF v_user IS NULL OR v_expires <= now() THEN
			RETURN NULL;
		END IF;
		RETURN v_user;
	END
	$$;

-- ---------------------------------------------------------------------------
-- Invitations for addresses without an account
-- ---------------------------------------------------------------------------

CREATE TABLE invite (
	id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	email        citext NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
	-- Exactly one target: a project (with a project role) or a team (team role).
	project_id   uuid REFERENCES project(id) ON DELETE CASCADE,
	project_role project_role,
	team_id      uuid REFERENCES team(id) ON DELETE CASCADE,
	team_role    team_role,
	invited_by   uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
	token_hash   bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
	expires_at   timestamptz NOT NULL,
	created_at   timestamptz NOT NULL DEFAULT now(),
	-- Last time the invite email went out; throttles re-sends.
	last_sent_at timestamptz NOT NULL DEFAULT now(),
	CHECK (
		(project_id IS NOT NULL AND project_role IS NOT NULL AND team_id IS NULL AND team_role IS NULL)
		OR (team_id IS NOT NULL AND team_role IS NOT NULL AND project_id IS NULL AND project_role IS NULL)
	)
);
-- One pending invite per address per project/team (re-inviting refreshes it).
-- Leading columns cover the project_id / team_id foreign keys.
CREATE UNIQUE INDEX invite_project_email_key ON invite (project_id, email) WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX invite_team_email_key ON invite (team_id, email) WHERE team_id IS NOT NULL;
CREATE INDEX invite_invited_by_idx ON invite (invited_by);
CREATE INDEX invite_email_idx ON invite (email);

-- Project owners see and manage their project's invites; team admins their
-- team's. Nobody else — in particular not the invitee, who has no account yet.
ALTER TABLE invite ENABLE ROW LEVEL SECURITY;
CREATE POLICY invite_select ON invite FOR SELECT USING (
	(project_id IS NOT NULL AND app_has_role(project_id, 'owner'))
	OR (team_id IS NOT NULL AND app_team_role(team_id) = 'admin')
);
CREATE POLICY invite_insert ON invite FOR INSERT WITH CHECK (
	invited_by = app_current_user_id() AND (
		(project_id IS NOT NULL AND app_has_role(project_id, 'owner'))
		OR (team_id IS NOT NULL AND app_team_role(team_id) = 'admin')
	)
);
CREATE POLICY invite_update ON invite FOR UPDATE
	USING (
		(project_id IS NOT NULL AND app_has_role(project_id, 'owner'))
		OR (team_id IS NOT NULL AND app_team_role(team_id) = 'admin')
	)
	WITH CHECK (
		invited_by = app_current_user_id() AND (
			(project_id IS NOT NULL AND app_has_role(project_id, 'owner'))
			OR (team_id IS NOT NULL AND app_team_role(team_id) = 'admin')
		)
	);
CREATE POLICY invite_delete ON invite FOR DELETE USING (
	(project_id IS NOT NULL AND app_has_role(project_id, 'owner'))
	OR (team_id IS NOT NULL AND app_team_role(team_id) = 'admin')
);

-- What an invite link points at, for the sign-up page ("Ann invited you to
-- …"). Only live (unexpired) invites; NULL row set otherwise.
CREATE FUNCTION app_invite_for_token(p_hash bytea)
	RETURNS TABLE (email citext, project_name text, team_name text, inviter_name text)
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT i.email, p.name, t.name, u.display_name
		FROM invite i
		JOIN app_user u ON u.id = i.invited_by
		LEFT JOIN project p ON p.id = i.project_id
		LEFT JOIN team t ON t.id = i.team_id
		WHERE i.token_hash = p_hash AND i.expires_at > now()
	$$;

-- Turn every live invite for the user's address into a membership, then drop
-- those invites. Only for a VERIFIED address: an unverified account proves
-- nothing about who reads that inbox, and converting on bare sign-up would
-- let anyone who registers an invitee's address first take their seat.
-- Returns the number of memberships created.
CREATE FUNCTION app_accept_invites(p_user uuid) RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_email citext;
		n_project integer;
		n_team integer;
	BEGIN
		SELECT email INTO v_email FROM app_user WHERE id = p_user AND email_verified_at IS NOT NULL;
		IF v_email IS NULL THEN
			RETURN 0;
		END IF;
		INSERT INTO project_member (project_id, user_id, role)
			SELECT project_id, p_user, project_role FROM invite
			WHERE email = v_email AND project_id IS NOT NULL AND expires_at > now()
			ON CONFLICT (project_id, user_id) DO NOTHING;
		GET DIAGNOSTICS n_project = ROW_COUNT;
		INSERT INTO team_member (team_id, user_id, role)
			SELECT team_id, p_user, team_role FROM invite
			WHERE email = v_email AND team_id IS NOT NULL AND expires_at > now()
			ON CONFLICT (team_id, user_id) DO NOTHING;
		GET DIAGNOSTICS n_team = ROW_COUNT;
		DELETE FROM invite WHERE email = v_email AND expires_at > now();
		RETURN n_project + n_team;
	END
	$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON email_token, invite TO water_app;
