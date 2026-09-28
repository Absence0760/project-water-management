-- 097_contributor_invite_farms — invite a licence applicant (a contributor,
-- 044/045, WP-3.3) with the farms they hold, as a farmer invite carries its
-- farms (034_farmer_invites; docs/followups.md § Applicants, issue #73).
-- Until now an applicant's farm links were set by the owner after they
-- joined (PUT /farmers/:userId), so an irrigator applying to raise their own
-- dam signed up to an application with no farm of their own.
--
--   invite_node_check     redefined from 034: an invite's farms may belong
--                         to a contributor invite as well as a farmer one.
--   app_accept_invites    redefined from its latest definition (072_audit_trail):
--                         the farm links are made for a contributor invite
--                         too, for the role the invite made them. The rest of
--                         the body is 072's, unchanged.
--
-- farm_link_check (045) already admits a contributor's links.

CREATE OR REPLACE FUNCTION invite_node_check() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NOT EXISTS (SELECT 1 FROM node WHERE id = NEW.node_id AND kind = 'farm') THEN
			RAISE EXCEPTION 'node % is not a farm', NEW.node_id USING ERRCODE = 'check_violation';
		END IF;
		IF NOT EXISTS (
			SELECT 1 FROM invite
			WHERE id = NEW.invite_id AND project_id = NEW.project_id AND project_role IN ('farmer', 'contributor')
		) THEN
			RAISE EXCEPTION 'invite % is not a farmer or applicant invite on this project', NEW.invite_id USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END
	$$;
COMMENT ON TABLE invite_node IS
	'Which farm nodes a farmer or applicant invite links once accepted (034, 097). Owner-only, like the invite.';

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
				-- 097: a contributor invite's farms too, for the role it made them (not one they held before).
				JOIN project_member m ON m.project_id = i.project_id AND m.user_id = p_user AND m.role = i.project_role
				WHERE i.email = v_email AND i.project_role IN ('farmer', 'contributor') AND i.expires_at > now()
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

