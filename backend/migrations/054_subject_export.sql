-- 054_subject_export — the data-subject export ("download my data",
-- GET /auth/me/export; plan.md Phase 7; docs/security.md § Personal
-- information (POPIA)).
--
-- Expand-only:
--
--   1. app_subject_export(): the parts of a person's export that RLS hides
--      from them, as one jsonb document. SECURITY DEFINER, because the rows
--      are theirs but the policies are the project's: a farmer can't read
--      the audit log (viewer and above), nobody but a project owner reads an
--      invite, and a person who has left a project no longer reads the notes
--      they wrote there, their sign-offs or their alert and report choices.
--      It takes **no user argument**: every row is keyed to
--      app_current_user_id() (the withUser transaction's setting), so a
--      caller can only ever read their own. Without a user it returns NULL.
--        - auditEvents: every event the person made (actor_user_id), or that
--          is about them (subject.userId, or subject.authorId on
--          note.deleted, the keys 048's pseudonymisation uses); newest
--          first, at most 50 000 (auditEventsTruncated says when more exist).
--        - invites: invites to their address, pending or lapsed (purged 90
--          days past expiry, 048), with the farms a farmer invite names,
--          only when the address is verified: an unverified account could
--          claim someone else's address. Never the token hash.
--        - notes: every note they wrote, deleted ones included (their own
--          text; note_select hides a deleted note's body from them only
--          once they've left the project).
--        - signoffs: their sign-offs, with the typed name and registration.
--        - alertSubscriptions: their alert choices, never the unsubscribe
--          nonce or hash.
--        - reportSubscriptions: the scheduled reports they are a recipient of.
--      The RLS-visible rest of the export (account, memberships, farm links,
--      the farm figures, allocations, alert deliveries) is read by the
--      route under withUser (backend/src/auth/export.ts).
--
--   2. app_user.data_exported_at: when the person last downloaded their
--      data. The route's rate limit (one export a minute per account, across
--      Lambda instances), like email_token's cooldown (004_email.sql).
--      water_app already has UPDATE on app_user.

ALTER TABLE app_user ADD COLUMN data_exported_at timestamptz;

CREATE FUNCTION app_subject_export() RETURNS jsonb
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		me uuid := app_current_user_id();
		my_email citext;
		verified boolean;
		max_events constant integer := 50000;
		events jsonb;
		n_events integer;
	BEGIN
		IF me IS NULL THEN
			RETURN NULL;
		END IF;
		SELECT u.email, u.email_verified_at IS NOT NULL INTO my_email, verified FROM app_user u WHERE u.id = me;
		IF NOT FOUND THEN
			RETURN NULL;
		END IF;

		SELECT coalesce(jsonb_agg(x.ev ORDER BY x.created_at DESC, x.id DESC), '[]'::jsonb), count(*)
		INTO events, n_events
		FROM (
			SELECT jsonb_build_object(
				'id', e.id,
				'projectId', e.project_id,
				'projectName', p.name,
				'kind', e.kind,
				'at', e.created_at,
				'actor', e.actor_label,
				'byYou', e.actor_user_id IS NOT DISTINCT FROM me,
				'subject', e.subject
			) AS ev, e.created_at, e.id
			FROM audit_event e
			JOIN project p ON p.id = e.project_id
			WHERE e.actor_user_id = me
			   OR (e.subject ? 'userId' AND e.subject->>'userId' = me::text)
			   OR (e.kind = 'note.deleted' AND e.subject->>'authorId' = me::text)
			ORDER BY e.created_at DESC, e.id DESC
			LIMIT max_events + 1
		) x;
		IF n_events > max_events THEN
			events := events - max_events;
		END IF;

		RETURN jsonb_build_object(
			'auditEvents', events,
			'auditEventsTruncated', n_events > max_events,
			'invites', (
				SELECT coalesce(jsonb_agg(jsonb_build_object(
					'id', i.id,
					'projectId', i.project_id,
					'projectName', p.name,
					'projectRole', i.project_role,
					'teamId', i.team_id,
					'teamName', t.name,
					'teamRole', i.team_role,
					'invitedBy', u.display_name,
					'language', i.locale,
					'createdAt', i.created_at,
					'lastSentAt', i.last_sent_at,
					'expiresAt', i.expires_at,
					'farms', (
						SELECT coalesce(jsonb_agg(jsonb_build_object('nodeId', n.id, 'name', n.name) ORDER BY n.name), '[]'::jsonb)
						FROM invite_node inn JOIN node n ON n.id = inn.node_id WHERE inn.invite_id = i.id
					)
				) ORDER BY i.created_at DESC), '[]'::jsonb)
				FROM invite i
				LEFT JOIN project p ON p.id = i.project_id
				LEFT JOIN team t ON t.id = i.team_id
				LEFT JOIN app_user u ON u.id = i.invited_by
				WHERE verified AND i.email = my_email
			),
			'notes', (
				SELECT coalesce(jsonb_agg(jsonb_build_object(
					'id', nt.id,
					'projectId', nt.project_id,
					'projectName', p.name,
					'body', nt.body,
					'visibility', nt.visibility,
					'nodeId', nt.node_id,
					'nodeName', n.name,
					'runId', nt.run_id,
					'settingKey', nt.setting_key,
					'createdAt', nt.created_at,
					'editedAt', nt.edited_at,
					'deletedAt', nt.deleted_at
				) ORDER BY nt.created_at DESC), '[]'::jsonb)
				FROM note nt
				JOIN project p ON p.id = nt.project_id
				LEFT JOIN node n ON n.id = nt.node_id
				WHERE nt.author_id = me
			),
			'signoffs', (
				SELECT coalesce(jsonb_agg(jsonb_build_object(
					'id', s.id,
					'projectId', s.project_id,
					'projectName', p.name,
					'runId', s.run_id,
					'fullName', s.full_name,
					'registrationBody', s.registration_body,
					'registrationNo', s.registration_no,
					'scope', s.scope,
					'statementVersion', s.statement_version,
					'statementSha256', s.statement_sha256,
					'disclaimerVersion', s.disclaimer_version,
					'signedAt', s.signed_at
				) ORDER BY s.signed_at DESC), '[]'::jsonb)
				FROM signoff s JOIN project p ON p.id = s.project_id
				WHERE s.user_id = me
			),
			'alertSubscriptions', (
				SELECT coalesce(jsonb_agg(jsonb_build_object(
					'projectId', a.project_id,
					'projectName', p.name,
					'kind', a.kind,
					'nodeId', a.node_id,
					'nodeName', n.name,
					'channel', a.channel,
					'mode', a.mode,
					'createdAt', a.created_at,
					'updatedAt', a.updated_at
				) ORDER BY p.name, a.kind), '[]'::jsonb)
				FROM alert_subscription a
				JOIN project p ON p.id = a.project_id
				LEFT JOIN node n ON n.id = a.node_id
				WHERE a.user_id = me
			),
			'reportSubscriptions', (
				SELECT coalesce(jsonb_agg(jsonb_build_object(
					'projectId', rs.project_id,
					'projectName', p.name,
					'frequency', rs.frequency,
					'weekday', rs.weekday,
					'monthDay', rs.month_day,
					'hour', rs.hour,
					'timezone', rs.timezone,
					'enabled', rs.enabled
				) ORDER BY p.name), '[]'::jsonb)
				FROM report_schedule_recipient r
				JOIN report_schedule rs ON rs.id = r.schedule_id
				JOIN project p ON p.id = rs.project_id
				WHERE r.user_id = me
			)
		);
	END
	$$;

REVOKE ALL ON FUNCTION app_subject_export() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_subject_export() TO water_app;
