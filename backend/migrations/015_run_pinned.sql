-- 015_run_pinned — pin a run so the storage cap keeps it (issue #7,
-- docs/data-model.md § Pinned runs). Issue #7 reserved 009 for this; it lands
-- after 010–014, so it takes the next free number. 009 stays an unused gap.
--
-- A project keeps its newest RUNS_KEPT_PER_PROJECT runs (runs/execute.ts
-- trimRuns), so a baseline could be trimmed away by twenty newer runs. A pinned
-- run is exempt from the trim and doesn't count against it, on the same path
-- as a nominated evidence run (010_run_nomination): the cap keeps the newest N
-- runs that are neither pinned nor nominated.
--
-- Runs stay immutable apart from their note and now their pin: water_app gets
-- UPDATE on `pinned` beside `notes` (007_run_notes), and on nothing else. The
-- update policy (editor on both sides, 007) is unchanged, so a viewer can't pin.
--
-- At most 10 pinned runs per project, so storage stays bounded: newest 20 +
-- pinned 10 + nominated (at most 50, 010). The model_run_pin_limit trigger
-- enforces it (serialised per project, so two pins can't race past it); the
-- API refuses first with a 409 that says so. Same value as
-- PINNED_RUNS_PER_PROJECT_MAX in backend/src/runs/execute.ts.

ALTER TABLE model_run ADD COLUMN pinned boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN model_run.pinned IS
	'Kept by the storage cap (trimRuns skips it) until unpinned (015_run_pinned). At most 10 per project. water_app may update this and notes only.';

-- Only pinned rows, so counting a project's pins reads a handful of entries.
CREATE INDEX model_run_pinned_idx ON model_run (project_id) WHERE pinned;

CREATE FUNCTION model_run_pin_limit() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NEW.pinned AND NOT OLD.pinned THEN
			-- One pin at a time per project, so the count below can't race.
			PERFORM pg_advisory_xact_lock(hashtextextended('model_run_pin:' || NEW.project_id::text, 0));
			IF (SELECT count(*) FROM model_run WHERE project_id = NEW.project_id AND pinned) >= 10 THEN
				RAISE EXCEPTION 'the project has reached its pinned-run limit' USING ERRCODE = 'check_violation';
			END IF;
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER model_run_pin_limit BEFORE UPDATE OF pinned ON model_run
	FOR EACH ROW EXECUTE FUNCTION model_run_pin_limit();

-- Column-level privilege: the note and the pin, and nothing else.
GRANT UPDATE (pinned) ON model_run TO water_app;

COMMENT ON POLICY model_run_update ON model_run IS
	'Editor+ may update a run; the column grants limit that to notes (007_run_notes) and pinned (015_run_pinned).';
