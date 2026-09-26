-- 038_run_trigger — what made a run: a person pressing Run, an automatic
-- re-run after new data, or a forecast run (roadmap step 2, WP-2.11 and
-- WP-2.12; docs/data-model.md § Run triggers).
--
-- Expand-only: existing rows are manual runs. WP-2.11 (auto re-run) and
-- WP-2.12 (forecast mode) were built side by side and both need the column,
-- so this file is written to be a no-op when the other's migration added it
-- first (IF NOT EXISTS, and the constraint only when missing). Whichever
-- lands second keeps its file; the column and its values are the same.
--
-- A forecast run (trigger 'forecast') doesn't count toward the storage cap of
-- manual runs, and a project keeps only its newest one that nothing else
-- keeps (runs/execute.ts trimForecastRuns), so the partial index below finds
-- them without reading the project's other runs.
--
-- No grant: water_app inserts whole model_run rows (the table-level INSERT of
-- 001) and may update only notes and pinned (007, 015), so a run's trigger is
-- fixed when it is saved. No new policy: the column follows model_run's.

ALTER TABLE model_run ADD COLUMN IF NOT EXISTS "trigger" text NOT NULL DEFAULT 'manual';

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'model_run'::regclass AND conname = 'model_run_trigger_check') THEN
		ALTER TABLE model_run ADD CONSTRAINT model_run_trigger_check CHECK ("trigger" IN ('manual', 'auto', 'forecast'));
	END IF;
END
$$;

COMMENT ON COLUMN model_run."trigger" IS
	'What made the run: manual (POST /runs), auto (a re-run after new data, WP-2.11) or forecast (forecast mode, WP-2.12). Fixed at insert (038_run_trigger).';

CREATE INDEX IF NOT EXISTS model_run_forecast_idx ON model_run (project_id, created_at DESC) WHERE "trigger" = 'forecast';
