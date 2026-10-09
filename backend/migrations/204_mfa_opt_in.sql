-- 204_mfa_opt_in: two-step sign-in is opt-in, per project and per team
-- (operator decision, 2026-10-08; docs/security.md § Two-step sign-in,
-- auth/stepUp.ts). It replaces the role-based requirement of 2026-10-01:
-- an owner's and a team admin's actions need a second factor only where the
-- project, or its team, has turned this on. The actions that reach people
-- outside the team (publishing to farmers, deciding an application,
-- endorsing a baseline, recording a registration check, signing, issuing and
-- withdrawing an evidence pack) need one whatever these say.
--
--  1. project.require_mfa, team.require_mfa: off by default. An owner turns
--     the project's on or off, a team admin the team's (PATCH /projects/:id,
--     PATCH /teams/:id). The route refuses turning one on to someone not
--     signed in with a second factor, so a project can't lock everyone out
--     at once; turning it off is an owner's action under the setting, so it
--     is stepped up by the setting itself.
--  2. project_require_mfa_guard: project_update (002) lets an editor update
--     the row, so the trigger refuses water_app's change of the column by
--     anyone below owner. team_update is admin-only already.
--  3. app_project_requires_mfa(p): the project's setting or its team's.
--     Definer: someone shared a team project directly (not in the team)
--     can't read the team row (team_select), and must still be held to it.
--     Null for a non-member, as app_project_role.

ALTER TABLE project ADD COLUMN require_mfa boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN project.require_mfa IS
	'An owner''s actions on this project need two-step sign-in (204_mfa_opt_in, auth/stepUp.ts). Set by an owner; off by default.';
ALTER TABLE team ADD COLUMN require_mfa boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN team.require_mfa IS
	'A team admin''s actions, and an owner''s on every team project, need two-step sign-in (204_mfa_opt_in, auth/stepUp.ts). Set by a team admin; off by default.';

CREATE FUNCTION project_require_mfa_guard() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF current_user = 'water_app' AND NEW.require_mfa IS DISTINCT FROM OLD.require_mfa
		   AND app_project_role(OLD.id) IS DISTINCT FROM 'owner' THEN
			RAISE EXCEPTION 'only an owner changes whether project % requires two-step sign-in', OLD.id
				USING ERRCODE = 'insufficient_privilege';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER project_require_mfa_guard BEFORE UPDATE OF require_mfa ON project
	FOR EACH ROW EXECUTE FUNCTION project_require_mfa_guard();
REVOKE ALL ON FUNCTION project_require_mfa_guard() FROM PUBLIC, water_app;

CREATE FUNCTION app_project_requires_mfa(p_project uuid) RETURNS boolean
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT p.require_mfa OR coalesce(t.require_mfa, false)
		FROM project p LEFT JOIN team t ON t.id = p.team_id
		WHERE p.id = p_project AND app_project_role(p.id) IS NOT NULL
	$$;
REVOKE ALL ON FUNCTION app_project_requires_mfa(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_project_requires_mfa(uuid) TO water_app;
