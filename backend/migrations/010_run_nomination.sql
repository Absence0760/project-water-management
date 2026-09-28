-- 010_run_nomination — which run a project nominated as evidence, and every
-- earlier nomination (docs/data-model.md § Evidence nomination,
-- docs/security.md § Tamper evidence). Migration 009 is reserved for pinned
-- runs (issue #7); the runner applies any unapplied file in name order, so
-- the gap is harmless and 009 may land after this one.
--
-- An applicant with several runs could otherwise pick whichever runoff model
-- is kindest to the application after the fact. A nomination records, at the
-- time it is made, which run (and so which runoff model and engine version)
-- the project stands behind, why, who and when.
--
-- Tamper evidence is enforced by privilege, not only by the API:
--   * water_app gets SELECT and INSERT on run_nomination, and no UPDATE,
--     DELETE or TRUNCATE. The history is append-only: changing the evidence
--     run adds a row and the earlier rows stay.
--   * A BEFORE INSERT trigger stamps who, when, the run's runoff model and
--     engine version from the run itself, so none of them can be forged.
--   * A run any nomination names can't be deleted: the foreign key (NO
--     ACTION) refuses it, trimRuns skips it, and the DELETE route answers 409.
--     NO ACTION rather than RESTRICT because it is checked at the end of the
--     statement: deleting the whole project cascades to both model_run and
--     run_nomination, and that must still work.

CREATE TABLE run_nomination (
	id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id     uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	run_id         uuid NOT NULL REFERENCES model_run(id),
	-- Copied from the run by run_nomination_stamp (runs are immutable apart
	-- from their note, so the copy can't drift). Kept on the row so the
	-- history reads on its own.
	runoff_model   text NOT NULL,
	engine_version text NOT NULL,
	reason         text NOT NULL CHECK (char_length(btrim(reason)) >= 1 AND char_length(reason) <= 2000),
	nominated_by   uuid NOT NULL REFERENCES app_user(id),
	nominated_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
	-- The history's order. The stamp trigger serialises a project's
	-- nominations, so each is strictly later than the one before.
	UNIQUE (project_id, nominated_at)
);
-- Covering indexes for the foreign keys (guarded by catalogue.db.test.ts):
-- project_id is covered by the UNIQUE index above.
CREATE INDEX run_nomination_run_idx ON run_nomination (run_id);
CREATE INDEX run_nomination_nominated_by_idx ON run_nomination (nominated_by);

COMMENT ON TABLE run_nomination IS
	'Append-only history of the run each project nominated as evidence (010_run_nomination). The newest row is the current nomination. water_app may only SELECT and INSERT.';
COMMENT ON COLUMN run_nomination.runoff_model IS 'The nominated run''s settings.runoffModel (absent = legacy), copied from the run at nomination.';
COMMENT ON COLUMN run_nomination.engine_version IS 'The nominated run''s engine version, copied from the run at nomination.';
COMMENT ON COLUMN run_nomination.reason IS 'Why this run is the evidence (required, at most 2000 characters).';

-- Longest history a project may have; nominating beyond it is refused. Each
-- nominated run is kept for good, so this bounds the runs the cap can't trim.
-- Same value as NOMINATIONS_PER_PROJECT_MAX in backend/src/runs/evidence.ts.
CREATE FUNCTION run_nomination_stamp() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
		run_project uuid;
		run_engine text;
		run_model text;
		latest uuid;
	BEGIN
		IF uid IS NULL THEN
			RAISE EXCEPTION 'a nomination needs a signed-in user' USING ERRCODE = 'insufficient_privilege';
		END IF;
		-- One nomination at a time per project, so "already the current run",
		-- the history cap and the order below can't race.
		PERFORM pg_advisory_xact_lock(hashtextextended('run_nomination:' || NEW.project_id::text, 0));
		SELECT project_id, engine_version, COALESCE(inputs->'settings'->>'runoffModel', 'legacy')
			INTO run_project, run_engine, run_model
			FROM model_run WHERE id = NEW.run_id;
		IF run_project IS DISTINCT FROM NEW.project_id THEN
			RAISE EXCEPTION 'run % belongs to a different project', NEW.run_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		-- The legacy runoff model doesn't conserve water (audit H1): workbook
		-- comparison only, never evidence.
		IF run_model = 'legacy' THEN
			RAISE EXCEPTION 'a legacy-model run cannot be nominated as evidence' USING ERRCODE = 'check_violation';
		END IF;
		SELECT run_id INTO latest FROM run_nomination WHERE project_id = NEW.project_id ORDER BY nominated_at DESC LIMIT 1;
		IF latest = NEW.run_id THEN
			RAISE EXCEPTION 'run % is already the nominated evidence run', NEW.run_id USING ERRCODE = 'check_violation';
		END IF;
		IF (SELECT count(*) FROM run_nomination WHERE project_id = NEW.project_id) >= 50 THEN
			RAISE EXCEPTION 'the project has reached its nomination limit' USING ERRCODE = 'check_violation';
		END IF;
		NEW.runoff_model := run_model;
		NEW.engine_version := run_engine;
		NEW.nominated_by := uid;
		NEW.nominated_at := clock_timestamp();
		RETURN NEW;
	END
	$$;
CREATE TRIGGER run_nomination_stamp BEFORE INSERT ON run_nomination
	FOR EACH ROW EXECUTE FUNCTION run_nomination_stamp();

-- Read = viewer, nominate = editor. No UPDATE or DELETE policy, and no grant
-- for either below: nothing the app does can rewrite or remove the history.
ALTER TABLE run_nomination ENABLE ROW LEVEL SECURITY;
CREATE POLICY run_nomination_select ON run_nomination FOR SELECT USING (app_has_role(project_id, 'viewer'));
CREATE POLICY run_nomination_insert ON run_nomination FOR INSERT WITH CHECK (app_has_role(project_id, 'editor'));

GRANT SELECT, INSERT ON run_nomination TO water_app;
