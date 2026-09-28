-- 098_nomination_withdrawal — withdrawing the project's evidence nomination
-- (docs/followups.md § Features left half-way, issue #73; docs/data-model.md
-- § Evidence nomination).
--
-- The history was append-only with a run on every row, so an applicant who
-- dropped an application could only *replace* the nomination: the history
-- went on claiming some run was "the evidence". A withdrawal is now its own
-- append-only row: no run (run_id, runoff_model and engine_version NULL
-- together) and a required reason, stamped like a nomination by
-- run_nomination_stamp. After it the project has no current evidence run;
-- the history keeps every row, and a later nomination starts it again.
--
-- 035_project_evidence_guard is unchanged: any nomination row keeps the
-- project for good, withdrawn or not (issue #43), so a withdrawal is about an
-- honest record, not about making a project deletable.

ALTER TABLE run_nomination
	ALTER COLUMN run_id DROP NOT NULL,
	ALTER COLUMN runoff_model DROP NOT NULL,
	ALTER COLUMN engine_version DROP NOT NULL,
	ADD CONSTRAINT run_nomination_withdrawal CHECK ((run_id IS NULL) = (runoff_model IS NULL) AND (run_id IS NULL) = (engine_version IS NULL));

COMMENT ON TABLE run_nomination IS
	'Append-only history of the run each project nominated as evidence (010_run_nomination), and of withdrawals (098: a row with no run). The newest row is the current nomination, or none when it is a withdrawal. water_app may only SELECT and INSERT.';
COMMENT ON COLUMN run_nomination.run_id IS 'The nominated run; NULL for a withdrawal of the nomination before it (098).';
COMMENT ON COLUMN run_nomination.reason IS 'Why this run is the evidence, or why the nomination was withdrawn (required, at most 2000 characters).';

-- Redefined from 010 (its only definition). A row with a run is stamped as
-- before; a row without one is a withdrawal, allowed only while a run is
-- nominated (the newest row has one), with the model columns left NULL.
CREATE OR REPLACE FUNCTION run_nomination_stamp() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
		run_project uuid;
		run_engine text;
		run_model text;
		latest uuid;
		has_latest boolean;
	BEGIN
		IF uid IS NULL THEN
			RAISE EXCEPTION 'a nomination needs a signed-in user' USING ERRCODE = 'insufficient_privilege';
		END IF;
		-- One nomination at a time per project, so "already the current run",
		-- the history cap and the order below can't race.
		PERFORM pg_advisory_xact_lock(hashtextextended('run_nomination:' || NEW.project_id::text, 0));
		SELECT n.run_id INTO latest FROM run_nomination n WHERE n.project_id = NEW.project_id ORDER BY n.nominated_at DESC LIMIT 1;
		has_latest := FOUND;
		IF NEW.run_id IS NULL THEN
			-- Nothing yet, or the newest row is already a withdrawal.
			IF NOT has_latest OR latest IS NULL THEN
				RAISE EXCEPTION 'no run is nominated as evidence, so there is nothing to withdraw' USING ERRCODE = 'check_violation';
			END IF;
			NEW.runoff_model := NULL;
			NEW.engine_version := NULL;
		ELSE
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
			IF has_latest AND latest = NEW.run_id THEN
				RAISE EXCEPTION 'run % is already the nominated evidence run', NEW.run_id USING ERRCODE = 'check_violation';
			END IF;
			NEW.runoff_model := run_model;
			NEW.engine_version := run_engine;
		END IF;
		IF (SELECT count(*) FROM run_nomination WHERE project_id = NEW.project_id) >= 50 THEN
			RAISE EXCEPTION 'the project has reached its nomination limit' USING ERRCODE = 'check_violation';
		END IF;
		NEW.nominated_by := uid;
		NEW.nominated_at := clock_timestamp();
		RETURN NEW;
	END
	$$;
