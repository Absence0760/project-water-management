-- 092_signoff_registration — the signer's registration category and field on
-- a professional sign-off (issue #47; docs/data-model.md § Sign-offs,
-- docs/security.md § Liability).
--
-- Expand-only:
--
--   1. signoff.registration_category and signoff.registration_field: the
--      category (e.g. 'pr_sci_nat', 'pr_eng') and the field of practice
--      (SACNASP, e.g. 'water_resources') or discipline (ECSA, e.g. 'civil')
--      the signer chose. Both statutes register a person in a category, and
--      SACNASP also in a field (Natural Scientific Professions Act s 18(1),
--      s 20(2)(a); Engineering Profession Act s 18(1)). From signoff-3,
--      registration_body holds a code too ('sacnasp' or 'ecsa').
--      Nullable: rows signed under signoff-1 and signoff-2 keep their
--      free-text body and NULL here, and the report prints "category and
--      field not recorded" for them. The table is insert-only (036), so a
--      CHECK conditioned on the statement version binds every new row and
--      leaves the old ones as they were recorded.
--      The allowed values live in the engine (liability/registration.ts),
--      not here: the draft Natural Scientific Professions Bill (2026) will
--      re-prescribe categories, and that should be a code change. The
--      database checks only their shape. The route refuses a candidate,
--      certificated or specified category (400).
--
--   2. app_subject_export(): the data-subject export's signoffs section
--      carries the two new columns. Latest body: 054_subject_export, kept as
--      it was otherwise (same signature, SECURITY DEFINER, search_path; the
--      REVOKE / GRANT EXECUTE of 054 stand, CREATE OR REPLACE keeps them).
--
-- RLS and grants are unchanged: water_app keeps SELECT and INSERT on signoff
-- (036), which cover the new columns. No new foreign key.

ALTER TABLE signoff
	ADD COLUMN registration_category text CHECK (registration_category ~ '^[a-z_]{1,40}$'),
	ADD COLUMN registration_field text CHECK (registration_field ~ '^[a-z_]{1,40}$');

ALTER TABLE signoff ADD CONSTRAINT signoff_registration_recorded CHECK (
	statement_version IN ('signoff-1', 'signoff-2')
	OR (registration_body IN ('sacnasp', 'ecsa') AND registration_category IS NOT NULL AND registration_field IS NOT NULL)
);

COMMENT ON COLUMN signoff.registration_category IS
	'The signer''s registration category code (engine liability/registration.ts), from signoff-3; NULL on signoff-1 and -2 rows (092_signoff_registration).';
COMMENT ON COLUMN signoff.registration_field IS
	'The signer''s SACNASP field of practice or ECSA discipline code (engine liability/registration.ts), from signoff-3; NULL on signoff-1 and -2 rows (092_signoff_registration).';

CREATE OR REPLACE FUNCTION app_subject_export() RETURNS jsonb
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
					'registrationCategory', s.registration_category,
					'registrationField', s.registration_field,
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
