-- The role functions every RLS policy calls, rewritten in PL/pgSQL, with the
-- same bodies and results. Latest definitions: app_current_user_id 001_init,
-- app_team_role 002_teams, app_project_role 008_team_viewer, app_has_role
-- 002_teams.
--
-- Why: as LANGUAGE sql functions with SECURITY DEFINER or a pinned
-- search_path they can't be inlined, and Postgres plans a non-inlined SQL
-- function's query again on every call. A policy calls app_has_role once per
-- row, so writing a run's ~200 output series spent ~0.8 ms a row on role
-- checks: 174 ms for 200 rows against 16 ms with RLS off. PL/pgSQL caches
-- its plans for the session, and the same insert takes 33 ms. Reads filter
-- through the same functions, so every project-scoped query gains too.
--
-- Signatures, volatility, SECURITY DEFINER and the pinned search_path are
-- unchanged (the catalogue tests guard the last).

CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
	LANGUAGE plpgsql STABLE SET search_path = public
	AS $$
	BEGIN
		RETURN nullif(current_setting('app.current_user_id', true), '')::uuid;
	END
	$$;

CREATE OR REPLACE FUNCTION app_team_role(p_team uuid) RETURNS team_role
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		RETURN (SELECT role FROM team_member WHERE team_id = p_team AND user_id = app_current_user_id());
	END
	$$;

-- Unknown team roles still map to NULL (no access through the team), so a
-- future role can never fall through to editor (008_team_viewer).
CREATE OR REPLACE FUNCTION app_project_role(p_project uuid) RETURNS project_role
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
	BEGIN
		RETURN (
			SELECT max(r) FROM (
				SELECT role AS r FROM project_member
				WHERE project_id = p_project AND user_id = uid
				UNION ALL
				SELECT CASE tm.role::text
						WHEN 'admin' THEN 'owner'::project_role
						WHEN 'member' THEN 'editor'::project_role
						WHEN 'viewer' THEN 'viewer'::project_role
					END
				FROM project p JOIN team_member tm ON tm.team_id = p.team_id
				WHERE p.id = p_project AND tm.user_id = uid
			) roles
		);
	END
	$$;

CREATE OR REPLACE FUNCTION app_has_role(p_project uuid, p_min project_role) RETURNS boolean
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		RETURN coalesce(app_project_role(p_project) >= p_min, false);
	END
	$$;
