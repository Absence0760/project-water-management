-- 027_definer_grants — close the older SECURITY DEFINER functions to PUBLIC
-- (issue #37; docs/security.md § Authorization, docs/data-model.md
-- § Row-level security).
--
-- A SECURITY DEFINER function runs with its owner's (`water`) rights, and
-- Postgres grants EXECUTE on every new function to PUBLIC. 016, 018 and 023
-- revoked that for their functions; the ones below, from 001–024, kept it, so
-- any role that can connect could call them as the owner. This migration:
--
--   1. revokes EXECUTE from PUBLIC on every SECURITY DEFINER function that
--      still had it (enumerated from pg_proc on a freshly migrated database);
--   2. grants EXECUTE to water_app on the non-trigger ones. water_app calls
--      them from the routes and from RLS policy expressions, which run with
--      the querying role's privileges. The owner keeps EXECUTE as owner.
--      Trigger functions get no grant: Postgres checks EXECUTE on a trigger
--      function only at CREATE TRIGGER (done by the owner), never when it
--      fires, and a trigger function can't be called directly anyway;
--   3. changes the owner's default privileges so a function it creates later
--      is executable by the owner and water_app only, never PUBLIC. That is
--      the global form (no IN SCHEMA): per-schema default privileges can only
--      add to the global ones, not take PUBLIC away. The catalogue guard in
--      backend/src/db/catalogue.db.test.ts is the enforcement; this is the
--      safety net behind it.
--
-- Non-SECURITY DEFINER functions keep their PUBLIC grant: they run with the
-- caller's rights, so EXECUTE grants nothing new.

-- 1 + 2. Functions water_app calls.
REVOKE ALL ON FUNCTION
	app_project_role(uuid),
	app_has_role(uuid, project_role),
	app_team_role(uuid),
	app_accept_invites(uuid),
	app_invite_for_token(bytea),
	app_issue_email_token(uuid, email_token_purpose, bytea, interval, interval),
	app_consume_email_token(bytea, email_token_purpose),
	app_login_attempt(citext, integer, interval, interval),
	app_login_succeeded(citext),
	app_farm_nodes(uuid),
	app_farm_context(uuid, uuid),
	app_farm_access(uuid, uuid),
	app_other_farm_holders(uuid),
	model_run_cited(uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
	app_project_role(uuid),
	app_has_role(uuid, project_role),
	app_team_role(uuid),
	app_accept_invites(uuid),
	app_invite_for_token(bytea),
	app_issue_email_token(uuid, email_token_purpose, bytea, interval, interval),
	app_consume_email_token(bytea, email_token_purpose),
	app_login_attempt(citext, integer, interval, interval),
	app_login_succeeded(citext),
	app_farm_nodes(uuid),
	app_farm_context(uuid, uuid),
	app_farm_access(uuid, uuid),
	app_other_farm_holders(uuid),
	model_run_cited(uuid)
TO water_app;

-- 1. Trigger functions: PUBLIC revoked, nothing granted.
REVOKE ALL ON FUNCTION
	project_add_creator_as_owner(),
	project_member_keep_owner(),
	team_add_creator_as_admin(),
	team_member_keep_admin(),
	run_nomination_stamp(),
	run_uncertainty_start(),
	farm_link_check(),
	node_unlink_farmers(),
	series_blob_gc(),
	assert_same_project(),
	run_publication_cap(),
	scenario_guard(),
	model_run_scenario_same_project(),
	model_run_pin_limit(),
	run_series_nodes_in_run()
FROM PUBLIC;

-- 3. Future functions: owner + water_app, never PUBLIC. Applies to the role
-- running the migrations (the schema owner, `water`), in this database.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO water_app;
