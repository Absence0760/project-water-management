-- 164_public_participation — public participation without a project role:
-- the objection warning's notice details, link participants, the register
-- opt-in and the reg 19 export (licensing positions, items 7 and 9–11 of the
-- build list; provisional position, pre-counsel research, 2026-10-01;
-- docs/scenarios.md § Sharing and comments, docs/security.md § Share links
-- → Link participants, docs/data-model.md § Notes, docs/api.md § Share).
--
-- Expand-only. Every policy changed here starts from its latest definition,
-- named at it (note_insert: 128_pack_share_notes).
--
--  1. scenario.objection_address / objection_closing_date: where and by when
--     written objections go (GN R267 reg 17(4)(b)(vi)–(vii)), as the applicant
--     copies them from their notice. Optional, an application's only, and
--     frozen once it is submitted (scenario_objection_frozen, its own
--     trigger: scenario_guard is left alone). A comment in the app is not a
--     written objection (NWA s148(1)(f)); the share pages and every comment
--     box say so, and print these two when they are given.
--
--  2. Link participants. Until now only a project member (contributor or
--     above) could comment for public participation, so an NGO had to be
--     made a viewer, who reads every farm's figures (POPIA s10). Now any
--     signed-in account holding a live link to a submitted or decided
--     application, or to an issued evidence pack, may post one
--     `public_participation` comment at a time on it, with no project role:
--       - only through app_share_comment(token hash, body, consent), a
--         SECURITY DEFINER function scoped to that one live link: it writes
--         the note on the link's own target, as the signed-in user, and
--         nothing else. No new grant, no new policy reaches note for them;
--       - note.share_link_id records the link it came through (SET NULL: a
--         link is revoked, never deleted, 025; covering index), and
--         note_insert now refuses one from water_app, so only that function
--         stamps it;
--       - at most 10 such comments an hour per account (counted in the
--         function, under a lock on the account's row), on top of the WAF's
--         per-address limit on /api/;
--       - a link participant reads what the link shows (the comments with
--         their authors' names, as before) and nothing else of the project.
--         They can't edit or withdraw a comment through the link; their own
--         comments are in their data export and lose their name when the
--         account is deleted (note.author_id SET NULL, 037).
--
--  3. note.register_consent: the commenter ticked "give my name and email to
--     the applicant for the register of interested and affected parties
--     (GN R267 reg 18)". Public participation comments only; fixed at
--     insert (water_app's UPDATE grant on note is column by column, 037).
--
--  4. app_participation_export(project, scenario): the reg 19 material for
--     one application: every public comment on it and on its packs, with the
--     author's display name, dates, earlier texts and moderation state, the
--     email only where the commenter consented, the links it was shared by
--     and the decision. For the application's owner and the editors who read
--     it; NULL for anyone else. A removed comment's text goes to editors only.
--
--  5. app_share_objection(token hash): the notice details for a live link's
--     application (a pack link: its application's), so the share pages print
--     them without app_share_scenario / app_share_pack changing.
--
--  6. app_subject_participation(): a person's own public comments with how
--     they were posted and whether they consented, for the data export.

-- ---------------------------------------------------------------------------
-- 1. Where objections go
-- ---------------------------------------------------------------------------
ALTER TABLE scenario
	ADD COLUMN objection_address text CHECK (objection_address IS NULL OR (objection_address = btrim(objection_address) AND char_length(objection_address) BETWEEN 1 AND 500)),
	ADD COLUMN objection_closing_date date,
	ADD CONSTRAINT scenario_objection_application CHECK ((objection_address IS NULL AND objection_closing_date IS NULL) OR origin = 'applicant');
COMMENT ON COLUMN scenario.objection_address IS
	'Where written objections go, as the application''s notice gives it (GN R267 reg 17(4)(b)(vii); 164). The applicant''s, optional, frozen once submitted. Printed beside the warning that a comment in the app is not an objection.';
COMMENT ON COLUMN scenario.objection_closing_date IS
	'The date before which written objections may be lodged, as the notice gives it (reg 17(4)(b)(vi); 164). Frozen once submitted.';

-- The notice details are part of what was submitted: fixed until it is a draft again (withdraw, reopen).
CREATE FUNCTION scenario_objection_frozen() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF OLD.status <> 'draft'
		   AND (NEW.objection_address IS DISTINCT FROM OLD.objection_address OR NEW.objection_closing_date IS DISTINCT FROM OLD.objection_closing_date) THEN
			RAISE EXCEPTION 'a % application''s notice details are frozen', OLD.status USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER scenario_objection_frozen BEFORE UPDATE OF objection_address, objection_closing_date ON scenario
	FOR EACH ROW EXECUTE FUNCTION scenario_objection_frozen();

-- ---------------------------------------------------------------------------
-- 2–3. note: the link it came through, and the register opt-in
-- ---------------------------------------------------------------------------
ALTER TABLE note
	ADD COLUMN share_link_id uuid REFERENCES share_link(id) ON DELETE SET NULL,
	ADD COLUMN register_consent boolean NOT NULL DEFAULT false,
	ADD CONSTRAINT note_share_link_public CHECK (share_link_id IS NULL OR visibility = 'public_participation'),
	ADD CONSTRAINT note_register_consent_public CHECK (NOT register_consent OR visibility = 'public_participation');
CREATE INDEX note_share_link_idx ON note (share_link_id);
COMMENT ON COLUMN note.share_link_id IS
	'The share link a public comment was posted through (164): set only by app_share_comment, never by water_app. NULL: posted by a member in the app.';
COMMENT ON COLUMN note.register_consent IS
	'The commenter agreed to give their name and email to the applicant for the register of interested and affected parties (GN R267 reg 18; 164). Fixed at insert.';

-- note_insert, from 128_pack_share_notes.sql: water_app never names a share link (only app_share_comment does).
DROP POLICY note_insert ON note;
CREATE POLICY note_insert ON note FOR INSERT
	WITH CHECK (
		author_id = app_current_user_id() AND deleted_at IS NULL AND deleted_by IS NULL AND edited_at IS NULL
		AND share_link_id IS NULL
		AND (
			(app_has_role(project_id, 'viewer') AND visibility IN ('team', 'farm')
				AND (scenario_id IS NULL OR app_scenario_readable(scenario_id))
				AND (pack_id IS NULL OR EXISTS (SELECT 1 FROM evidence_pack p WHERE p.id = pack_id)))
			OR (visibility = 'farm' AND node_id IN (SELECT app_farm_nodes(project_id)))
			OR (scenario_id IS NOT NULL AND visibility IN ('assessors', 'parties', 'public_participation')
				AND app_scenario_note_writable(project_id, scenario_id, visibility))
			OR (pack_id IS NOT NULL AND visibility = 'public_participation'
				AND app_pack_note_writable(project_id, pack_id))
		)
	);

-- A public comment through a live link (module comment, 2). Returns
--   {"outcome": "posted", "note": {id, body, author, createdAt, editedAt}}
--   {"outcome": "throttled", "seconds": n}   10 in the last hour already
--   NULL                                       no such live link, a baseline
--                                              link, or its target isn't open
-- and raises for no signed-in user or a body the route should have refused.
CREATE FUNCTION app_share_comment(p_hash bytea, p_body text, p_register boolean) RETURNS jsonb
	LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
		v_link uuid;
		v_project uuid;
		v_kind text;
		v_target uuid;
		v_oldest timestamptz;
		v_count integer;
		v_note uuid;
	BEGIN
		IF uid IS NULL THEN
			RAISE EXCEPTION 'app_share_comment: a comment needs a signed-in person' USING ERRCODE = '42501';
		END IF;
		IF p_body IS NULL OR p_body <> btrim(p_body) OR char_length(p_body) NOT BETWEEN 1 AND 4000 THEN
			RAISE EXCEPTION 'app_share_comment: a comment is 1 to 4000 characters, trimmed' USING ERRCODE = '22023';
		END IF;
		SELECT l.id, l.project_id, l.target_kind, l.target_id INTO v_link, v_project, v_kind, v_target FROM share_link l
		WHERE l.token_hash = p_hash AND l.target_kind IN ('scenario', 'pack') AND l.revoked_at IS NULL AND l.expires_at > now();
		IF v_link IS NULL THEN
			RETURN NULL;
		END IF;
		-- Open for comment through this link: a submitted or decided application (what app_share_scenario
		-- shows), or an issued pack (a superseded or withdrawn one shows that it no longer stands).
		IF v_kind = 'scenario' AND NOT EXISTS (
			SELECT 1 FROM scenario s WHERE s.id = v_target AND s.project_id = v_project AND s.status IN ('submitted', 'decided') AND s.origin = 'applicant'
		) THEN
			RETURN NULL;
		END IF;
		IF v_kind = 'pack' AND NOT EXISTS (
			SELECT 1 FROM evidence_pack p WHERE p.id = v_target AND p.project_id = v_project AND p.status = 'issued'
		) THEN
			RETURN NULL;
		END IF;
		-- The per-account cap, counted under a lock on the account's row so two posts at once can't both pass.
		PERFORM 1 FROM app_user WHERE id = uid FOR UPDATE;
		SELECT count(*), min(created_at) INTO v_count, v_oldest FROM (
			SELECT n.created_at FROM note n
			WHERE n.author_id = uid AND n.share_link_id IS NOT NULL AND n.created_at > now() - interval '1 hour'
			ORDER BY n.created_at DESC LIMIT 10
		) x;
		IF v_count >= 10 THEN
			RETURN jsonb_build_object('outcome', 'throttled', 'seconds', greatest(1, ceil(extract(epoch FROM v_oldest + interval '1 hour' - now())))::integer);
		END IF;
		INSERT INTO note (project_id, author_id, body, scenario_id, pack_id, visibility, share_link_id, register_consent)
		VALUES (
			v_project, uid, p_body,
			CASE WHEN v_kind = 'scenario' THEN v_target END,
			CASE WHEN v_kind = 'pack' THEN v_target END,
			'public_participation', v_link, coalesce(p_register, false)
		)
		RETURNING id INTO v_note;
		RETURN (
			SELECT jsonb_build_object('outcome', 'posted', 'note', jsonb_build_object(
				'id', n.id, 'body', n.body, 'author', u.display_name, 'createdAt', n.created_at, 'editedAt', n.edited_at
			))
			FROM note n LEFT JOIN app_user u ON u.id = n.author_id WHERE n.id = v_note
		);
	END
	$$;
COMMENT ON FUNCTION app_share_comment(bytea, text, boolean) IS
	'A public-participation comment through one live share link, by the signed-in person, with no project role (164): the only writer of note.share_link_id. 10 an hour per account.';
REVOKE ALL ON FUNCTION app_share_comment(bytea, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_share_comment(bytea, text, boolean) TO water_app;

-- ---------------------------------------------------------------------------
-- 4. The reg 19 material for one application
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_participation_export(p_project uuid, p_scenario uuid) RETURNS jsonb
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
		s scenario;
		editor boolean;
	BEGIN
		IF uid IS NULL OR app_project_role(p_project) IS NULL THEN
			RETURN NULL;
		END IF;
		SELECT sc.* INTO s FROM scenario sc WHERE sc.id = p_scenario AND sc.project_id = p_project AND sc.origin = 'applicant';
		IF NOT FOUND THEN
			RETURN NULL;
		END IF;
		editor := app_has_role(p_project, 'editor') AND app_scenario_readable(p_scenario);
		-- Its owner (reg 18–19 put the register and the report on the applicant) and the editors who read it.
		IF NOT editor AND NOT (s.owner_user_id = uid AND app_has_role(p_project, 'contributor')) THEN
			RETURN NULL;
		END IF;
		RETURN jsonb_build_object(
			'application', jsonb_build_object(
				'id', s.id,
				'name', s.name,
				'status', s.status,
				'submittedAt', s.submitted_at,
				'decidedAt', s.decided_at,
				'outcome', s.outcome,
				'objectionAddress', s.objection_address,
				'objectionClosingDate', s.objection_closing_date
			),
			-- How it was put out for comment: its links and its packs' links (never a token or who made one).
			'links', coalesce((
				SELECT jsonb_agg(jsonb_build_object(
					'target', CASE WHEN l.target_kind = 'scenario' THEN 'application' ELSE 'pack' END,
					'packVersion', p.version,
					'createdAt', l.created_at,
					'expiresAt', l.expires_at,
					'revokedAt', l.revoked_at
				) ORDER BY l.created_at, l.id)
				FROM share_link l LEFT JOIN evidence_pack p ON l.target_kind = 'pack' AND p.id = l.target_id
				WHERE l.project_id = p_project
				  AND ((l.target_kind = 'scenario' AND l.target_id = p_scenario)
				    OR (l.target_kind = 'pack' AND p.scenario_id = p_scenario))
			), '[]'::jsonb),
			'comments', coalesce((
				SELECT jsonb_agg(jsonb_build_object(
					'id', n.id,
					'target', CASE WHEN n.pack_id IS NULL THEN 'application' ELSE 'pack' END,
					'packVersion', p.version,
					'author', u.display_name,
					-- Only where the commenter agreed (reg 18), and only while the account exists.
					'email', CASE WHEN n.register_consent THEN u.email::text END,
					'registerConsent', n.register_consent,
					'viaLink', n.share_link_id IS NOT NULL,
					'createdAt', n.created_at,
					'editedAt', n.edited_at,
					'state', CASE WHEN n.deleted_at IS NULL THEN 'shown'
						WHEN n.deleted_by IS NOT NULL AND n.deleted_by = n.author_id THEN 'withdrawn'
						ELSE 'removed' END,
					'deletedAt', n.deleted_at,
					-- A withdrawn or removed comment's words go to the editors only (037: a deleted note is theirs to read).
					'body', CASE WHEN n.deleted_at IS NULL OR editor THEN n.body END,
					'revisions', CASE WHEN n.deleted_at IS NULL OR editor THEN coalesce((
						SELECT jsonb_agg(jsonb_build_object('body', rv.body, 'writtenAt', rv.written_at, 'editedAt', rv.edited_at) ORDER BY rv.edited_at, rv.id)
						FROM note_revision rv WHERE rv.note_id = n.id
					), '[]'::jsonb) ELSE '[]'::jsonb END
				) ORDER BY n.created_at, n.id)
				FROM note n
				LEFT JOIN app_user u ON u.id = n.author_id
				LEFT JOIN evidence_pack p ON p.id = n.pack_id
				WHERE n.project_id = p_project AND n.visibility = 'public_participation'
				  AND (n.scenario_id = p_scenario OR p.scenario_id = p_scenario)
			), '[]'::jsonb)
		);
	END
	$$;
COMMENT ON FUNCTION app_participation_export(uuid, uuid) IS
	'The public-participation record of one application (GN R267 reg 19(1)(a); 164): its and its packs'' public comments with author names, dates, earlier texts and moderation state, emails only where the commenter consented (reg 18). For its owner and the editors who read it; NULL otherwise.';
REVOKE ALL ON FUNCTION app_participation_export(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_participation_export(uuid, uuid) TO water_app;

-- ---------------------------------------------------------------------------
-- 5. The notice details through a live link
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_share_objection(p_hash bytea) RETURNS jsonb
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	SELECT jsonb_build_object('address', s.objection_address, 'closingDate', s.objection_closing_date)
	FROM share_link l
	LEFT JOIN evidence_pack p ON l.target_kind = 'pack' AND p.id = l.target_id AND p.project_id = l.project_id AND p.status <> 'draft'
	JOIN scenario s ON s.project_id = l.project_id AND s.origin = 'applicant' AND s.status IN ('submitted', 'decided')
		AND s.id = CASE WHEN l.target_kind = 'scenario' THEN l.target_id ELSE p.scenario_id END
	WHERE l.token_hash = p_hash AND l.target_kind IN ('scenario', 'pack') AND l.revoked_at IS NULL AND l.expires_at > now()
	$$;
COMMENT ON FUNCTION app_share_objection(bytea) IS
	'Where and by when written objections go, for a live scenario link''s application or a pack link''s (164). NULL for any other token.';
REVOKE ALL ON FUNCTION app_share_objection(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_share_objection(bytea) TO water_app;

-- ---------------------------------------------------------------------------
-- 6. A person's own public comments, for their data export
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_subject_participation() RETURNS jsonb
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	SELECT coalesce(jsonb_agg(jsonb_build_object(
		'noteId', n.id,
		'projectId', n.project_id,
		'projectName', pr.name,
		'scenarioId', n.scenario_id,
		'packId', n.pack_id,
		'viaLink', n.share_link_id IS NOT NULL,
		'registerConsent', n.register_consent,
		'createdAt', n.created_at
	) ORDER BY n.created_at DESC, n.id), '[]'::jsonb)
	FROM note n JOIN project pr ON pr.id = n.project_id
	WHERE app_current_user_id() IS NOT NULL AND n.author_id = app_current_user_id() AND n.visibility = 'public_participation'
	$$;
COMMENT ON FUNCTION app_subject_participation() IS
	'The signed-in person''s own public comments: how each was posted (through a link or as a member) and whether they agreed to the I&AP register (164). Their bodies are in app_subject_export''s notes.';
REVOKE ALL ON FUNCTION app_subject_participation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_subject_participation() TO water_app;
