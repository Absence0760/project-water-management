-- 028_definer_grants — close the older SECURITY DEFINER functions to PUBLIC
-- (issue #37; docs/security.md § Authorization, docs/data-model.md
-- § Row-level security).
--
-- A SECURITY DEFINER function runs with its owner's (`water`) rights, and
-- Postgres grants EXECUTE on every new function to PUBLIC. 016, 018 and 023
-- revoked that for their functions; the others, from 001–026, kept it, so
-- any role that can connect could call them as the owner. This migration:
--
--   1. revokes EXECUTE from PUBLIC on every SECURITY DEFINER function in the
--      schema. It walks pg_proc rather than naming them, so it also closes the
--      ones from a migration numbered below 028 that ran first on a fresh
--      database (025's app_share_view / app_share_series did: step 3's
--      default privileges only cover functions created after it);
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

-- 1 + 2.
DO $$
DECLARE
	f record;
BEGIN
	FOR f IN
		SELECT p.oid::regprocedure AS sig, p.prorettype = 'trigger'::regtype AS is_trigger
		FROM pg_proc p
		JOIN pg_namespace n ON n.oid = p.pronamespace
		WHERE n.nspname = 'public' AND p.prosecdef
	LOOP
		EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
		IF NOT f.is_trigger THEN
			EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO water_app', f.sig);
		END IF;
	END LOOP;
END
$$;

-- 3. Future functions: owner + water_app, never PUBLIC. Applies to the role
-- running the migrations (the schema owner, `water`), in this database.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO water_app;
