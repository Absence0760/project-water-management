-- 200_irrigation_system_seed_invoker — irrigation_system_seed (198) runs with
-- its caller's rights, not the owner's.
--
-- 198 made it SECURITY DEFINER, and new functions are executable by water_app,
-- so a signed-in session could seed six rows into a project it has no role on,
-- past irrigation_system_insert. Its only callers are the project insert
-- trigger (project_seed_irrigation_systems, itself SECURITY DEFINER, so the
-- seed still runs as the owner there) and 198's backfill (run as the owner).
-- As SECURITY INVOKER, a direct call from water_app is bound by RLS; and
-- water_app loses EXECUTE, since nothing in the app calls it.

ALTER FUNCTION irrigation_system_seed(uuid) SECURITY INVOKER;
REVOKE EXECUTE ON FUNCTION irrigation_system_seed(uuid) FROM water_app, PUBLIC;
