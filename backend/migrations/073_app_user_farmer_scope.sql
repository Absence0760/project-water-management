-- 073_app_user_farmer_scope — a farmer sees only the accounts their pages
-- name (docs/security.md § Accounts under RLS; docs/data-model.md § app_user).
--
-- 068's app_user_visible showed every caller everyone who is or was part of
-- a project they can open. For a farmer that was every other farmer's and
-- every member's name and email, at SQL level, though no farmer-facing route
-- shows them (farms/, publish/, notes/, alerts/, /me/export). Now a project
-- where the caller's effective role is `farmer` (a farmer membership and no
-- other way in: another membership role or its team makes them staff there,
-- as app_project_role takes the max) shows them only:
--
--   * who published or last changed a publication (run_publication
--     published_by / updated_by: the farm view's and GET /publication's
--     "published by"; every member reads every publication);
--   * the author of a farm-visible, undeleted note on one of their linked
--     farms (note_select_farmer's rows; a deleted one they can still read is
--     their own, and they always see themselves);
--   * whoever linked them to a farm (farm_link.added_by on their own links:
--     the data-subject export's linkedBy).
--
-- Themselves, and their team-mates (a team role never maps to farmer), as
-- before. Every other project keeps 068's list unchanged. The who-can-see-
-- my-farm list (app_farm_access) is SECURITY DEFINER, so it doesn't depend
-- on this. An applicant (contributor) keeps 068's list.
--
-- From 068_app_user_rls.sql, the latest definition. Same signature, so the
-- app_user_select policy and the grants carry over.

CREATE OR REPLACE FUNCTION app_user_visible(p_user uuid) RETURNS boolean
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
				-- Projects you're more than a farmer in: another membership role, or through a team.
				SELECT m.project_id FROM project_member m WHERE m.user_id = me AND m.role <> 'farmer'
				UNION
				SELECT p.id FROM project p JOIN team_member tm ON tm.team_id = p.team_id WHERE tm.user_id = me
			), farmed AS (
				-- Projects you're only a farmer in.
				SELECT m.project_id FROM project_member m WHERE m.user_id = me AND m.role = 'farmer'
				EXCEPT
				SELECT project_id FROM mine
			)
			-- Part of one of your projects now: a member, or in its team.
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
			-- A farmer's projects: only the people their pages name.
			UNION ALL SELECT 1 FROM run_publication rp JOIN farmed USING (project_id) WHERE rp.published_by = p_user
			UNION ALL SELECT 1 FROM run_publication rp JOIN farmed USING (project_id) WHERE rp.updated_by = p_user
			UNION ALL SELECT 1 FROM note n JOIN farmed USING (project_id)
				JOIN farm_link fl ON fl.project_id = n.project_id AND fl.node_id = n.node_id AND fl.user_id = me
				WHERE n.author_id = p_user AND n.visibility = 'farm' AND n.deleted_at IS NULL
			UNION ALL SELECT 1 FROM farm_link fl JOIN farmed USING (project_id) WHERE fl.user_id = me AND fl.added_by = p_user
		);
	END
	$$;
