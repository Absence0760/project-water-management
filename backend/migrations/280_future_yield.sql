-- 280_future_yield — the evidence pack's § 8, Future yield (issue #621 slice
-- 4; docs/evidence-pack.md § Future yield, docs/data-model.md § Future
-- yield, docs/api.md § Future yield).
--
-- A `future_yield` job (the queue from 016_jobs.sql) reads the copy's
-- NEX-GDDP-CMIP6 monthly aggregates over the project's catchment, works out
-- each climate model's monthly change factors, and runs an application's
-- baseline and application runs again under each (packages/engine
-- evidence/future.ts, about 40 runs), as the editor who queued it. It stores
-- the result here; the evidence report of that application run reads the
-- newest row for the pair and freezes it in the pack's manifest.
--
-- In this file:
--  * `job.kind` accepts 'future_yield' (latest list: 191_delineation_request).
--  * `future_yield`: one result per job: the two runs it was run on, the
--    applicant's dam, the method (`delta-1`), the result (factor table
--    included) and the engine that ran it. Insert and delete only (the
--    handler keeps the newest FUTURE_YIELD_RESULTS_KEPT per pair).
--  * RLS: a project's viewers read; editors write (the job runs as one);
--    an applicant (contributor) reads the rows of their own application's
--    runs (app_future_yield_own_run), so their report shows § 8 as an
--    assessor's does. No farmer reads any.
--  * Same project: future_yield_guard checks both runs and the job, and
--    stamps the author; covering indexes on every foreign key.
--  * app_specialist_pack (latest 188) also says whether the pack's manifest
--    has a § 8 result, so the applicant's specialist signs § 8's
--    confirmation too (pack-signoff-2).
--  * Nothing here feeds a saved run: § 8's pairs are never stored as runs,
--    so there is no ENGINE_VERSION change.

-- ---------------------------------------------------------------------------
-- job: the new kind
-- ---------------------------------------------------------------------------
-- Latest definition: 191_delineation_request.sql.
ALTER TABLE job DROP CONSTRAINT job_kind_check;
ALTER TABLE job ADD CONSTRAINT job_kind_check
	CHECK (kind IN ('feed_fetch', 'feed_ingest', 'rerun', 'alert_eval', 'report_render', 'yield', 'sweep', 'outlook', 'auto_calibration',
		'uncertainty', 'pack_render', 'assessment', 'pack_reproduce', 'applicant_pack_render', 'delineate', 'future_yield'));

-- ---------------------------------------------------------------------------
-- future_yield
-- ---------------------------------------------------------------------------
CREATE TABLE future_yield (
	id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id         uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- The pair it re-ran: the application's base run and the application run. A result goes with either.
	baseline_run_id    uuid NOT NULL REFERENCES model_run(id) ON DELETE CASCADE,
	application_run_id uuid NOT NULL REFERENCES model_run(id) ON DELETE CASCADE,
	-- The applicant's dam, as the application run's input names it. No foreign key: a scenario may add nodes the
	-- live model doesn't have (024_scenarios), as yield_result.node_id.
	node_id            uuid NOT NULL,
	-- The job that computed it; SET NULL when the 30-day purge deletes the job.
	job_id             uuid REFERENCES job(id) ON DELETE SET NULL,
	method             text NOT NULL CHECK (method = 'delta-1'),
	-- evidence/future.ts FutureYieldResult: the factor table, the historical pair, every case and the ranges. Ten
	-- models' result is about 60 kB.
	result             jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 1048576),
	engine_version     text NOT NULL CHECK (char_length(engine_version) BETWEEN 1 AND 40),
	created_by         uuid REFERENCES app_user(id) ON DELETE SET NULL,
	created_at         timestamptz NOT NULL DEFAULT now(),
	CHECK (baseline_run_id <> application_run_id)
);
COMMENT ON TABLE future_yield IS
	'The evidence pack''s § 8 Future yield of one application run and its baseline (280_future_yield, issue #621): an application''s two runs re-run under each climate model''s monthly change factors, written by a future_yield job as its acting user. Projections, not predictions.';

-- Covering indexes for every foreign key (catalogue.db.test.ts); the first also serves the report's lookup (newest first per pair).
CREATE INDEX future_yield_application_idx ON future_yield (application_run_id, baseline_run_id, created_at DESC);
CREATE INDEX future_yield_baseline_idx ON future_yield (baseline_run_id);
CREATE INDEX future_yield_project_idx ON future_yield (project_id);
CREATE INDEX future_yield_job_idx ON future_yield (job_id);
CREATE INDEX future_yield_created_by_idx ON future_yield (created_by);

-- Its runs and job are its own project's; the author and time are the session's.
CREATE FUNCTION future_yield_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		NEW.created_by := app_current_user_id();
		NEW.created_at := now();
		IF (SELECT project_id FROM model_run WHERE id = NEW.baseline_run_id) IS DISTINCT FROM NEW.project_id THEN
			RAISE EXCEPTION 'run % belongs to a different project', NEW.baseline_run_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		IF (SELECT project_id FROM model_run WHERE id = NEW.application_run_id) IS DISTINCT FROM NEW.project_id THEN
			RAISE EXCEPTION 'run % belongs to a different project', NEW.application_run_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		IF NEW.job_id IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM job j WHERE j.id = NEW.job_id AND j.project_id = NEW.project_id AND j.kind = 'future_yield'
		) THEN
			RAISE EXCEPTION 'job % is not a future_yield job of this project', NEW.job_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		RETURN NEW;
	END
	$$;
-- INSERT only: water_app has no UPDATE on the table.
CREATE TRIGGER future_yield_guard BEFORE INSERT ON future_yield
	FOR EACH ROW EXECUTE FUNCTION future_yield_guard();

-- The session's user is a contributor of the project and owns the applicant's application p_run was run from.
-- SECURITY DEFINER: reads model_run and scenario past the caller's RLS, answering only yes or no.
CREATE FUNCTION app_future_yield_own_run(p_project uuid, p_run uuid) RETURNS boolean
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT app_is_contributor(p_project) AND EXISTS (
			SELECT 1 FROM model_run r JOIN scenario s ON s.id = r.scenario_id
			WHERE r.id = p_run AND r.project_id = p_project AND s.project_id = p_project
			  AND s.origin = 'applicant' AND s.owner_user_id = app_current_user_id()
		)
	$$;
REVOKE ALL ON FUNCTION app_future_yield_own_run(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_future_yield_own_run(uuid, uuid) TO water_app;

-- Read: a viewer, and an applicant their own application's. Write: an editor, who is who the job runs as.
-- Delete: an editor (the handler keeps the newest few per pair).
ALTER TABLE future_yield ENABLE ROW LEVEL SECURITY;
CREATE POLICY future_yield_select ON future_yield FOR SELECT USING (app_has_role(project_id, 'viewer'));
CREATE POLICY future_yield_select_contributor ON future_yield FOR SELECT USING (app_future_yield_own_run(project_id, application_run_id));
CREATE POLICY future_yield_insert ON future_yield FOR INSERT WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY future_yield_delete ON future_yield FOR DELETE USING (app_has_role(project_id, 'editor'));

GRANT SELECT, INSERT, DELETE ON future_yield TO water_app;

-- ---------------------------------------------------------------------------
-- app_specialist_pack: whether the pack has § 8
-- ---------------------------------------------------------------------------
-- The applicant's specialist reads no pack row (112), so the database says
-- whether its manifest carries a § 8 result: their statement then adds § 8's
-- confirmation (pack-signoff-2, engine liability/signoff.ts), as an editor's
-- does. Latest definition: 188_scenario_run_flag.sql; only 'futureYield' is new.
CREATE OR REPLACE FUNCTION app_specialist_pack(p_project uuid, p_pack uuid) RETURNS jsonb
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		p evidence_pack;
	BEGIN
		IF NOT app_pack_specialist(p_project, p_pack) THEN
			RETURN NULL;
		END IF;
		SELECT * INTO p FROM evidence_pack WHERE id = p_pack AND project_id = p_project;
		RETURN jsonb_build_object(
			'id', p.id,
			'scenarioId', p.scenario_id,
			'title', p.manifest->'report'->'identity'->>'title',
			'version', p.version,
			'status', p.status,
			'manifestSha256', p.manifest_sha256,
			'baselineRunId', p.baseline_run_id,
			'scenarioRunId', p.scenario_run_id,
			'createdAt', p.created_at,
			'futureYield', coalesce(p.manifest->'report'->'futureYield'->>'status' = 'ok', false),
			'runs', (
				SELECT coalesce(jsonb_agg(jsonb_build_object(
					'id', r.id,
					'engineVersion', r.engine_version,
					'scenario', r.from_scenario,
					'fitEngineVersion', r.inputs->'settings'->'fitRecord'->>'engineVersion',
					'legacy', coalesce(r.inputs->'settings'->>'runoffModel', 'legacy') = 'legacy',
					'forecast', r."trigger" = 'forecast',
					'stamp', encode(r.stamp, 'hex'),
					'digest', encode(app_run_digest_body(r.id), 'hex')
				)), '[]'::jsonb)
				FROM model_run r WHERE r.project_id = p_project AND (r.id = p.baseline_run_id OR r.id = p.scenario_run_id)
			)
		);
	END
	$$;
