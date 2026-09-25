-- 008_team_viewer — a read-only team role (docs/data-model.md § Teams).
--
-- Until now every team member was an editor on every team project, so a WUA
-- clerk or a client reviewer added to a team could change settings and run
-- the model. A team `viewer` gets `viewer` on the team's projects:
--   team admin  → owner
--   team member → editor
--   team viewer → viewer
--
-- ALTER TYPE … ADD VALUE may run inside the migration runner's transaction
-- (PostgreSQL 12+), but the new value can't be *used* until that transaction
-- commits. So nothing below names 'viewer' as a team_role constant: the
-- mapping compares the role as text, and the policies list the roles that
-- may contribute rather than excluding the new one.
--
-- 'viewer' sorts below 'member', so enum order stays viewer < member < admin.
ALTER TYPE team_role ADD VALUE 'viewer' BEFORE 'member';

-- Latest definition: 002_teams. Unknown team roles map to NULL (no access
-- through the team), so a future role can never fall through to editor.
CREATE OR REPLACE FUNCTION app_project_role(p_project uuid) RETURNS project_role
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT max(r) FROM (
			SELECT role AS r FROM project_member
			WHERE project_id = p_project AND user_id = app_current_user_id()
			UNION ALL
			SELECT CASE tm.role::text
					WHEN 'admin' THEN 'owner'::project_role
					WHEN 'member' THEN 'editor'::project_role
					WHEN 'viewer' THEN 'viewer'::project_role
				END
			FROM project p JOIN team_member tm ON tm.team_id = p.team_id
			WHERE p.id = p_project AND tm.user_id = app_current_user_id()
		) roles
	$$;

-- A team viewer may not add projects to the team: creating one (or moving
-- one in) would make them its direct owner inside a team they can only read.
-- Latest definitions: 002_teams.
DROP POLICY project_insert ON project;
CREATE POLICY project_insert ON project FOR INSERT
	WITH CHECK (created_by = app_current_user_id() AND (team_id IS NULL OR app_team_role(team_id) IN ('member', 'admin')));
DROP POLICY project_update ON project;
CREATE POLICY project_update ON project FOR UPDATE
	USING (app_has_role(id, 'editor'))
	WITH CHECK (
		app_has_role(id, 'editor')
		AND (team_id IS NULL OR app_team_role(team_id) IN ('member', 'admin')
			-- An editor renaming a project in a team they only view (they are a
			-- direct editor) must not be blocked: only a *change* of team is gated.
			OR team_id = (SELECT p.team_id FROM project p WHERE p.id = project.id))
	);
