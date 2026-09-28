-- 002_teams — groups of users that own projects together.
--
-- A team (e.g. a consultancy or a catchment management agency) has members
-- with a team role. Projects may belong to a team; every team member then has
-- access to all of the team's projects without being added one by one:
--   team admin  → owner  on the team's projects
--   team member → editor on the team's projects
-- Direct project membership (project_member) still works on top — the
-- effective role is the higher of the two. See docs/data-model.md.

CREATE TYPE team_role AS ENUM ('member', 'admin');

CREATE TABLE team (
	id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
	created_by uuid NOT NULL REFERENCES app_user(id),
	created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX team_created_by_idx ON team (created_by);

CREATE TABLE team_member (
	team_id  uuid NOT NULL REFERENCES team(id) ON DELETE CASCADE,
	user_id  uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
	role     team_role NOT NULL,
	added_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_member_user_idx ON team_member (user_id);

-- Deleting a team leaves its projects with their direct members (the creator
-- is always a direct owner), so no project becomes orphaned.
ALTER TABLE project ADD COLUMN team_id uuid REFERENCES team(id) ON DELETE SET NULL;
CREATE INDEX project_team_idx ON project (team_id);

-- ---------------------------------------------------------------------------
-- Access helpers
-- ---------------------------------------------------------------------------

CREATE FUNCTION app_team_role(p_team uuid) RETURNS team_role
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT role FROM team_member WHERE team_id = p_team AND user_id = app_current_user_id()
	$$;

-- Effective project role for the current user: the higher of direct
-- membership and the role granted through the project's team. NULL = no access.
CREATE FUNCTION app_project_role(p_project uuid) RETURNS project_role
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT max(r) FROM (
			SELECT role AS r FROM project_member
			WHERE project_id = p_project AND user_id = app_current_user_id()
			UNION ALL
			SELECT CASE tm.role WHEN 'admin' THEN 'owner'::project_role ELSE 'editor'::project_role END
			FROM project p JOIN team_member tm ON tm.team_id = p.team_id
			WHERE p.id = p_project AND tm.user_id = app_current_user_id()
		) roles
	$$;

-- Every project-scoped policy goes through app_has_role, so redefining it
-- extends all of them to team access at once. (Latest definition: 001_init.)
CREATE OR REPLACE FUNCTION app_has_role(p_project uuid, p_min project_role) RETURNS boolean
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$ SELECT coalesce(app_project_role(p_project) >= p_min, false) $$;

-- Creator becomes the team's first admin.
CREATE FUNCTION team_add_creator_as_admin() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		INSERT INTO team_member (team_id, user_id, role) VALUES (NEW.id, NEW.created_by, 'admin');
		RETURN NEW;
	END
	$$;
CREATE TRIGGER team_creator_admin AFTER INSERT ON team
	FOR EACH ROW EXECUTE FUNCTION team_add_creator_as_admin();

-- A team must always keep at least one admin.
CREATE FUNCTION team_member_keep_admin() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NOT EXISTS (SELECT 1 FROM team WHERE id = OLD.team_id) THEN
			RETURN NULL;
		END IF;
		IF NOT EXISTS (SELECT 1 FROM team_member WHERE team_id = OLD.team_id AND role = 'admin') THEN
			RAISE EXCEPTION 'a team must keep at least one admin' USING ERRCODE = 'check_violation';
		END IF;
		RETURN NULL;
	END
	$$;
CREATE CONSTRAINT TRIGGER team_member_keep_admin
	AFTER UPDATE OR DELETE ON team_member
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW EXECUTE FUNCTION team_member_keep_admin();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
ALTER TABLE team ENABLE ROW LEVEL SECURITY;
CREATE POLICY team_select ON team FOR SELECT USING (app_team_role(id) IS NOT NULL);
CREATE POLICY team_insert ON team FOR INSERT WITH CHECK (created_by = app_current_user_id());
CREATE POLICY team_update ON team FOR UPDATE USING (app_team_role(id) = 'admin') WITH CHECK (app_team_role(id) = 'admin');
CREATE POLICY team_delete ON team FOR DELETE USING (app_team_role(id) = 'admin');

ALTER TABLE team_member ENABLE ROW LEVEL SECURITY;
CREATE POLICY team_member_select ON team_member FOR SELECT USING (app_team_role(team_id) IS NOT NULL);
CREATE POLICY team_member_insert ON team_member FOR INSERT WITH CHECK (app_team_role(team_id) = 'admin');
CREATE POLICY team_member_update ON team_member FOR UPDATE
	USING (app_team_role(team_id) = 'admin') WITH CHECK (app_team_role(team_id) = 'admin');
-- Admins remove anyone; anyone may leave.
CREATE POLICY team_member_delete ON team_member FOR DELETE
	USING (app_team_role(team_id) = 'admin' OR user_id = app_current_user_id());

-- A project may only be placed in a team its creator/editor belongs to.
DROP POLICY project_insert ON project;
CREATE POLICY project_insert ON project FOR INSERT
	WITH CHECK (created_by = app_current_user_id() AND (team_id IS NULL OR app_team_role(team_id) IS NOT NULL));
DROP POLICY project_update ON project;
CREATE POLICY project_update ON project FOR UPDATE
	USING (app_has_role(id, 'editor'))
	WITH CHECK (app_has_role(id, 'editor') AND (team_id IS NULL OR app_team_role(team_id) IS NOT NULL));

GRANT SELECT, INSERT, UPDATE, DELETE ON team, team_member TO water_app;
