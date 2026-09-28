-- 068_app_user_rls — row-level security on app_user (docs/security.md §
-- Accounts under RLS).
--
-- Until now app_user had no RLS (001: sign-in reads it before anyone is
-- signed in), so every water_app transaction, an API key's (withApiKey) and
-- the no-user one (withoutUser) included, could read every account's email
-- and password hash and UPDATE any account. Now:
--
--   1. SELECT: your own row, and the people you work with
--      (app_user_visible): anyone who is, or was, part of a project you can
--      open, and anyone in a team with you. "Was" is what keeps a removed
--      member's name on the runs, scenarios, jobs and ensembles they made
--      (those routes inner-join app_user, so an invisible maker would drop
--      the row itself). No user in the transaction (an API key, the job
--      tick, pre-sign-in) sees no account at all.
--   2. UPDATE: your own row only.
--   3. INSERT: no policy, so water_app can't insert; sign-up goes through
--      app_register. DELETE: revoked; deleting an account is the operator's
--      (as the schema owner, deployment.md § Runbooks item 7).
--   4. The paths that must find an account by address or id before anyone
--      is signed in go through narrow SECURITY DEFINER functions, each
--      returning one account's few columns, never a list:
--        app_register(email, name, hash, locale)  sign-up; the new id, or NULL when the address is taken
--        app_auth_account(email)                  sign-in and forgot-password: id, email, locale, password_hash
--        app_session_revoked_at(id)               every authenticated request: the session watermark
--        app_user_by_email(emails[])              adding a member by address (signed-in callers only; the routes check the role)
--      The token-proven flows (verify email, reset password) and a fresh
--      sign-up act as the account the token or insert proved (tx.ts
--      actAsUser) and go through the own-row policies like any request.
--
-- Every other function that reads app_user is already SECURITY DEFINER,
-- owned by the schema owner, so RLS doesn't change what it sees.

CREATE FUNCTION app_user_visible(p_user uuid) RETURNS boolean
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		me uuid := app_current_user_id();
	BEGIN
		IF me IS NULL OR p_user IS NULL THEN
			RETURN false;
		END IF;
		IF p_user = me THEN
			RETURN true;
		END IF;
		-- A fellow member of one of your teams.
		IF EXISTS (SELECT 1 FROM team_member a JOIN team_member b ON b.team_id = a.team_id WHERE a.user_id = me AND b.user_id = p_user) THEN
			RETURN true;
		END IF;
		RETURN EXISTS (
			WITH mine AS (
				SELECT m.project_id FROM project_member m WHERE m.user_id = me
				UNION
				SELECT p.id FROM project p JOIN team_member tm ON tm.team_id = p.team_id WHERE tm.user_id = me
			)
			-- Part of one of those projects now: a member, or in its team.
			SELECT 1 FROM project_member m JOIN mine USING (project_id) WHERE m.user_id = p_user
			UNION ALL SELECT 1 FROM project p JOIN mine ON mine.project_id = p.id JOIN team_member tm ON tm.team_id = p.team_id WHERE tm.user_id = p_user
			-- Or was: named in its audit log (every member.added / removed, every audited action),
			UNION ALL SELECT 1 FROM audit_event e JOIN mine USING (project_id) WHERE e.actor_user_id = p_user
			UNION ALL SELECT 1 FROM audit_event e JOIN mine USING (project_id) WHERE e.subject ? 'userId' AND e.subject->>'userId' = p_user::text
			-- or the maker of something the routes list with their name by an inner join.
			UNION ALL SELECT 1 FROM project p JOIN mine ON mine.project_id = p.id WHERE p.created_by = p_user
			UNION ALL SELECT 1 FROM model_run r JOIN mine USING (project_id) WHERE r.created_by = p_user
			UNION ALL SELECT 1 FROM run_uncertainty u JOIN mine USING (project_id) WHERE u.created_by = p_user
			UNION ALL SELECT 1 FROM scenario s JOIN mine USING (project_id) WHERE s.owner_user_id = p_user
			UNION ALL SELECT 1 FROM scenario_member s JOIN mine USING (project_id) WHERE s.user_id = p_user
			UNION ALL SELECT 1 FROM job j JOIN mine USING (project_id) WHERE j.acting_user_id = p_user
			UNION ALL SELECT 1 FROM project_import i JOIN mine USING (project_id) WHERE i.imported_by = p_user
			UNION ALL SELECT 1 FROM invite i WHERE i.invited_by = p_user AND (
				i.project_id IN (SELECT project_id FROM mine)
				OR i.team_id IN (SELECT team_id FROM team_member WHERE user_id = me))
		);
	END
	$$;

ALTER TABLE app_user ENABLE ROW LEVEL SECURITY;

CREATE POLICY app_user_select ON app_user FOR SELECT
	USING (id = app_current_user_id() OR app_user_visible(id));
CREATE POLICY app_user_update ON app_user FOR UPDATE
	USING (id = app_current_user_id())
	WITH CHECK (id = app_current_user_id());

REVOKE DELETE ON app_user FROM water_app;

CREATE FUNCTION app_register(p_email citext, p_display_name text, p_password_hash text, p_locale text) RETURNS uuid
	LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
		INSERT INTO app_user (email, display_name, password_hash, locale) VALUES (p_email, p_display_name, p_password_hash, p_locale)
		ON CONFLICT (email) DO NOTHING RETURNING id
	$$;

CREATE FUNCTION app_auth_account(p_email citext)
	RETURNS TABLE (id uuid, email citext, locale text, password_hash text)
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT u.id, u.email, u.locale, u.password_hash FROM app_user u WHERE u.email = p_email
	$$;

CREATE FUNCTION app_session_revoked_at(p_user uuid) RETURNS TABLE (sessions_revoked_at timestamptz)
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT u.sessions_revoked_at FROM app_user u WHERE u.id = p_user
	$$;

CREATE FUNCTION app_user_by_email(p_emails citext[])
	RETURNS TABLE (id uuid, email citext, display_name text, verified boolean)
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT u.id, u.email, u.display_name, u.email_verified_at IS NOT NULL
		FROM app_user u
		WHERE app_current_user_id() IS NOT NULL AND u.email = ANY (p_emails)
	$$;

REVOKE ALL ON FUNCTION app_user_visible(uuid), app_register(citext, text, text, text), app_auth_account(citext),
	app_session_revoked_at(uuid), app_user_by_email(citext[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_user_visible(uuid), app_register(citext, text, text, text), app_auth_account(citext),
	app_session_revoked_at(uuid), app_user_by_email(citext[]) TO water_app;
