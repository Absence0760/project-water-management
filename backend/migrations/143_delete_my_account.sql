-- 143_delete_my_account — a person deletes their own account (issue #112;
-- DELETE /auth/me, auth/deleteAccount.ts; docs/security.md § Personal
-- information (POPIA), "Deletion").
--
-- Until now only the operator could delete an account, as the schema owner
-- (water_app has no DELETE on app_user, 068). What a deletion does is all in
-- the database already: the foreign keys (cascade or set null, classified in
-- catalogue.db.test.ts APP_USER_ON_DELETE), app_user_pseudonymise (048,
-- latest 138) before the row goes, and the deferred project_member_keep_owner
-- and team_member_keep_admin triggers that refuse the only owner of a project
-- or the only admin of a team. Self-service runs exactly that, so the two
-- paths can't drift.
--
-- app_delete_my_account(): SECURITY DEFINER, with **no user argument**: it
-- deletes the row of the transaction's signed-in user (app_current_user_id(),
-- set by withUser) and nobody else's, as app_subject_export (054) reads only
-- the caller's own rows. Returns whether a row went. Refuses a transaction
-- with no user (an API key, the job queue, a pre-sign-in lookup).
--
-- The route checks the password again first, answers 409 with the projects
-- and teams the person is the only owner or admin of (read as them, under
-- RLS), and records the audit events while the person is still a member.
-- It then runs SET CONSTRAINTS ALL IMMEDIATE, so the deferred owner and admin
-- checks fire inside the request rather than at COMMIT.
--
-- Grants: EXECUTE to water_app only (028_definer_grants). No table, policy or
-- grant on app_user changes: water_app still can't DELETE from it.
-- Expand-only.

CREATE FUNCTION app_delete_my_account() RETURNS boolean
	LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		me uuid := app_current_user_id();
	BEGIN
		IF me IS NULL THEN
			RAISE EXCEPTION 'only a signed-in person can delete their account' USING ERRCODE = 'insufficient_privilege';
		END IF;
		DELETE FROM app_user WHERE id = me;
		RETURN FOUND;
	END
	$$;
COMMENT ON FUNCTION app_delete_my_account() IS
	'Deletes the signed-in user''s own account (143, issue #112): the same foreign keys and triggers as the operator''s deletion. No user argument.';

REVOKE ALL ON FUNCTION app_delete_my_account() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_delete_my_account() TO water_app;
