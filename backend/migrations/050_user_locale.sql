-- 050_user_locale — a person's language and volume unit (roadmap WP-2.5;
-- docs/data-model.md § Users, docs/ui.md § Language).
--
-- Expand-only:
--
--   1. app_user.locale: the language the farmer-facing pages and the emails
--      use, 'en' or 'af'. NULL means "not chosen": the site follows the
--      browser (frontend lib/i18n) and emails go out in English. Set by
--      PATCH /auth/me, by sign-up (the language the sign-up page was in), or
--      from the invite an account accepts (3 below).
--
--   2. app_user.volume_unit: how the farm view shows volumes, 'm3' (the
--      default, design FV-D3) or 'ML'. Set by PATCH /auth/me, which the farm
--      view's unit switch calls.
--
--      app_user has no RLS (it is read before sign-in, 001) and water_app's
--      table-level grant on it covers both new columns.
--
--   3. app_accept_invites, redefined from its latest definition
--      (034_farmer_invites): an account with no locale yet takes the locale of
--      the invite it accepts (the most recently sent, when it accepts
--      several), before the invites are deleted. A farmer invited in
--      Afrikaans (invite.locale 'af', 034) therefore gets Afrikaans pages and
--      emails without choosing again. A locale the person already chose is
--      never overwritten. The rest of the body is 034's, unchanged.

ALTER TABLE app_user
	ADD COLUMN locale text CHECK (locale IN ('en', 'af')),
	ADD COLUMN volume_unit text NOT NULL DEFAULT 'm3' CHECK (volume_unit IN ('m3', 'ML'));

COMMENT ON COLUMN app_user.locale IS
	'Language of the farmer-facing pages and emails: en or af; NULL = not chosen (the site follows the browser, emails are English). 050, WP-2.5.';
COMMENT ON COLUMN app_user.volume_unit IS
	'How the farm view shows volumes: m3 (default) or ML. 050, WP-2.5.';

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
		INSERT INTO team_member (team_id, user_id, role)
			SELECT team_id, p_user, team_role FROM invite
			WHERE email = v_email AND team_id IS NOT NULL AND expires_at > now()
			ON CONFLICT (team_id, user_id) DO NOTHING;
		GET DIAGNOSTICS n_team = ROW_COUNT;
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
