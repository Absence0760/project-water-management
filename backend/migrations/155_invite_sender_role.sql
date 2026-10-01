-- 155_invite_sender_role — an invite is good only while its sender may still
-- send it (docs/followups.md, "An invite outlives its sender's right to send
-- it", from the review of issue #136; docs/security.md § Authorization).
--
-- invite's RLS (004) checks that the writer is the project's owner or the
-- team's admin when the invite is written, and never again. An owner who sent
-- one and was then removed or demoted (or a team admin demoted, or the
-- project moved out of their team) left the invite live: the invitee still
-- joined with the invited role, `owner` included, through the invitations
-- page (app_accept_invite), a sign-up through the invite link
-- (app_invite_for_token, then app_accept_invites) or a confirmation or
-- password-reset link (markVerified, app_accept_invites).
--
-- The fix: check the sender's right where the invite is used, not when the
-- sender's role changes. Every function that lists, describes or accepts an
-- invite now takes only invites whose invited_by still holds owner on the
-- project (directly, or as an admin of the team that owns it) or admin on
-- the team, through one predicate, app_invite_sender_holds. Chosen over a
-- trigger that deletes a person's sent invites when they lose the role
-- because the role can be lost in more ways than any trigger list keeps up
-- with: a project_member delete or role change, a team_member delete or role
-- change (which also takes the owner role on every project of the team), a
-- project's team_id changing, and whatever a later migration adds. A check
-- at the point of use fails closed on all of them, a missed trigger fails
-- open. It also keeps the invite visible to the remaining owners, flagged
-- (app_invite_sender_lapsed), instead of having it vanish as though it had
-- been accepted; re-sending it makes the re-sender its sender (invites.ts
-- inviteByEmail), which revives it under their right, and revoking deletes
-- it. A sender who gets the role back revives their invites too: they could
-- have sent them again anyway.
--
-- A sender whose account is deleted takes their invites with them already:
-- invite.invited_by is NOT NULL REFERENCES app_user ON DELETE CASCADE (004),
-- and account deletion (048, 138, 143) deletes the app_user row. The
-- predicate still treats a NULL sender as having no right, in case that
-- column ever becomes nullable.
--
-- An accept racing the sender's demotion: the accept reads the sender's
-- membership as of its statement (READ COMMITTED), so it serialises as an
-- accept that happened just before the demotion committed.
--
-- Changes (all from their latest definitions; same names, arguments,
-- results, volatility, SECURITY DEFINER and pinned search_path, so the
-- grants stand except where restated):
--
--   app_invite_sender_holds  new. Plain SQL, SECURITY INVOKER: run inside
--                            the SECURITY DEFINER functions below, as their
--                            owner. Not granted to water_app (as the caller
--                            it would answer under RLS, and nothing calls it
--                            directly).
--   app_invite_sender_lapsed new, SECURITY DEFINER, for the owner-facing
--                            invite lists (invites.ts, farms/routes.ts):
--                            true when an invite's sender no longer holds the
--                            right. Answers only for an invite the caller may
--                            see under invite_select (an owner of its project,
--                            an admin of its team), NULL otherwise, so it
--                            tells nobody else anyone's role.
--   app_accept_invites       from 109: the predicate added to each statement
--                            (the memberships, a farm invite's links, the
--                            locale, and the delete, which now drops only the
--                            invites it accepted: a lapsed one stays for the
--                            owners to see, re-send or revoke).
--   app_my_invites           from 109: lists only invites whose sender still
--                            holds the right.
--   app_accept_invite        from 109: 404s (no row) a lapsed invite.
--   app_invite_for_token     from 004 (never redefined): a lapsed invite's
--                            link is invalid, like an expired one, so a
--                            sign-up through it neither verifies the address
--                            nor joins.
--
-- app_decline_invite (109) is unchanged: declining your own invite is
-- harmless whoever sent it.

CREATE FUNCTION app_invite_sender_holds(p_sender uuid, p_project uuid, p_team uuid) RETURNS boolean
	LANGUAGE sql STABLE SET search_path = public
	AS $$
		SELECT CASE
			WHEN p_sender IS NULL THEN false
			WHEN p_project IS NOT NULL THEN
				EXISTS (
					SELECT 1 FROM project_member
					WHERE project_id = p_project AND user_id = p_sender AND role = 'owner'
				)
				OR EXISTS (
					SELECT 1 FROM project p JOIN team_member tm ON tm.team_id = p.team_id
					WHERE p.id = p_project AND tm.user_id = p_sender AND tm.role = 'admin'
				)
			WHEN p_team IS NOT NULL THEN
				EXISTS (
					SELECT 1 FROM team_member
					WHERE team_id = p_team AND user_id = p_sender AND role = 'admin'
				)
			ELSE false
		END
	$$;
REVOKE ALL ON FUNCTION app_invite_sender_holds(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_invite_sender_holds(uuid, uuid, uuid) FROM water_app;

CREATE FUNCTION app_invite_sender_lapsed(p_invite uuid) RETURNS boolean
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT NOT app_invite_sender_holds(i.invited_by, i.project_id, i.team_id)
		FROM invite i
		WHERE i.id = p_invite AND (
			(i.project_id IS NOT NULL AND app_has_role(i.project_id, 'owner'))
			OR (i.team_id IS NOT NULL AND app_team_role(i.team_id) = 'admin')
		)
	$$;
REVOKE ALL ON FUNCTION app_invite_sender_lapsed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_invite_sender_lapsed(uuid) TO water_app;

CREATE OR REPLACE FUNCTION app_accept_invites(p_user uuid, p_invite uuid DEFAULT NULL) RETURNS integer
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
					AND (p_invite IS NULL OR id = p_invite)
					-- 155: only while its sender may still send it.
					AND app_invite_sender_holds(invited_by, project_id, team_id)
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
					AND (p_invite IS NULL OR i.id = p_invite)
					-- 155: a lapsed invite links no farms, even for someone already holding its role.
					AND app_invite_sender_holds(i.invited_by, i.project_id, i.team_id)
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
					AND (p_invite IS NULL OR id = p_invite)
					AND app_invite_sender_holds(invited_by, project_id, team_id)
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
			WHERE i.email = v_email AND i.expires_at > now() AND (p_invite IS NULL OR i.id = p_invite)
				AND app_invite_sender_holds(i.invited_by, i.project_id, i.team_id)
			ORDER BY i.last_sent_at DESC, i.created_at DESC
			LIMIT 1
		)
		WHERE id = p_user AND locale IS NULL;
		-- 155: a lapsed invite stays, for the remaining owners to see, re-send or revoke.
		DELETE FROM invite
		WHERE email = v_email AND expires_at > now() AND (p_invite IS NULL OR id = p_invite)
			AND app_invite_sender_holds(invited_by, project_id, team_id);
		RETURN n_project + n_team;
	END
	$$;

CREATE OR REPLACE FUNCTION app_my_invites() RETURNS TABLE (
	id uuid,
	project_id uuid,
	team_id uuid,
	target_name text,
	role text,
	invited_by_name text,
	created_at timestamptz,
	expires_at timestamptz,
	farms text[]
)
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT i.id, i.project_id, i.team_id, coalesce(p.name, t.name), coalesce(i.project_role::text, i.team_role::text),
			u.display_name, i.created_at, i.expires_at,
			coalesce((
				SELECT array_agg(nd.name ORDER BY nd.name)
				FROM invite_node n JOIN node nd ON nd.id = n.node_id
				WHERE n.invite_id = i.id
			), '{}')
		FROM app_user me
		JOIN invite i ON i.email = me.email AND i.expires_at > now()
		JOIN app_user u ON u.id = i.invited_by
		LEFT JOIN project p ON p.id = i.project_id
		LEFT JOIN team t ON t.id = i.team_id
		WHERE me.id = app_current_user_id() AND me.email_verified_at IS NOT NULL
			AND app_invite_sender_holds(i.invited_by, i.project_id, i.team_id)
		ORDER BY i.created_at DESC, i.id
	$$;

CREATE OR REPLACE FUNCTION app_accept_invite(p_invite uuid) RETURNS TABLE (joined_project uuid, joined_team uuid)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_user uuid := app_current_user_id();
		v_project uuid;
		v_team uuid;
	BEGIN
		SELECT i.project_id, i.team_id INTO v_project, v_team
		FROM invite i JOIN app_user me ON me.email = i.email
		WHERE i.id = p_invite AND me.id = v_user AND me.email_verified_at IS NOT NULL AND i.expires_at > now()
			AND app_invite_sender_holds(i.invited_by, i.project_id, i.team_id)
		FOR UPDATE OF i;
		IF NOT FOUND THEN
			RETURN;
		END IF;
		PERFORM app_accept_invites(v_user, p_invite);
		joined_project := v_project;
		joined_team := v_team;
		RETURN NEXT;
	END
	$$;

CREATE OR REPLACE FUNCTION app_invite_for_token(p_hash bytea)
	RETURNS TABLE (email citext, project_name text, team_name text, inviter_name text)
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT i.email, p.name, t.name, u.display_name
		FROM invite i
		JOIN app_user u ON u.id = i.invited_by
		LEFT JOIN project p ON p.id = i.project_id
		LEFT JOIN team t ON t.id = i.team_id
		WHERE i.token_hash = p_hash AND i.expires_at > now()
			AND app_invite_sender_holds(i.invited_by, i.project_id, i.team_id)
	$$;
