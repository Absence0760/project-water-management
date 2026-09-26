-- 037_notes — notes and comments kept against a farm, a run, a setting or
-- the project (roadmap WP-2.7; docs/data-model.md § Notes, docs/api.md
-- § Notes).
--
-- Knowledge that lives in people's heads ("dam raised in 2019 per owner",
-- "logger moved in March") is written down against what it is about.
--
--  * The target is a nullable typed foreign key, not a polymorphic id, so the
--    foreign keys and the same-project trigger work: node_id (a farm, gauge
--    or other node), run_id, setting_key (a settings path such as
--    `calibration.a` or a group such as `ewr`), or none (the project). A
--    CHECK allows at most one. A note goes with its node, run or project
--    (cascade); saving the model upserts nodes by id, so a save keeps them.
--  * visibility: `team` (the WUA and its consultants: viewers and above) or
--    `farm` (also the farmers linked to the note's node). A farm note needs a
--    node target.
--  * Plain text only, 1..4000 characters; the UI renders it with Svelte's
--    escaping and `white-space: pre-line`, never as HTML or markdown.
--  * Soft delete: deleted_at + deleted_by. The row and its body stay for the
--    audit trail; RLS hides a deleted note from everyone but editors and its
--    author, and the API lists none. water_app has no DELETE on the table.
--  * Edit: the author only, the body only (note_guard below; column grants
--    keep the target, visibility and author fixed). edited_at is set here,
--    not by the caller.
--
-- RLS in words:
--   SELECT  viewers and above: every note of the project that isn't deleted
--           (editors, and a note's author: deleted ones too); a farmer:
--           `farm` notes on their linked nodes (app_farm_nodes), never a
--           `team` note.
--   INSERT  as yourself: a viewer and above anywhere; a farmer only on a
--           linked node and only with visibility `farm`.
--   UPDATE  a note you can see and that isn't deleted, as its author or as an
--           editor (editors moderate: soft delete only, note_guard).
--   DELETE  none (soft delete).

CREATE TABLE note (
	id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id  uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	author_id   uuid REFERENCES app_user(id) ON DELETE SET NULL,
	created_at  timestamptz NOT NULL DEFAULT now(),
	edited_at   timestamptz,
	deleted_at  timestamptz,
	deleted_by  uuid REFERENCES app_user(id) ON DELETE SET NULL,
	body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
	node_id     uuid REFERENCES node(id) ON DELETE CASCADE,
	run_id      uuid REFERENCES model_run(id) ON DELETE CASCADE,
	setting_key text CHECK (length(setting_key) <= 100 AND setting_key ~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$'),
	visibility  text NOT NULL DEFAULT 'team' CHECK (visibility IN ('team', 'farm')),
	CONSTRAINT note_one_target CHECK (num_nonnulls(node_id, run_id, setting_key) <= 1),
	CONSTRAINT note_farm_on_node CHECK (visibility = 'team' OR node_id IS NOT NULL)
);
COMMENT ON TABLE note IS
	'Plain-text notes on a node, run, setting or the project, visible to the team or also to the linked farmers (037, WP-2.7). Soft-deleted, never removed by the app.';

CREATE INDEX note_project_idx ON note (project_id, created_at DESC);
CREATE INDEX note_author_idx ON note (author_id);
CREATE INDEX note_deleted_by_idx ON note (deleted_by);
CREATE INDEX note_node_idx ON note (node_id);
CREATE INDEX note_run_idx ON note (run_id);

CREATE TRIGGER note_same_project BEFORE INSERT OR UPDATE ON note
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('node_id', 'run_id');

-- The author edits the body; anyone the UPDATE policy lets through (the
-- author, an editor) may soft-delete. A deleted note stays deleted (the
-- policy's USING already hides it from an update). Stamps edited_at and
-- deleted_by here, so the caller can't backdate either.
CREATE FUNCTION note_guard() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF NEW.body IS DISTINCT FROM OLD.body THEN
			IF OLD.author_id IS DISTINCT FROM app_current_user_id() THEN
				RAISE EXCEPTION 'only the author may edit a note' USING ERRCODE = 'insufficient_privilege';
			END IF;
			NEW.edited_at := now();
		ELSE
			NEW.edited_at := OLD.edited_at;
		END IF;
		IF OLD.deleted_at IS NOT NULL THEN
			RAISE EXCEPTION 'note % is deleted', OLD.id USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.deleted_at IS NOT NULL THEN
			NEW.deleted_at := now();
			NEW.deleted_by := app_current_user_id();
		ELSE
			NEW.deleted_by := NULL;
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER note_guard BEFORE UPDATE ON note
	FOR EACH ROW EXECUTE FUNCTION note_guard();

ALTER TABLE note ENABLE ROW LEVEL SECURITY;

-- A deleted note stays readable to its author as well as to editors:
-- Postgres checks an updated row against the SELECT policies, so without
-- that an author who isn't an editor couldn't soft-delete their own note.
-- They wrote the body, so it hides nothing from them; the API lists no
-- deleted note to anyone.
CREATE POLICY note_select ON note FOR SELECT
	USING (
		app_has_role(project_id, 'viewer')
		AND (deleted_at IS NULL OR author_id = app_current_user_id() OR app_has_role(project_id, 'editor'))
	);
-- ORed with the above: a farmer's farm-visible notes on their linked nodes.
CREATE POLICY note_select_farmer ON note FOR SELECT
	USING (
		visibility = 'farm' AND node_id IN (SELECT app_farm_nodes(project_id))
		AND (deleted_at IS NULL OR author_id = app_current_user_id())
	);

CREATE POLICY note_insert ON note FOR INSERT
	WITH CHECK (
		author_id = app_current_user_id() AND deleted_at IS NULL AND deleted_by IS NULL AND edited_at IS NULL
		AND (
			app_has_role(project_id, 'viewer')
			OR (visibility = 'farm' AND node_id IN (SELECT app_farm_nodes(project_id)))
		)
	);

CREATE POLICY note_update ON note FOR UPDATE
	USING (deleted_at IS NULL AND (author_id = app_current_user_id() OR app_has_role(project_id, 'editor')))
	WITH CHECK (author_id = app_current_user_id() OR app_has_role(project_id, 'editor'));

GRANT SELECT, INSERT ON note TO water_app;
GRANT UPDATE (body, edited_at, deleted_at, deleted_by) ON note TO water_app;
