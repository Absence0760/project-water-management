-- 076_app_user_applicant_scope — an applicant sees only the accounts their
-- pages name (docs/security.md § Accounts under RLS; docs/data-model.md §
-- app_user).
--
-- 073 narrowed app_user_visible for a farmer-only caller, but an applicant
-- (the `contributor` project role, 044/045) kept 068's list: every
-- co-member's and every former member's name and email in the project, at
-- SQL level, though no route an applicant reaches shows them. What those
-- routes show: the scenario routes (scenarios/routes.ts, SCENARIO_SELECT in
-- scenarios/execute.ts) on the applications RLS lets them read (their own
-- and those shared with them, app_scenario_visible 045), and the farmer
-- routes (farm view, publication, notes, /me/export), which rank them as a
-- farmer. Their run metadata (app_scenario_run_meta 046) and the base's
-- brief (app_run_brief) name nobody; sign-offs, run pages, the audit log and
-- the member list need viewer; the share candidates are SECURITY DEFINER
-- (app_share_candidates 049). So a project where the caller's effective role
-- is `contributor` (that membership and no team: a team role makes them
-- staff) now shows them only:
--
--   * everything 073 shows a farmer (they reach the same pages and keep farm
--     links): who published or last changed a publication, the author of a
--     farm-visible note on one of their linked farms, whoever linked them;
--   * the owner of an application shared with them (SCENARIO_SELECT
--     inner-joins it: without it the application would drop out of their
--     list);
--   * the other people an application of theirs, or one shared with them,
--     is shared with (scenario_member: its `members`);
--   * the assessor who decided such an application (its `decidedBy`).
--
-- Themselves and their team-mates, as before. A farmer-only project is as
-- 073 left it, and a scenario branch never applies there (a demoted
-- applicant reads none of their former applications). Every other project
-- keeps 068's list.
--
-- From 073_app_user_farmer_scope.sql, the latest definition. Same
-- signature, so the app_user_select policy and the grants carry over.

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
				-- Projects you're staff in: a viewer-or-above membership, or through a team.
				SELECT m.project_id FROM project_member m WHERE m.user_id = me AND m.role NOT IN ('farmer', 'contributor')
				UNION
				SELECT p.id FROM project p JOIN team_member tm ON tm.team_id = p.team_id WHERE tm.user_id = me
			), farmed AS (
				-- Projects you're only a farmer or an applicant in.
				SELECT m.project_id FROM project_member m WHERE m.user_id = me AND m.role IN ('farmer', 'contributor')
				EXCEPT
				SELECT project_id FROM mine
			), applied AS (
				-- …of those, the ones you're an applicant in.
				SELECT m.project_id FROM project_member m JOIN farmed USING (project_id) WHERE m.user_id = me AND m.role = 'contributor'
			), readable AS (
				-- The applications you read there: your own, and those shared with you.
				SELECT s.id, s.project_id FROM scenario s JOIN applied USING (project_id) WHERE s.owner_user_id = me
				UNION
				SELECT sm.scenario_id, sm.project_id FROM scenario_member sm JOIN applied USING (project_id) WHERE sm.user_id = me
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
			-- A farmer's or an applicant's projects: only the people their pages name.
			UNION ALL SELECT 1 FROM run_publication rp JOIN farmed USING (project_id) WHERE rp.published_by = p_user
			UNION ALL SELECT 1 FROM run_publication rp JOIN farmed USING (project_id) WHERE rp.updated_by = p_user
			UNION ALL SELECT 1 FROM note n JOIN farmed USING (project_id)
				JOIN farm_link fl ON fl.project_id = n.project_id AND fl.node_id = n.node_id AND fl.user_id = me
				WHERE n.author_id = p_user AND n.visibility = 'farm' AND n.deleted_at IS NULL
			UNION ALL SELECT 1 FROM farm_link fl JOIN farmed USING (project_id) WHERE fl.user_id = me AND fl.added_by = p_user
			-- An applicant's: the owner, the shared members and the assessor of the applications they read.
			UNION ALL SELECT 1 FROM scenario s JOIN readable ON readable.id = s.id WHERE s.owner_user_id = p_user
			UNION ALL SELECT 1 FROM scenario_member sm JOIN readable ON readable.id = sm.scenario_id WHERE sm.user_id = p_user
			UNION ALL SELECT 1 FROM scenario s JOIN readable ON readable.id = s.id WHERE s.decided_by = p_user
		);
	END
	$$;
