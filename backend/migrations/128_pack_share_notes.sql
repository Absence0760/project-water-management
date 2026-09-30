-- 128_pack_share_notes — share links to an evidence pack, and comments on one
-- (roadmap WP-3.15, the pack half; issue #71; docs/evidence-pack.md § Sharing
-- and comments, docs/data-model.md § Share links, § Notes, docs/security.md
-- § Share links → Pack links, docs/api.md § Share, § Notes).
--
-- Expand-only. Every function, policy and constraint changed here starts from
-- its latest definition, named at each (115_scenario_share_notes for all of
-- them but app_subject_export's, which 115 also holds).
--
--  1. share_link: a third target kind, 'pack' (target_id an evidence_pack of
--     the link's project, checked on insert by share_link_target_check).
--       * Who makes one (app_share_link_creatable): an editor or the owner,
--         and only while the pack is `issued`. A draft is still changing; a
--         superseded or withdrawn pack is not what anyone should be sent. An
--         applicant (contributor) reads no pack yet (112), so makes no link
--         to one: that waits on "Applicants' access to their own
--         application's packs" (docs/followups.md).
--       * Who lists and revokes one (app_share_link_visible): the owner (every
--         link, as before) and the project's editors (they read every pack).
--       * The link stays when the pack is later superseded or withdrawn, and
--         then says so (below): it never goes quiet about a withdrawal.
--       * app_share_view / _series / _scenario answer only their own kinds
--         already (115): a pack link opens nothing there, and a baseline or
--         scenario link nothing here.
--
--  2. app_share_pack(p_hash): the public read of a pack link. SECURITY
--     DEFINER, built from allowlists, never wider than the pack itself:
--       - `verify`: exactly what GET /verify/:code already answers for the
--         pack (app_verify_pack, 122): status, version, dates, hashes, the
--         successor's hash, the withdrawal reason, methodology, errata and
--         signers. The link adds nothing to it but the figures below.
--       - `figures`, only while the pack is `issued`: a projection of the
--         pack's own frozen manifest (never the live model, runs or
--         settings), redacted as app_share_scenario redacts an application
--         (115): the report's title and mode, the two runs' dates, engine and
--         runoff model, the application's count of proposals and
--         assumptions; the river rows of page 1's change table (Reserve
--         months met per site, days below the EWR, no-flow days) with their
--         bands; each EWR site's Reserve compliance (the outlet unnamed: its
--         node may be a farm); the paired change by calendar month. The
--         volume rows (shortfall, outflow MAR) only at 5 or more farm
--         holders (app_share_series' k, counted now, from nobody's point of
--         view) and only when the report changed no baseline assumption.
--         Never a user's or farm's row, name or figures, the registered
--         volumes, the other applications, the works below which a site
--         sits, the settings, model, input diff or series hashes, the
--         applicant's statement, or any person but the signers verify
--         already names.
--       - A superseded or withdrawn pack answers `verify` and its comments,
--         and `figures` NULL: the link shows that it no longer stands (and
--         why, or which version replaced it), not the figures.
--       - A draft, or a pack withdrawn before it was issued, answers no row:
--         it was never public (as verify).
--       - `comments`: its `public_participation` notes with their authors'
--         display names, newest 500, as a scenario link's.
--       - `pack`: its id and project id (so a signed-in member can comment
--         from the page; an id grants nothing), title, mode and version.
--
--  3. note: a note may be about a pack (`pack_id`, cascade, covering index,
--     same-project trigger), one target at most (note_one_target). A pack
--     note is `team` (viewer+ who reads the pack: note_select, note_insert
--     through evidence_pack's own policy) or `public_participation`:
--
--         reads                                    writes
--         editor+ (they read every pack); its      any member contributor+ while the
--         author; any member contributor+ while    pack is open for comment
--         it is open, or once it was ever shared
--         and is superseded or withdrawn
--
--     "Open for comment" (app_pack_commentable): issued, with a live pack
--     link. Farmers read and write none. Its edits are kept in note_revision
--     (note_write_revision, now for pack notes too). A pack past draft is
--     never deleted (112), so its public comments stay with it.
--
--  4. app_subject_export: a note carries its pack id.

-- ---------------------------------------------------------------------------
-- 1. share_link: 'pack'
-- ---------------------------------------------------------------------------
ALTER TABLE share_link DROP CONSTRAINT share_link_target_kind_check;
ALTER TABLE share_link ADD CONSTRAINT share_link_target_kind_check CHECK (target_kind IN ('scenario', 'pack'));
COMMENT ON COLUMN share_link.target_kind IS
	'NULL: the project''s published baseline (025, WP-2.3). ''scenario'': one scenario, target_id (115, WP-3.15). ''pack'': one evidence pack (128). Fixed once made.';
COMMENT ON COLUMN share_link.target_id IS
	'The scenario (115) or evidence pack (128) a targeted link opens; no foreign key, since the kind picks the table: share_link_target_check checks it on insert. A deleted scenario leaves a dead link; a pack past draft is never deleted.';

-- share_link_target_check, from 115: a pack of the link's own project too.
CREATE OR REPLACE FUNCTION share_link_target_check() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NEW.target_kind = 'scenario' AND NEW.target_id IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM scenario s WHERE s.id = NEW.target_id AND s.project_id = NEW.project_id
		) THEN
			RAISE EXCEPTION 'scenario % belongs to a different project', NEW.target_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		IF NEW.target_kind = 'pack' AND NEW.target_id IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM evidence_pack p WHERE p.id = NEW.target_id AND p.project_id = NEW.project_id
		) THEN
			RAISE EXCEPTION 'evidence pack % belongs to a different project', NEW.target_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		RETURN NEW;
	END
	$$;

-- app_share_link_visible, from 115: a pack link is its project's editors'.
CREATE OR REPLACE FUNCTION app_share_link_visible(p_project uuid, p_kind text, p_target uuid, p_created_by uuid) RETURNS boolean
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF app_has_role(p_project, 'owner') THEN
			RETURN true;
		END IF;
		IF p_kind = 'scenario' THEN
			RETURN (app_has_role(p_project, 'editor') AND app_scenario_readable(p_target))
				OR (p_created_by = app_current_user_id() AND app_has_role(p_project, 'contributor'));
		END IF;
		IF p_kind = 'pack' THEN
			RETURN app_has_role(p_project, 'editor');
		END IF;
		RETURN false;
	END
	$$;

-- app_share_link_creatable, from 115: an editor links an issued pack of this project.
CREATE OR REPLACE FUNCTION app_share_link_creatable(p_project uuid, p_kind text, p_target uuid) RETURNS boolean
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_owner uuid;
	BEGIN
		IF p_kind IS NULL THEN
			RETURN app_has_role(p_project, 'owner');
		END IF;
		IF p_kind = 'scenario' THEN
			SELECT s.owner_user_id INTO v_owner FROM scenario s
			WHERE s.id = p_target AND s.project_id = p_project AND s.status IN ('submitted', 'decided') AND s.origin = 'applicant';
			IF NOT FOUND THEN
				RETURN false;
			END IF;
			RETURN (app_has_role(p_project, 'editor') AND app_scenario_readable(p_target))
				OR (v_owner = app_current_user_id() AND app_has_role(p_project, 'contributor'));
		END IF;
		IF p_kind = 'pack' THEN
			RETURN app_has_role(p_project, 'editor')
				AND EXISTS (SELECT 1 FROM evidence_pack p WHERE p.id = p_target AND p.project_id = p_project AND p.status = 'issued');
		END IF;
		RETURN false;
	END
	$$;
-- share_link_select / _insert / _update (115) call these two unchanged.

-- ---------------------------------------------------------------------------
-- 2. The public read of a pack link
-- ---------------------------------------------------------------------------

-- A band as a pack link shows it: its member count and percentiles, nothing else.
CREATE FUNCTION app_share_pack_band(p_band jsonb) RETURNS jsonb
	LANGUAGE sql IMMUTABLE SET search_path = public
	AS $$
	SELECT CASE WHEN jsonb_typeof(p_band) = 'object' THEN
		jsonb_build_object('n', p_band->'n', 'p5', p_band->'p5', 'p50', p_band->'p50', 'p95', p_band->'p95')
	END
	$$;
REVOKE ALL ON FUNCTION app_share_pack_band(jsonb) FROM PUBLIC, water_app;

-- What a pack link shows of an issued pack's frozen report (module comment,
-- 2): an allowlist of it. Volumes only when p_volumes. Called only from
-- app_share_pack; not callable by water_app.
CREATE FUNCTION app_share_pack_projection(p_report jsonb, p_volumes boolean) RETURNS jsonb
	LANGUAGE sql IMMUTABLE SET search_path = public
	AS $$
	WITH river AS (
		SELECT s, o FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_report->'river') = 'array' THEN p_report->'river' ELSE '[]'::jsonb END) WITH ORDINALITY x(s, o)
	), gauges AS (
		-- A site's name shows only when it is a gauge's, never the outlet's (its node may be a farm).
		SELECT s->>'name' AS name FROM river
		WHERE NOT coalesce((s->>'isOutlet')::boolean, false) AND jsonb_typeof(s->'name') = 'string'
		EXCEPT
		SELECT s->>'name' FROM river WHERE coalesce((s->>'isOutlet')::boolean, false)
	)
	SELECT jsonb_build_object(
		'identity', jsonb_build_object(
			'title', p_report->'identity'->'title',
			'mode', p_report->'mode',
			'baseline', jsonb_build_object(
				'startDate', p_report->'identity'->'baseline'->'startDate',
				'endDate', p_report->'identity'->'baseline'->'endDate',
				'engineVersion', p_report->'identity'->'baseline'->'engineVersion',
				'runoffModel', p_report->'identity'->'baseline'->'runoffModel'
			),
			'application', CASE WHEN jsonb_typeof(p_report->'identity'->'application') = 'object' THEN jsonb_build_object(
				'engineVersion', p_report->'identity'->'application'->'engineVersion',
				'proposals', p_report->'identity'->'application'->'proposals',
				'assumptions', p_report->'identity'->'application'->'assumptions'
			) END
		),
		'volumes', p_volumes,
		'rows', coalesce((
			SELECT jsonb_agg(jsonb_build_object(
				-- Not the row's label or basis: the page words each row by its id, and a reserve row's basis
				-- quotes the rule table's free-text source.
				'id', r->'id',
				'subject', CASE WHEN r->>'id' = 'reserve' AND r->>'subject' IN (SELECT name FROM gauges) THEN r->'subject' END,
				'unit', r->'unit',
				'higherIsWorse', r->'higherIsWorse',
				'baseline', r->'baseline',
				'application', r->'application',
				'change', CASE WHEN jsonb_typeof(r->'change') = 'object' THEN jsonb_build_object(
					'run', r->'change'->'run',
					'band', app_share_pack_band(r->'change'->'band'),
					'bandNote', r->'change'->'bandNote',
					'worse', CASE WHEN jsonb_typeof(r->'change'->'worse') = 'object'
						THEN jsonb_build_object('k', r->'change'->'worse'->'k', 'n', r->'change'->'worse'->'n') END
				) END,
				'notAssessed', r->'notAssessed',
				-- The reserve row's "met of months", the no-flow row's longest spell, the outflow's share of the natural MAR.
				'note', CASE WHEN r->>'id' IN ('reserve', 'noFlowDays', 'outflowMar') THEN r->'note' END
			) ORDER BY o)
			FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_report->'rows') = 'array' THEN p_report->'rows' ELSE '[]'::jsonb END) WITH ORDINALITY x(r, o)
			WHERE r->>'id' IN ('reserve', 'ewrDays', 'noFlowDays')
			   OR (p_volumes AND r->>'id' IN ('shortfall', 'outflowMar'))
		), '[]'::jsonb),
		'river', coalesce((
			SELECT jsonb_agg(jsonb_build_object(
				'name', CASE WHEN coalesce((s->>'isOutlet')::boolean, false) THEN NULL ELSE s->'name' END,
				'isOutlet', coalesce((s->>'isOutlet')::boolean, false),
				'category', s->'category',
				'monthsA', s->'monthsA',
				'rateA', s->'rateA',
				'rateB', s->'rateB',
				'longestA', s->'longestA',
				'longestB', s->'longestB',
				'lost', s->'lost',
				'gained', s->'gained'
			) ORDER BY o)
			FROM river
		), '[]'::jsonb),
		'byMonth', CASE WHEN jsonb_typeof(p_report->'byMonth') = 'array' THEN (
			SELECT coalesce(jsonb_agg(jsonb_build_object('month', m->'month', 'run', m->'run', 'band', app_share_pack_band(m->'band')) ORDER BY o), '[]'::jsonb)
			FROM jsonb_array_elements(p_report->'byMonth') WITH ORDINALITY x(m, o)
		) END,
		'disclaimerVersion', p_report->'verification'->'disclaimerVersion'
	)
	$$;
REVOKE ALL ON FUNCTION app_share_pack_projection(jsonb, boolean) FROM PUBLIC, water_app;

-- The public read of a pack link (module comment, 2). No row for an unknown,
-- revoked, expired or other-kind token, or a pack that was never issued.
-- Bumps last_used_at at most once an hour.
CREATE FUNCTION app_share_pack(p_hash bytea)
	RETURNS TABLE (
		pack jsonb,
		verify jsonb,
		figures jsonb,
		comments jsonb
	)
	LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	DECLARE
		v_link uuid;
		v_project uuid;
		v_target uuid;
		p evidence_pack;
		v_verify jsonb;
		v_k boolean;
	BEGIN
		SELECT l.id, l.project_id, l.target_id INTO v_link, v_project, v_target FROM share_link l
		WHERE l.token_hash = p_hash AND l.target_kind = 'pack' AND l.revoked_at IS NULL AND l.expires_at > now();
		IF v_link IS NULL THEN
			RETURN;
		END IF;
		SELECT ep.* INTO p FROM evidence_pack ep WHERE ep.id = v_target AND ep.project_id = v_project;
		IF NOT FOUND OR p.status = 'draft' OR p.issued_at IS NULL THEN
			RETURN;
		END IF;
		-- Exactly what the public verify lookup answers for it: the link widens none of that.
		v_verify := app_verify_pack(p.manifest_sha256);
		IF v_verify IS NULL THEN
			RETURN;
		END IF;
		-- app_share_series' k: at least 5 farm holders, counted from nobody's point of view.
		SELECT count(DISTINCT coalesce(
			(SELECT min(fl.user_id::text) FROM farm_link fl WHERE fl.node_id = n.id),
			'node:' || n.id::text
		)) >= 5 INTO v_k
		FROM node n WHERE n.project_id = v_project AND n.kind = 'farm';

		RETURN QUERY SELECT
			jsonb_build_object(
				-- Ids only so a signed-in member can comment from the page (POST …/notes); they grant nothing.
				'id', p.id,
				'projectId', p.project_id,
				'title', p.manifest->'report'->'identity'->'title',
				'mode', p.manifest->'report'->'mode',
				'version', p.version
			),
			v_verify,
			-- Figures only while the pack stands: a superseded or withdrawn one shows that, not its numbers.
			CASE WHEN p.status = 'issued' THEN app_share_pack_projection(
				p.manifest->'report',
				v_k AND coalesce((p.manifest->'report'->>'assumptionsChanged')::boolean, true) = false
			) END,
			coalesce((
				SELECT jsonb_agg(c.j ORDER BY c.created_at, c.id)
				FROM (
					SELECT n.id, n.created_at, jsonb_build_object(
						'body', n.body,
						'author', u.display_name,
						'createdAt', n.created_at,
						'editedAt', n.edited_at
					) AS j
					FROM note n LEFT JOIN app_user u ON u.id = n.author_id
					WHERE n.pack_id = p.id AND n.project_id = v_project
					  AND n.visibility = 'public_participation' AND n.deleted_at IS NULL
					-- The newest 500, shown oldest first.
					ORDER BY n.created_at DESC, n.id DESC
					LIMIT 500
				) c
			), '[]'::jsonb);
		UPDATE share_link SET last_used_at = now()
		WHERE id = v_link AND (last_used_at IS NULL OR last_used_at <= now() - interval '1 hour');
	END
	$$;
REVOKE ALL ON FUNCTION app_share_pack(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_share_pack(bytea) TO water_app;

-- ---------------------------------------------------------------------------
-- 3. note: pack targets
-- ---------------------------------------------------------------------------
ALTER TABLE note ADD COLUMN pack_id uuid REFERENCES evidence_pack(id) ON DELETE CASCADE;
CREATE INDEX note_pack_idx ON note (pack_id);
COMMENT ON COLUMN note.pack_id IS
	'The evidence pack a note is about (128, WP-3.15): `team` or `public_participation` only. Cascade: only a draft pack is ever deleted.';

-- note_one_target, from 115: five kinds.
ALTER TABLE note DROP CONSTRAINT note_one_target;
ALTER TABLE note ADD CONSTRAINT note_one_target CHECK (num_nonnulls(node_id, run_id, setting_key, scenario_id, pack_id) <= 1);
-- note_participation_on_scenario, from 115: `assessors` and `parties` still
-- need a scenario; public participation a scenario or a pack.
ALTER TABLE note DROP CONSTRAINT note_participation_on_scenario;
ALTER TABLE note ADD CONSTRAINT note_participation_on_scenario CHECK (
	(visibility NOT IN ('assessors', 'parties') OR scenario_id IS NOT NULL)
	AND (visibility <> 'public_participation' OR scenario_id IS NOT NULL OR pack_id IS NOT NULL)
);
-- A pack note is for the team or for public participation.
ALTER TABLE note ADD CONSTRAINT note_pack_audience CHECK (pack_id IS NULL OR visibility IN ('team', 'public_participation'));
COMMENT ON COLUMN note.visibility IS
	'team: viewers and above. farm: also the farmers linked to its node (037). assessors | parties | public_participation: a scenario note''s audiences (115, WP-3.15; app_scenario_note_visible); a pack note is team or public_participation (128; app_pack_note_visible).';

-- note_same_project, from 115: the pack too (assert_same_project's `%pack_id`, 112).
DROP TRIGGER note_same_project ON note;
CREATE TRIGGER note_same_project BEFORE INSERT OR UPDATE ON note
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('node_id', 'run_id', 'scenario_id', 'pack_id');

-- Open for public comment: an issued pack of this project with a live pack link.
CREATE FUNCTION app_pack_commentable(p_project uuid, p_pack uuid) RETURNS boolean
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		-- Members only: it says whether a pack is open, which no one else asks.
		IF app_project_role(p_project) IS NULL THEN
			RETURN false;
		END IF;
		RETURN EXISTS (SELECT 1 FROM evidence_pack p WHERE p.id = p_pack AND p.project_id = p_project AND p.status = 'issued')
			AND EXISTS (
				SELECT 1 FROM share_link l
				WHERE l.target_kind = 'pack' AND l.target_id = p_pack AND l.project_id = p_project AND l.revoked_at IS NULL AND l.expires_at > now()
			);
	END
	$$;

-- Who reads a pack's public comment (module comment, 3). Its author always does.
CREATE FUNCTION app_pack_note_visible(p_project uuid, p_pack uuid, p_author uuid) RETURNS boolean
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		-- A member's question about a pack of this project only.
		IF app_project_role(p_project) IS NULL
			OR NOT EXISTS (SELECT 1 FROM evidence_pack p WHERE p.id = p_pack AND p.project_id = p_project) THEN
			RETURN false;
		END IF;
		IF p_author IS NOT NULL AND p_author = app_current_user_id() THEN
			RETURN true;
		END IF;
		IF app_has_role(p_project, 'editor') THEN
			RETURN true;
		END IF;
		RETURN app_has_role(p_project, 'contributor') AND (
			app_pack_commentable(p_project, p_pack)
			-- The record of a closed comment period: once shared, it stays readable to the members who could comment.
			OR EXISTS (
				SELECT 1 FROM evidence_pack p
				WHERE p.id = p_pack AND p.project_id = p_project AND p.status IN ('superseded', 'withdrawn')
				  AND EXISTS (SELECT 1 FROM share_link l WHERE l.target_kind = 'pack' AND l.target_id = p_pack AND l.project_id = p_project)
			)
		);
	END
	$$;

-- Who may post one: any member contributor+, while it is open for comment.
CREATE FUNCTION app_pack_note_writable(p_project uuid, p_pack uuid) RETURNS boolean
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		RETURN app_has_role(p_project, 'contributor') AND app_pack_commentable(p_project, p_pack);
	END
	$$;

-- note_select, from 115: a `team` note on a pack only where the pack is read
-- (evidence_pack_select applies inside the subquery).
DROP POLICY note_select ON note;
CREATE POLICY note_select ON note FOR SELECT
	USING (
		app_has_role(project_id, 'viewer')
		AND visibility IN ('team', 'farm')
		AND (deleted_at IS NULL OR author_id = app_current_user_id() OR app_has_role(project_id, 'editor'))
		AND (run_id IS NULL OR run_id NOT IN (SELECT app_hidden_scenario_runs()))
		AND (scenario_id IS NULL OR app_scenario_readable(scenario_id))
		AND (pack_id IS NULL OR EXISTS (SELECT 1 FROM evidence_pack p WHERE p.id = pack_id))
	);
-- ORed with note_select, note_select_farmer (037/073) and note_select_scenario (115), all unchanged.
CREATE POLICY note_select_pack ON note FOR SELECT
	USING (
		pack_id IS NOT NULL
		AND visibility = 'public_participation'
		AND (deleted_at IS NULL OR author_id = app_current_user_id() OR app_has_role(project_id, 'editor'))
		AND app_pack_note_visible(project_id, pack_id, author_id)
	);

-- note_insert, from 115: a pack's team note where the pack is read, and its public comment while open.
DROP POLICY note_insert ON note;
CREATE POLICY note_insert ON note FOR INSERT
	WITH CHECK (
		author_id = app_current_user_id() AND deleted_at IS NULL AND deleted_by IS NULL AND edited_at IS NULL
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
-- note_update (037) is unchanged: the author or an editor, of a note they read.

-- note_write_revision's trigger, from 115: a pack note's edits are kept too (same function).
DROP TRIGGER note_write_revision ON note;
CREATE TRIGGER note_write_revision AFTER UPDATE OF body ON note
	FOR EACH ROW WHEN (OLD.body IS DISTINCT FROM NEW.body AND (NEW.scenario_id IS NOT NULL OR NEW.pack_id IS NOT NULL))
	EXECUTE FUNCTION note_write_revision();
COMMENT ON TABLE note_revision IS
	'Each earlier text of a scenario or pack note, written on every edit (115, 128; WP-3.15): a participation record keeps its history. Read as the note is read; written only by note_write_revision.';

-- ---------------------------------------------------------------------------
-- 4. app_subject_export, from 115_scenario_share_notes.sql: a note carries
-- its pack (same signature, SECURITY DEFINER and search_path; 054's REVOKE /
-- GRANT stand, CREATE OR REPLACE keeps them).
-- ---------------------------------------------------------------------------
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
					'scenarioId', nt.scenario_id,
					'packId', nt.pack_id,
					'createdAt', nt.created_at,
					'editedAt', nt.edited_at,
					'deletedAt', nt.deleted_at,
					'revisions', (
						SELECT coalesce(jsonb_agg(jsonb_build_object(
							'body', rv.body,
							'writtenAt', rv.written_at,
							'editedAt', rv.edited_at
						) ORDER BY rv.edited_at, rv.id), '[]'::jsonb)
						FROM note_revision rv WHERE rv.note_id = nt.id
					)
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
					'packId', s.pack_id,
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
