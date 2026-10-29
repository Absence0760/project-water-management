-- 284_climate_factors — the Scenarios tab's future climate (issue #621
-- slice 5; docs/scenarios.md § Future climate, docs/data-model.md § Future
-- yield, docs/api.md § Future climate).
--
-- A `climate_factors` job (the queue from 016_jobs.sql) reads the copy's
-- NEX-GDDP-CMIP6 monthly aggregates over the project's catchment boundary and
-- works out each climate model's monthly change factors, per SSP and horizon
-- (packages/engine evidence/future.ts buildFutureFactorTable, the same table
-- § 8's future_yield job freezes), as the editor who queued it. It stores the
-- table here; the Scenarios tab's picker reads the newest row and adds one
-- case's factors to a scenario as a `climate.delta` op. The op carries its
-- factors, so a scenario never reads this table again: deleting a row changes
-- no scenario or run.
--
-- In this file:
--  * `job.kind` accepts 'climate_factors' (latest list: 280_future_yield).
--  * `climate_factors`: one table per job, with the SHA-256 of the boundary
--    it was read over (so the picker can say when the boundary has changed
--    since), the method (`delta-1`) and the job that made it. Insert and
--    delete only (the handler keeps the newest few per project).
--  * RLS: a project's viewers read; editors write (the job runs as one). No
--    contributor or farmer reads any: the climate is a baseline assumption,
--    an editor's to make.
--  * Same project: climate_factors_guard checks the job and stamps the
--    author; covering indexes on every foreign key.
--  * Nothing here feeds a run by itself, so there is no ENGINE_VERSION change.

-- ---------------------------------------------------------------------------
-- job: the new kind
-- ---------------------------------------------------------------------------
-- Latest definition: 280_future_yield.sql.
ALTER TABLE job DROP CONSTRAINT job_kind_check;
ALTER TABLE job ADD CONSTRAINT job_kind_check
	CHECK (kind IN ('feed_fetch', 'feed_ingest', 'rerun', 'alert_eval', 'report_render', 'yield', 'sweep', 'outlook', 'auto_calibration',
		'uncertainty', 'pack_render', 'assessment', 'pack_reproduce', 'applicant_pack_render', 'delineate', 'future_yield', 'climate_factors'));

-- ---------------------------------------------------------------------------
-- climate_factors
-- ---------------------------------------------------------------------------
CREATE TABLE climate_factors (
	id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id       uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- The job that computed it; SET NULL when the 30-day purge deletes the job.
	job_id           uuid REFERENCES job(id) ON DELETE SET NULL,
	method           text NOT NULL CHECK (method = 'delta-1'),
	-- SHA-256 (hex) of the catchment boundary's geometry as canonical JSON when the factors were read over it.
	boundary_sha256  text NOT NULL CHECK (boundary_sha256 ~ '^[0-9a-f]{64}$'),
	-- evidence/future.ts FutureFactorTable: every case's 24 factors, the windows, the sources' hashes. Ten models' table
	-- is about 20 kB.
	factors          jsonb NOT NULL CHECK (jsonb_typeof(factors) = 'object' AND octet_length(factors::text) <= 524288),
	-- The job's notes (cells with no value left out), plain text.
	warnings         jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(warnings) = 'array' AND octet_length(warnings::text) <= 65536),
	created_by       uuid REFERENCES app_user(id) ON DELETE SET NULL,
	created_at       timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE climate_factors IS
	'Monthly climate change factors over a project''s catchment (284_climate_factors, issue #621): per NEX-GDDP-CMIP6 model, SSP and horizon, written by a climate_factors job as its acting user. The Scenarios tab adds one case to a scenario as a climate.delta op, which carries its own factors.';

-- Covering indexes for every foreign key (catalogue.db.test.ts); the first also serves the picker's lookup (newest first).
CREATE INDEX climate_factors_project_idx ON climate_factors (project_id, created_at DESC);
CREATE INDEX climate_factors_job_idx ON climate_factors (job_id);
CREATE INDEX climate_factors_created_by_idx ON climate_factors (created_by);

-- Its job is its own project's; the author and time are the session's.
CREATE FUNCTION climate_factors_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		NEW.created_by := app_current_user_id();
		NEW.created_at := now();
		IF NEW.job_id IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM job j WHERE j.id = NEW.job_id AND j.project_id = NEW.project_id AND j.kind = 'climate_factors'
		) THEN
			RAISE EXCEPTION 'job % is not a climate_factors job of this project', NEW.job_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		RETURN NEW;
	END
	$$;
-- INSERT only: water_app has no UPDATE on the table.
CREATE TRIGGER climate_factors_guard BEFORE INSERT ON climate_factors
	FOR EACH ROW EXECUTE FUNCTION climate_factors_guard();

-- Read: a viewer. Write and delete: an editor, who is who the job runs as (the handler keeps the newest few).
ALTER TABLE climate_factors ENABLE ROW LEVEL SECURITY;
CREATE POLICY climate_factors_select ON climate_factors FOR SELECT USING (app_has_role(project_id, 'viewer'));
CREATE POLICY climate_factors_insert ON climate_factors FOR INSERT WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY climate_factors_delete ON climate_factors FOR DELETE USING (app_has_role(project_id, 'editor'));

GRANT SELECT, INSERT, DELETE ON climate_factors TO water_app;
