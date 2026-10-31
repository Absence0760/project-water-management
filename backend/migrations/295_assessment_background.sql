-- 295_assessment_background — a cumulative assessment may also be assessed
-- against existing authorised use: an optional background run at full
-- allocation (WP-3.10 / WP-3.11; docs/followups.md § Cumulative impact,
-- "A full-allocation baseline column"; docs/scenarios.md § Cumulative
-- impact; docs/api.md § Assessments; docs/data-model.md).
--
-- Licences never drive the baseline (the operator's rule, issue #507): the
-- assessment's baseline stays the hydrologist's run (base_run_id). The
-- background is a second, separately labelled row set the assessor opts into:
-- a scenario run on that same baseline whose input ran at full allocation
-- (every registered or licensed volume taken in full). The job runs it, each
-- member alone on it and all of them together on it, and stores that table
-- beside the baseline's, inside `report` (report.background), so the
-- complete-once guard (assessment_complete, 145) already covers it and no
-- column is granted for UPDATE.
--
-- Expand only. One nullable column, fixed at insert (not in water_app's
-- UPDATE grant), its covering index, and a BEFORE INSERT guard of its own so
-- assessment_guard (145, 188) is left as it is:
--   * the run is this project's (as base_run_id's guard);
--   * it is a scenario run (model_run.from_scenario, 188) based on this
--     assessment's base run (inputs.scenario.baseRunId);
--   * its stored settings ran at full allocation.
-- The API checks the rest (its ops only set the mode and registered volumes,
-- and the baseline holds a volume that takes) and answers 404 / 422 first;
-- the guard is the rule in the database.
--
-- ON DELETE CASCADE, as base_run_id: an assessment whose background run is
-- deleted goes with it, never silently recomputed or read without the
-- background it was asked for.

ALTER TABLE assessment ADD COLUMN background_run_id uuid REFERENCES model_run(id) ON DELETE CASCADE;
COMMENT ON COLUMN assessment.background_run_id IS
	'Optional background at full allocation (295): a scenario run on base_run_id whose input ran with settings.allocationMode fullAllocation. The job also assesses the members on it (report.background); the baseline stays base_run_id. Set on insert only.';

CREATE INDEX assessment_background_run_idx ON assessment (background_run_id);

CREATE FUNCTION assessment_background_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		bg model_run%ROWTYPE;
	BEGIN
		IF NEW.background_run_id IS NULL THEN
			RETURN NEW;
		END IF;
		SELECT * INTO bg FROM model_run WHERE id = NEW.background_run_id;
		IF bg.project_id IS DISTINCT FROM NEW.project_id THEN
			RAISE EXCEPTION 'run % belongs to a different project', NEW.background_run_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		IF NOT bg.from_scenario OR (bg.inputs->'scenario'->>'baseRunId') IS DISTINCT FROM NEW.base_run_id::text THEN
			RAISE EXCEPTION 'an assessment''s background is a scenario run on its own baseline run' USING ERRCODE = 'check_violation';
		END IF;
		IF (bg.inputs->'settings'->>'allocationMode') IS DISTINCT FROM 'fullAllocation' THEN
			RAISE EXCEPTION 'an assessment''s background is a run at full allocation' USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER assessment_background_guard BEFORE INSERT ON assessment
	FOR EACH ROW EXECUTE FUNCTION assessment_background_guard();
