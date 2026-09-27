-- 072_audit_trail — two gaps in the audit trail (docs/data-model.md § Change
-- history, docs/security.md § Change history):
--   1. a team invite accepted is recorded on each of the team's projects;
--   2. a scenario with a signed-off run can't be deleted (below).
--
-- 1. Team members.
-- A team role is a project role on every project of the team
-- (app_project_role: admin → owner, member → editor, viewer → viewer), so who
-- joins, changes role in or leaves a team changes who can read and write each
-- of those projects. The team routes record team_member.added / .role /
-- .removed and team.deleted on each team project (teams/routes.ts,
-- recordTeamAudit). Joining by accepting a team invite happens here, in
-- app_accept_invites, so it is recorded here too, as the person who joined,
-- like a project invite's member.added (030_history).
--
-- app_accept_invites, redefined from its latest definition (050_user_locale):
-- the team insert's RETURNING feeds one team_member.added event per project
-- of each team joined. The rest of the body is 050's, unchanged.

CREATE OR REPLACE FUNCTION app_accept_invites(p_user uuid) RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_email citext;
		v_name text;
		n_project integer;
		n_team integer;
	BEGIN
		SELECT email, display_name INTO v_email, v_name FROM app_user WHERE id = p_user AND email_verified_at IS NOT NULL;
		IF v_email IS NULL THEN
			RETURN 0;
		END IF;
		WITH joined AS (
			INSERT INTO project_member (project_id, user_id, role)
				SELECT project_id, p_user, project_role FROM invite
				WHERE email = v_email AND project_id IS NOT NULL AND expires_at > now()
				ON CONFLICT (project_id, user_id) DO NOTHING
				RETURNING project_id, role
		), logged AS (
			INSERT INTO audit_event (project_id, actor_user_id, actor_label, kind, subject)
				SELECT j.project_id, p_user, left(coalesce(v_name, ''), 200), 'member.added',
					jsonb_build_object('userId', p_user, 'displayName', v_name, 'role', j.role::text, 'via', 'invite')
				FROM joined j
			RETURNING 1
		)
		SELECT count(*) INTO n_project FROM joined;
		WITH linked AS (
			INSERT INTO farm_link (project_id, node_id, user_id, added_by)
				SELECT i.project_id, n.node_id, p_user, i.invited_by
				FROM invite i
				JOIN invite_node n ON n.invite_id = i.id
				JOIN node nd ON nd.id = n.node_id AND nd.kind = 'farm'
				JOIN project_member m ON m.project_id = i.project_id AND m.user_id = p_user AND m.role = 'farmer'
				WHERE i.email = v_email AND i.project_role = 'farmer' AND i.expires_at > now()
				ON CONFLICT DO NOTHING
				RETURNING project_id, node_id
		)
		INSERT INTO audit_event (project_id, actor_user_id, actor_label, kind, subject)
			SELECT l.project_id, p_user, left(coalesce(v_name, ''), 200), 'farmer.linked',
				jsonb_build_object('userId', p_user, 'displayName', v_name, 'nodeId', l.node_id, 'nodeName', nd.name, 'cause', 'invite')
			FROM linked l JOIN node nd ON nd.id = l.node_id;
		-- 072: each team joined is recorded on each of its projects.
		WITH joined_team AS (
			INSERT INTO team_member (team_id, user_id, role)
				SELECT team_id, p_user, team_role FROM invite
				WHERE email = v_email AND team_id IS NOT NULL AND expires_at > now()
				ON CONFLICT (team_id, user_id) DO NOTHING
				RETURNING team_id, role
		), logged_team AS (
			INSERT INTO audit_event (project_id, actor_user_id, actor_label, kind, subject)
				SELECT p.id, p_user, left(coalesce(v_name, ''), 200), 'team_member.added',
					jsonb_build_object('teamId', t.id, 'team', t.name, 'userId', p_user, 'displayName', v_name,
						'teamRole', j.role::text,
						'role', CASE j.role::text WHEN 'admin' THEN 'owner' WHEN 'member' THEN 'editor' WHEN 'viewer' THEN 'viewer' END,
						'via', 'invite')
				FROM joined_team j JOIN team t ON t.id = j.team_id JOIN project p ON p.team_id = j.team_id
			RETURNING 1
		)
		SELECT count(*) INTO n_team FROM joined_team;
		-- 050: an account with no language yet takes its invite's.
		UPDATE app_user SET locale = (
			SELECT i.locale FROM invite i
			WHERE i.email = v_email AND i.expires_at > now()
			ORDER BY i.last_sent_at DESC, i.created_at DESC
			LIMIT 1
		)
		WHERE id = p_user AND locale IS NULL;
		DELETE FROM invite WHERE email = v_email AND expires_at > now();
		RETURN n_project + n_team;
	END
	$$;

-- ---------------------------------------------------------------------------
-- 2. A signed-off run stays the run that was signed. A scenario run records
-- its scenario (model_run.scenario_id, 024_scenarios: ON DELETE SET NULL),
-- so deleting the scenario would turn a signed scenario run into what looks
-- like a run of the project's own inputs. The DELETE route refuses a
-- scenario with a signed-off run (409, scenarios/routes.ts); this trigger
-- refuses it whoever runs the DELETE. SECURITY DEFINER so it sees every
-- sign-off, whatever the deleter may read (a contributor reads neither
-- signoff nor model_run). A project deleted whole takes its scenarios with
-- it: the cascade runs after the project row is gone, so the guard lets it
-- through.
-- ---------------------------------------------------------------------------
CREATE FUNCTION scenario_signed_run_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF EXISTS (SELECT 1 FROM project WHERE id = OLD.project_id)
		   AND EXISTS (SELECT 1 FROM signoff so JOIN model_run r ON r.id = so.run_id WHERE r.scenario_id = OLD.id) THEN
			RAISE EXCEPTION 'scenario % has a signed-off run, so it is kept', OLD.id
				USING ERRCODE = 'restrict_violation';
		END IF;
		RETURN OLD;
	END
	$$;
CREATE TRIGGER scenario_signed_run_guard BEFORE DELETE ON scenario
	FOR EACH ROW EXECUTE FUNCTION scenario_signed_run_guard();

-- A trigger function needs no EXECUTE grant (as 035's).
REVOKE ALL ON FUNCTION scenario_signed_run_guard() FROM PUBLIC, water_app;

COMMENT ON FUNCTION scenario_signed_run_guard() IS
	'Refuses to delete a scenario one of whose runs is signed off, so the run keeps its scenario (072_audit_trail, 036_signoff).';
