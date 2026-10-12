-- 230_authority_member_closed — close app_authority_member to water_app
-- (issue #523, round 5 review of 229).
--
-- 229 made app_authority_member(project, user) SECURITY DEFINER and left the
-- default EXECUTE grant (028) in place, saying it "answers only what
-- app_authority_members lists anyway". It didn't: app_authority_members
-- answers only a viewer or above of the project, while app_authority_member
-- checked no caller at all, so any signed-in account could ask whether a
-- given person is a confirmed delegate of a project it can't see.
--
-- Its only caller is app_acts_for_authority (229), itself SECURITY DEFINER
-- owned by the schema owner, so the inner call runs as the owner. No RLS
-- policy, trigger running as the caller, or backend query calls it (the
-- policies call app_acts_for_authority). So it is made invoker's rights and
-- closed to PUBLIC and water_app, as authority_confirm_by_operator (229) and
-- app_member_role (163, PUBLIC) are: an internal helper, never a question the
-- app can ask. As SECURITY INVOKER it falls outside the catalogue's
-- "water_app executes every SECURITY DEFINER function" guard, and running as
-- the owner inside app_acts_for_authority it reads authority_delegate past RLS
-- just as before, so no decision, endorsement or registration check changes.

ALTER FUNCTION app_authority_member(uuid, uuid) SECURITY INVOKER;
REVOKE ALL ON FUNCTION app_authority_member(uuid, uuid) FROM PUBLIC, water_app;
COMMENT ON FUNCTION app_authority_member(uuid, uuid) IS
	'Whether p_user is a confirmed delegate of p_project''s authority holding editor or above (229). Internal (230): invoker''s rights, closed to PUBLIC and water_app; called only from app_acts_for_authority (SECURITY DEFINER), so it runs as the schema owner.';
