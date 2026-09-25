-- 017_project_import — the import report kept with the project (WP-1.31
-- follow-up, issue #11; docs/data-model.md § Import reports, docs/security.md
-- § Import reports).
--
-- When a b023 workbook (or a project file) is imported in the browser, the
-- review lists the importer's notes and the unmapped report: what it
-- interpreted, and what it couldn't carry across as the workbook meant.
-- Workbooks are hand-made and have mistakes, so that list is the audit trail
-- of what was flagged; a hydrologist, and later a licensing assessor, needs it
-- long after the import. It is stored here, in the import's transaction.
--
-- Its own table rather than a column on `project`:
--   * it is written once and never changed, which a column on a table editors
--     UPDATE freely can't promise (the grant below can);
--   * one row per import leaves room for re-importing a workbook into an
--     existing project later (the newest row is the current report) with no
--     schema change beyond relaxing the trigger's same-transaction rule;
--   * GET /projects/:id and the project list never carry up to ~1 MB of notes.
--
-- Who can do what:
--   * Read (SELECT): any viewer of the project.
--   * Write (INSERT): only the import itself. The insert trigger stamps the
--     importer and the time, and refuses unless the project was created by
--     that user in the same transaction (project.created_at = now(), the
--     transaction's start), so a report can't be attached to, or forged onto,
--     an existing project afterwards, even by its owner.
--   * Nothing UPDATEs or DELETEs a row: water_app has no such grant (the
--     catalogue test lists it as append-only). Rows go with their project.
--
-- The text in `notes` / `unmapped` comes from the file (farm names, formula
-- text): untrusted, rendered as text only. The API caps it (zod, projects/
-- importReport.ts); the CHECKs below are the backstop.

CREATE TABLE project_import (
	id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id       uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	imported_at      timestamptz NOT NULL DEFAULT now(),
	imported_by      uuid NOT NULL REFERENCES app_user(id),
	source           text NOT NULL CHECK (source IN ('b023-workbook', 'project-file')),
	file_name        text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
	importer_version text NOT NULL CHECK (char_length(importer_version) BETWEEN 1 AND 100),
	-- ImportNote[] / UnmappedItem[] (frontend/src/lib/spreadsheet/import/report.ts).
	notes            jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(notes) = 'array' AND jsonb_array_length(notes) <= 500),
	unmapped         jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(unmapped) = 'array' AND jsonb_array_length(unmapped) <= 500),
	-- Items the importer found beyond the kept 500 per list (the client trims).
	notes_omitted    integer NOT NULL DEFAULT 0 CHECK (notes_omitted BETWEEN 0 AND 1000000),
	unmapped_omitted integer NOT NULL DEFAULT 0 CHECK (unmapped_omitted BETWEEN 0 AND 1000000),
	CHECK (octet_length(notes::text) + octet_length(unmapped::text) <= 1048576)
);
-- Covering indexes for every foreign key (catalogue.db.test.ts); project_id
-- leads the newest-first lookup of GET /projects/:id/import-report.
CREATE INDEX project_import_project_idx ON project_import (project_id, imported_at DESC);
CREATE INDEX project_import_imported_by_idx ON project_import (imported_by);

COMMENT ON TABLE project_import IS
	'What the importer flagged when the project was imported: notes and the unmapped report (017_project_import). One row per import, written only in the transaction that created the project; water_app may SELECT (viewer) and INSERT, never change or delete.';
COMMENT ON COLUMN project_import.notes IS 'ImportNote[] as the review showed them: code, severity, message, sheet/cell/element. Untrusted file text; render as text.';
COMMENT ON COLUMN project_import.unmapped IS 'UnmappedItem[]: what the importer could not map as the workbook meant, with the formula or cell text verbatim. Untrusted file text; render as text.';
COMMENT ON COLUMN project_import.importer_version IS 'Which importer (and engine) produced the report, as the client named it.';

CREATE FUNCTION project_import_stamp() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
	BEGIN
		IF uid IS NULL THEN
			RAISE EXCEPTION 'an import report needs a signed-in user' USING ERRCODE = 'insufficient_privilege';
		END IF;
		-- Runs as the caller, so the project is looked up under RLS as well.
		IF NOT EXISTS (
			SELECT 1 FROM project p WHERE p.id = NEW.project_id AND p.created_by = uid AND p.created_at = now()
		) THEN
			RAISE EXCEPTION 'an import report is written only by the import that created the project'
				USING ERRCODE = 'insufficient_privilege';
		END IF;
		NEW.imported_by := uid;
		NEW.imported_at := now();
		RETURN NEW;
	END
	$$;
CREATE TRIGGER project_import_stamp BEFORE INSERT ON project_import
	FOR EACH ROW EXECUTE FUNCTION project_import_stamp();

ALTER TABLE project_import ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_import_select ON project_import FOR SELECT USING (app_has_role(project_id, 'viewer'));
CREATE POLICY project_import_insert ON project_import FOR INSERT
	WITH CHECK (app_has_role(project_id, 'owner') AND imported_by = app_current_user_id());

GRANT SELECT, INSERT ON project_import TO water_app;
