-- 290_auto_calibration_work — a run of the calibration rules fits each case
-- over as many background jobs as it needs (docs/model.md §2.10j,
-- docs/data-model.md § Automated calibrations, docs/api.md § Automated
-- calibration).
--
-- 108 fitted one case per `auto_calibration` job, so a case had to fit in
-- one job (240 s on the worker): with the default rules no multi-year
-- catchment did. A case's fit is now cut into pieces, each job running its
-- optimisations (the starts, then the validation fits) until its time is
-- spent, pausing the one under way where it stands; the next job (queued by
-- this one, as before, so one job at a time) goes on from there, and the last
-- builds the case. `work` holds where the case under way stands between two
-- jobs: the optimisations finished (each one's parameters, loss and model
-- runs), the paused one's search state (the engine's DdsState: best point,
-- loss, model runs, generator state) and the counts the page shows. Engine
-- output only: numbers, no personal data.
--
-- Expand only: a backend from before this migration never writes `work`, and
-- this one's jobs read a NULL `work` as a case not started.
--
-- In this file:
--  * `auto_calibration.work`, written by whoever the run runs as while it is
--    running (the UPDATE grant below); NULL at insert (the guard trigger) and
--    never changed once the run is complete (the update trigger).
--
-- Latest definitions: auto_calibration_guard and auto_calibration_update,
-- 108_auto_calibration.sql. The rest of both is unchanged.

ALTER TABLE auto_calibration ADD COLUMN work jsonb
	CHECK (work IS NULL OR (jsonb_typeof(work) = 'object' AND pg_column_size(work) <= 262144));
COMMENT ON COLUMN auto_calibration.work IS
	'Where the case under way stands between two of its jobs: the optimisations finished and the paused one''s search state (290_auto_calibration_work); NULL between cases and once finished.';

GRANT UPDATE (work) ON auto_calibration TO water_app;

-- Written running, by a signed-in user, with its job this project's; who and
-- when are stamped here. Now also: no work yet.
CREATE OR REPLACE FUNCTION auto_calibration_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
	BEGIN
		IF uid IS NULL THEN
			RAISE EXCEPTION 'an automated calibration needs a signed-in user' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF NEW.job_id IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM job j WHERE j.id = NEW.job_id AND j.project_id = NEW.project_id AND j.kind = 'auto_calibration'
		) THEN
			RAISE EXCEPTION 'job % is not an automated calibration job of this project', NEW.job_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		NEW.status := 'running';
		NEW.cases := '[]';
		NEW.work := NULL;
		NEW.report := NULL;
		NEW.chosen := NULL;
		NEW.error := NULL;
		NEW.completed_at := NULL;
		NEW.applied_by := NULL;
		NEW.applied_at := NULL;
		NEW.applied_run_id := NULL;
		NEW.uncertainty_id := NULL;
		NEW.created_by := uid;
		NEW.created_at := clock_timestamp();
		RETURN NEW;
	END
	$$;

-- While running, only whoever it runs as (its jobs' acting user) fits it:
-- cases appended, never rewritten, the work under way rewritten as it goes,
-- then completed or failed once. After that, a complete run with a kept fit
-- may be applied (once), by any editor, with a run and an ensemble of this
-- project; nothing else changes, its work included.
CREATE OR REPLACE FUNCTION auto_calibration_update() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
	BEGIN
		-- A foreign key clearing a link (066_account_fk_clears): an account going clears who asked or applied, the job
		-- purge the job, a run trimmed its run and ensemble. Such an update only clears those links and changes nothing
		-- else. water_app can't write created_by or applied_by (the grants below); the others only lose a link.
		IF to_jsonb(NEW) - '{job_id,created_by,applied_by,applied_run_id,uncertainty_id}'::text[]
				= to_jsonb(OLD) - '{job_id,created_by,applied_by,applied_run_id,uncertainty_id}'::text[]
			AND (NEW.job_id IS NULL OR NEW.job_id = OLD.job_id)
			AND (NEW.created_by IS NULL OR NEW.created_by = OLD.created_by)
			AND (NEW.applied_by IS NULL OR NEW.applied_by = OLD.applied_by)
			AND (NEW.applied_run_id IS NULL OR NEW.applied_run_id = OLD.applied_run_id)
			AND (NEW.uncertainty_id IS NULL OR NEW.uncertainty_id = OLD.uncertainty_id)
			AND (NEW.job_id, NEW.created_by, NEW.applied_by, NEW.applied_run_id, NEW.uncertainty_id)
				IS DISTINCT FROM (OLD.job_id, OLD.created_by, OLD.applied_by, OLD.applied_run_id, OLD.uncertainty_id) THEN
			RETURN NEW;
		END IF;
		IF OLD.status = 'running' THEN
			IF uid IS DISTINCT FROM OLD.created_by THEN
				RAISE EXCEPTION 'only whoever an automated calibration runs as can fit it' USING ERRCODE = 'insufficient_privilege';
			END IF;
			-- The first cases must be the ones already stored.
			IF (SELECT COALESCE(jsonb_agg(e ORDER BY n), '[]'::jsonb) FROM jsonb_array_elements(NEW.cases) WITH ORDINALITY t(e, n)
				WHERE n <= jsonb_array_length(OLD.cases)) IS DISTINCT FROM OLD.cases
			THEN
				RAISE EXCEPTION 'fitted cases are appended, never rewritten' USING ERRCODE = 'check_violation';
			END IF;
			IF NEW.applied_at IS NOT NULL OR NEW.applied_by IS NOT NULL OR NEW.applied_run_id IS NOT NULL OR NEW.uncertainty_id IS NOT NULL THEN
				RAISE EXCEPTION 'a running automated calibration can''t be applied' USING ERRCODE = 'check_violation';
			END IF;
			IF NEW.status <> 'running' THEN
				NEW.completed_at := clock_timestamp();
			END IF;
			IF NEW.job_id IS NOT NULL AND NEW.job_id IS DISTINCT FROM OLD.job_id AND NOT EXISTS (
				SELECT 1 FROM job j WHERE j.id = NEW.job_id AND j.project_id = NEW.project_id AND j.kind = 'auto_calibration'
			) THEN
				RAISE EXCEPTION 'job % is not an automated calibration job of this project', NEW.job_id USING ERRCODE = 'foreign_key_violation';
			END IF;
			RETURN NEW;
		END IF;
		IF OLD.status = 'failed' THEN
			RAISE EXCEPTION 'a failed automated calibration is never changed' USING ERRCODE = 'check_violation';
		END IF;
		-- Complete: only the application.
		IF (NEW.status, NEW.cases, NEW.report, NEW.chosen, NEW.error, NEW.completed_at, NEW.job_id, NEW.work)
			IS DISTINCT FROM (OLD.status, OLD.cases, OLD.report, OLD.chosen, OLD.error, OLD.completed_at, OLD.job_id, OLD.work) THEN
			RAISE EXCEPTION 'a complete automated calibration is never changed, only applied' USING ERRCODE = 'check_violation';
		END IF;
		IF OLD.applied_at IS NULL AND NEW.applied_at IS NOT NULL THEN
			NEW.applied_by := uid;
			NEW.applied_at := clock_timestamp();
		ELSIF (NEW.applied_at, NEW.applied_by) IS DISTINCT FROM (OLD.applied_at, OLD.applied_by) THEN
			RAISE EXCEPTION 'an automated calibration is applied once' USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.applied_run_id IS DISTINCT FROM OLD.applied_run_id AND (OLD.applied_run_id IS NOT NULL OR NOT EXISTS (
			SELECT 1 FROM model_run r WHERE r.id = NEW.applied_run_id AND r.project_id = NEW.project_id
		)) THEN
			RAISE EXCEPTION 'the applied run is set once, to a run of this project' USING ERRCODE = 'foreign_key_violation';
		END IF;
		IF NEW.uncertainty_id IS DISTINCT FROM OLD.uncertainty_id AND (OLD.uncertainty_id IS NOT NULL OR NOT EXISTS (
			SELECT 1 FROM run_uncertainty u WHERE u.id = NEW.uncertainty_id AND u.project_id = NEW.project_id AND u.run_id = NEW.applied_run_id
		)) THEN
			RAISE EXCEPTION 'the ensemble is set once, to one of the applied run' USING ERRCODE = 'foreign_key_violation';
		END IF;
		RETURN NEW;
	END
	$$;
