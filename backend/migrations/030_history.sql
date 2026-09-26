-- 030_history — change history and audit log, with restore (roadmap WP-2.4,
-- issue #28; docs/data-model.md § Change history, docs/security.md § Change
-- history and audit log).
--
-- Answers "who changed which parameter, when, and why did the result
-- change?", and keeps what's needed to put an earlier version back.
--
-- * model_revision: the project's inputs ({ settings, model }, the shape of
--   model_run.inputs minus series) after each change, with the engine's
--   diffInputs lines against the state before it and an optional reason.
--   Recorded at the **document level, in the same transaction**, by the
--   routes that save (backend/src/history/record.ts), never by row triggers:
--   saveModel rewrites the whole document on every save (it nulls every
--   downstream link, renames every node and crop, deletes and re-inserts
--   every crop area), so a row trigger would log hundreds of meaningless
--   changes per save. A save that changes nothing records nothing.
-- * series_revision: a series' previous values, written before a replace, a
--   delete, a merge from the UI or a restore, so the values can be put back.
--   Not for data-feed merges (append-mostly; they would bloat it). Kept: the
--   newest 5 per (project, kind, name), none older than 180 days, trimmed on
--   insert by series_revision_trim (SECURITY DEFINER: water_app can't delete).
-- * audit_event: everything else a person (or, later, an API key) did to the
--   project: members, farmers, invites, publications, share links, API keys,
--   series, runs, feeds, restores. One row per event, with a snapshot of the
--   actor's display name so the log reads the same after a rename or an
--   account deletion.
--
-- All three are append-only for the app: water_app may SELECT and INSERT,
-- and there is no UPDATE or DELETE policy for anyone (catalogue.db.test.ts
-- APPEND_ONLY). Rows go only with their project (cascade), and
-- series_revision rows through its retention trim.
--
-- Change sets: withUser (backend/src/db/tx.ts) sets app.change_set_id to a
-- fresh UUID per transaction, and every row here defaults its change_set to
-- it, so the rows one request wrote group together (a model restore and the
-- farmer links it dropped, say).
--
-- Read access: viewers and above. Farmers see nothing of history (D4 in
-- docs/roadmap/step-2-shared-catchment.md; "my own farm's parameter history"
-- is a candidate for later).

-- When history starts for a project: its creation, or this migration for a
-- project that existed before it. The History tab's empty state says so.
ALTER TABLE project ADD COLUMN history_since timestamptz NOT NULL DEFAULT now();

-- The transaction's change set (app.change_set_id, set by withUser); NULL
-- outside a request (a migration, a SECURITY DEFINER job function).
CREATE FUNCTION app_change_set_id() RETURNS uuid
	LANGUAGE sql STABLE SET search_path = public
	AS $$ SELECT nullif(current_setting('app.change_set_id', true), '')::uuid $$;

-- ---------------------------------------------------------------------------
-- Model revisions
-- ---------------------------------------------------------------------------
CREATE TABLE model_revision (
	id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id    uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	created_by    uuid REFERENCES app_user(id) ON DELETE SET NULL,
	created_at    timestamptz NOT NULL DEFAULT now(),
	-- What wrote it: PUT /model, PATCH /projects/:id with settings, a restore,
	-- an import or copy (the project's first state), or 'baseline': the state
	-- before the first recorded change of a project that predates history, so
	-- that state can be restored too.
	source        text NOT NULL CHECK (source IN ('baseline', 'model_put', 'settings_patch', 'restore', 'import', 'copy')),
	-- The optional "why" from the save bar (or a restore's reason).
	reason        text CHECK (length(reason) <= 500),
	-- { settings, model } after the change: model_run.inputs' shape minus series.
	snapshot      jsonb NOT NULL,
	-- InputChange[] (engine diffInputs) from the state before the change.
	changes       jsonb NOT NULL DEFAULT '[]'::jsonb,
	-- Nodes the change touched (their row, crop areas, land cover or a
	-- transfer at either end), for the History tab's farm filter.
	node_ids      uuid[] NOT NULL DEFAULT '{}',
	-- A restore: the revision it put back (NULL for a run's inputs, or when
	-- restoring from a run: see restored_from_run).
	restored_from bigint REFERENCES model_revision(id),
	-- A restore of a run's inputs: the run (no foreign key: the run may be
	-- trimmed later, the record of the restore stays).
	restored_from_run uuid,
	change_set    uuid DEFAULT app_change_set_id()
);
COMMENT ON TABLE model_revision IS
	'The project''s { settings, model } after each change, with its diffInputs lines and reason (030_history, WP-2.4). Append-only.';
CREATE INDEX model_revision_project_idx ON model_revision (project_id, created_at DESC, id DESC);
CREATE INDEX model_revision_created_by_idx ON model_revision (created_by);
CREATE INDEX model_revision_restored_from_idx ON model_revision (restored_from);
CREATE INDEX model_revision_node_ids_idx ON model_revision USING gin (node_ids);

-- ---------------------------------------------------------------------------
-- Series revisions
-- ---------------------------------------------------------------------------
CREATE TABLE series_revision (
	id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id    uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- The series' id when this was written. No foreign key on purpose: after
	-- a delete the id is how GET /series/:seriesId/revisions still finds the
	-- values to restore (a SET NULL would lose the link).
	series_id     uuid NOT NULL,
	kind          text NOT NULL,
	name          text NOT NULL,
	unit          text NOT NULL,
	start_date    date NOT NULL,
	"values"      double precision[] NOT NULL,
	-- SHA-256 hex of seriesDigest(values), as in a run's input snapshot.
	values_sha256 text NOT NULL CHECK (values_sha256 ~ '^[0-9a-f]{64}$'),
	created_by    uuid REFERENCES app_user(id) ON DELETE SET NULL,
	created_at    timestamptz NOT NULL DEFAULT now(),
	-- Why the values were about to change.
	reason        text NOT NULL CHECK (reason IN ('replace', 'delete', 'manual_merge')),
	change_set    uuid DEFAULT app_change_set_id()
);
COMMENT ON TABLE series_revision IS
	'A series'' values before a replace, delete, UI merge or restore (030_history, WP-2.4). Newest 5 per (project, kind, name), at most 180 days old. Append-only for the app.';
CREATE INDEX series_revision_series_idx ON series_revision (project_id, kind, name, created_at DESC);
CREATE INDEX series_revision_series_id_idx ON series_revision (series_id);
CREATE INDEX series_revision_created_by_idx ON series_revision (created_by);

-- Retention, on every insert: the newest 5 of this series (project, kind,
-- name), and nothing of the project older than 180 days. SECURITY DEFINER
-- because water_app may not delete revisions: the limit is the schema's rule,
-- not the caller's choice. Same numbers as SERIES_REVISIONS_KEPT and
-- SERIES_REVISION_MAX_DAYS in backend/src/history/record.ts.
CREATE FUNCTION series_revision_trim() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		DELETE FROM series_revision WHERE id IN (
			SELECT id FROM series_revision
			WHERE project_id = NEW.project_id AND kind = NEW.kind AND name = NEW.name
			ORDER BY created_at DESC, id DESC
			OFFSET 5
		);
		DELETE FROM series_revision WHERE project_id = NEW.project_id AND created_at < now() - interval '180 days';
		RETURN NULL;
	END
	$$;
CREATE TRIGGER series_revision_trim AFTER INSERT ON series_revision
	FOR EACH ROW EXECUTE FUNCTION series_revision_trim();

-- ---------------------------------------------------------------------------
-- Audit events
-- ---------------------------------------------------------------------------
CREATE TABLE audit_event (
	id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id       uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	actor_user_id    uuid REFERENCES app_user(id) ON DELETE SET NULL,
	-- The API key that acted (WP-3.x). No keys exist yet; no foreign key until
	-- their table does.
	actor_api_key_id uuid,
	-- The actor's display name (or the key's name) when it happened.
	actor_label      text NOT NULL CHECK (length(actor_label) <= 200),
	-- '<noun>.<verb>' (member.added, farmer.unlinked, series.replaced, …) or
	-- 'restore' (docs/data-model.md § Change history lists them).
	kind             text NOT NULL CHECK (kind ~ '^[a-z_]+(\.[a-z_]+)?$'),
	-- What it was about, in the event's own shape (ids, names, counts, dates);
	-- never a secret, a token or series values.
	subject          jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at       timestamptz NOT NULL DEFAULT now(),
	change_set       uuid DEFAULT app_change_set_id()
);
COMMENT ON TABLE audit_event IS
	'Who did what to a project, other than model and settings edits (030_history, WP-2.4). Append-only.';
CREATE INDEX audit_event_project_idx ON audit_event (project_id, created_at DESC, id DESC);
CREATE INDEX audit_event_kind_idx ON audit_event (project_id, kind);
CREATE INDEX audit_event_actor_idx ON audit_event (actor_user_id);

-- ---------------------------------------------------------------------------
-- An invite accepted (app_accept_invites, from its latest definition in
-- 004_email.sql) is a member added: recorded here, where it happens, as the
-- person who joined. The body is 004's with the project insert's RETURNING
-- feeding audit_event.
-- ---------------------------------------------------------------------------
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
		INSERT INTO team_member (team_id, user_id, role)
			SELECT team_id, p_user, team_role FROM invite
			WHERE email = v_email AND team_id IS NOT NULL AND expires_at > now()
			ON CONFLICT (team_id, user_id) DO NOTHING;
		GET DIAGNOSTICS n_team = ROW_COUNT;
		DELETE FROM invite WHERE email = v_email AND expires_at > now();
		RETURN n_project + n_team;
	END
	$$;

-- ---------------------------------------------------------------------------
-- Row-level security. Read: viewers and above (farmers see nothing, D4).
-- Write: editors add revisions (the saving routes are editor-gated) as
-- themselves; any member adds audit events for their own actions (a farmer
-- leaving the project records it before the membership goes). No UPDATE or
-- DELETE policy for anyone.
-- ---------------------------------------------------------------------------
ALTER TABLE model_revision ENABLE ROW LEVEL SECURITY;
CREATE POLICY model_revision_select ON model_revision FOR SELECT USING (app_has_role(project_id, 'viewer'));
CREATE POLICY model_revision_insert ON model_revision FOR INSERT
	WITH CHECK (app_has_role(project_id, 'editor') AND created_by = app_current_user_id());

ALTER TABLE series_revision ENABLE ROW LEVEL SECURITY;
CREATE POLICY series_revision_select ON series_revision FOR SELECT USING (app_has_role(project_id, 'viewer'));
CREATE POLICY series_revision_insert ON series_revision FOR INSERT
	WITH CHECK (app_has_role(project_id, 'editor') AND created_by = app_current_user_id());

ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_event_select ON audit_event FOR SELECT USING (app_has_role(project_id, 'viewer'));
-- An API-key actor (actor_api_key_id) will need its own clause when keys exist.
CREATE POLICY audit_event_insert ON audit_event FOR INSERT
	WITH CHECK (app_has_role(project_id, 'farmer') AND actor_user_id = app_current_user_id() AND actor_api_key_id IS NULL);

GRANT SELECT, INSERT ON model_revision, series_revision, audit_event TO water_app;
