-- 109_invite_accept — an account that already exists joins a project or a
-- team only when its holder accepts (issue #136, from #51's adversary pass).
--
-- Before this, adding a *verified* account by email made it a member at
-- once, answered with its display name, and put it on the members list: any
-- project owner could learn which addresses have accounts, and make a
-- stranger a member without asking. Now every add by email is an invite
-- (backend/src/invites/invites.ts), and the holder of a verified account
-- sees it on the invitations page and accepts or declines it there.
--
-- Expand-only:
--
--   app_accept_invites  redefined from its latest definition
--                       (097_contributor_invite_farms) with a second,
--                       optional argument: one invite's id, to accept just
--                       that one (NULL: every live invite for the address,
--                       as before: confirming the address, or signing up
--                       through an invite link). The old one-argument
--                       function is dropped so a call is never ambiguous;
--                       `app_accept_invites(uuid)` still resolves to the new
--                       one through the default. The body is 097's, with
--                       the invite filter added to each statement.
--
--   app_my_invites      the signed-in account's pending invites, live ones
--                       only, if its address is verified: what it was
--                       invited to (the project's or team's name), the role,
--                       who sent it, and a farmer or applicant invite's farm
--                       names. The invite table's RLS shows invites to
--                       owners and admins only, hence SECURITY DEFINER; the
--                       invitee sees nothing about anyone else.
--
--   app_accept_invite   accept one of your own live invites (verified
--                       address): the membership, a farm invite's links and
--                       the member.added / farmer.linked / team_member.added
--                       events, all through app_accept_invites. Returns the
--                       project or team joined; no row when the invite isn't
--                       yours, has expired or doesn't exist (the route's 404).
--
--   app_decline_invite  delete one of your own live invites. A project's
--                       history records invite.declined with the masked
--                       address and the role, and no actor: declining never
--                       shows the owner the account's name.

DROP FUNCTION app_accept_invites(uuid);

CREATE FUNCTION app_accept_invites(p_user uuid, p_invite uuid DEFAULT NULL) RETURNS integer
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
			ORDER BY i.last_sent_at DESC, i.created_at DESC
			LIMIT 1
		)
		WHERE id = p_user AND locale IS NULL;
		DELETE FROM invite WHERE email = v_email AND expires_at > now() AND (p_invite IS NULL OR id = p_invite);
		RETURN n_project + n_team;
	END
	$$;
REVOKE ALL ON FUNCTION app_accept_invites(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_accept_invites(uuid, uuid) TO water_app;

CREATE FUNCTION app_my_invites() RETURNS TABLE (
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
		ORDER BY i.created_at DESC, i.id
	$$;
REVOKE ALL ON FUNCTION app_my_invites() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_my_invites() TO water_app;

CREATE FUNCTION app_accept_invite(p_invite uuid) RETURNS TABLE (joined_project uuid, joined_team uuid)
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
REVOKE ALL ON FUNCTION app_accept_invite(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_accept_invite(uuid) TO water_app;

CREATE FUNCTION app_decline_invite(p_invite uuid) RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_user uuid := app_current_user_id();
		v_project uuid;
		v_role text;
		v_email text;
	BEGIN
		DELETE FROM invite i USING app_user me
		WHERE i.id = p_invite AND me.id = v_user AND me.email_verified_at IS NOT NULL
			AND me.email = i.email AND i.expires_at > now()
		RETURNING i.project_id, coalesce(i.project_role::text, i.team_role::text), i.email::text
		INTO v_project, v_role, v_email;
		IF NOT FOUND THEN
			RETURN false;
		END IF;
		-- A project's history (030); teams have none. The address masked as
		-- invite.sent's is (history/record.ts maskEmail), and no actor: the
		-- owner learns the invite was declined, never by whom.
		IF v_project IS NOT NULL THEN
			INSERT INTO audit_event (project_id, actor_user_id, actor_label, kind, subject)
			VALUES (v_project, NULL, '', 'invite.declined', jsonb_build_object(
				'inviteId', p_invite,
				'email', left(v_email, 1) || '•••' || substring(v_email FROM '@[^@]*$'),
				'role', v_role
			));
		END IF;
		RETURN true;
	END
	$$;
REVOKE ALL ON FUNCTION app_decline_invite(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_decline_invite(uuid) TO water_app;
