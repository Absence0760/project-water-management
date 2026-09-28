-- 007_run_notes — a written explanation per run (WR2012 check follow-up,
-- docs/data-model.md § Run notes).
--
-- An assessor wants the modeller's reason next to a WR2012 *query* or *not
-- usable* flag ("the quaternary includes an irrigated tributary outside the
-- model"). Runs are otherwise immutable: their inputs snapshot and outputs are
-- the evidence, so nothing but the note may change after the run is made.
--
-- That is enforced by privilege, not only by the API: water_app loses its
-- table-level UPDATE on model_run and gets UPDATE on the `notes` column alone.
-- An UPDATE naming any other column fails with insufficient_privilege, for
-- every role. Who changed the note and when is stamped by a trigger (a BEFORE
-- trigger may set columns the caller has no privilege on), so the stamp can't
-- be forged or skipped.

ALTER TABLE model_run
	ADD COLUMN notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 4000),
	ADD COLUMN notes_updated_at timestamptz,
	ADD COLUMN notes_updated_by uuid REFERENCES app_user(id) ON DELETE SET NULL;
-- Covering index for the new foreign key (guarded by catalogue.db.test.ts).
CREATE INDEX model_run_notes_updated_by_idx ON model_run (notes_updated_by);

COMMENT ON COLUMN model_run.notes IS
	'The modeller''s written explanation of the run (e.g. why a WR2012 flag stands). The only column water_app may update. Max 4000 characters; empty = none.';
COMMENT ON COLUMN model_run.notes_updated_at IS 'When notes last changed (set by model_run_stamp_notes); NULL = never written.';
COMMENT ON COLUMN model_run.notes_updated_by IS 'Who last changed notes (set by model_run_stamp_notes).';

CREATE FUNCTION model_run_stamp_notes() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF NEW.notes IS DISTINCT FROM OLD.notes THEN
			NEW.notes_updated_at := now();
			NEW.notes_updated_by := app_current_user_id();
		ELSE
			-- The stamp only ever describes the note: an update that leaves the
			-- note alone keeps it as it was.
			NEW.notes_updated_at := OLD.notes_updated_at;
			NEW.notes_updated_by := OLD.notes_updated_by;
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER model_run_stamp_notes BEFORE UPDATE ON model_run
	FOR EACH ROW EXECUTE FUNCTION model_run_stamp_notes();

-- Column-level privilege: the note, and nothing else, is writable by the app.
REVOKE UPDATE ON model_run FROM water_app;
GRANT UPDATE (notes) ON model_run TO water_app;

-- Latest definition is 001's generated `model_run_update` (editor, both
-- sides). Re-created by name so the rule reads here, next to the grant: an
-- editor or owner of the run's project may write its note; a viewer may not.
DROP POLICY model_run_update ON model_run;
CREATE POLICY model_run_update ON model_run FOR UPDATE
	USING (app_has_role(project_id, 'editor'))
	WITH CHECK (app_has_role(project_id, 'editor'));
COMMENT ON POLICY model_run_update ON model_run IS
	'Editor+ may update a run; the column grant limits that to notes (007_run_notes).';
