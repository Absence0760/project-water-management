-- 014_run_uncertainty — uncertainty bands per run (issue #4 phase 9, engine
-- 0.26.0, docs/model.md §2.10e, docs/data-model.md § Uncertainty bands,
-- docs/security.md § Authorization).
--
-- One row per ensemble a run's editor starts: the resolved options (the
-- sample's dimensions and the acceptance thresholds), the seed, and, once the
-- browser has run it and the server has checked it, the kept members, the
-- coverage and the bands. A paired row (baseline_id set) re-runs another
-- run's kept members on this run's inputs and bands the difference.
--
-- An applicant with a band they dislike could otherwise run again with other
-- seeds or thresholds and keep only the kindest. So the history is
-- un-cherry-pickable by privilege, not only by the API:
--   * The seed is drawn here, by the insert trigger, before anything has run;
--     the app can't choose it. A paired row takes its baseline's seed and
--     options, so nothing about it is chosen either.
--   * Every start is kept: water_app has SELECT, INSERT and UPDATE of the
--     result columns only, no DELETE. A started ensemble that is never
--     completed stays, visibly abandoned; the Runs tab counts them.
--   * A row is completed once, by whoever started it, and never changed
--     after (the update trigger). Thresholds and options can't be edited:
--     they aren't in the column grant.
--   * A run's rows go only with the run itself (a nominated evidence run
--     can't be deleted, 010_run_nomination), or with the project.
-- The cap of 50 starts per run bounds what a run can accumulate.

CREATE TABLE run_uncertainty (
	id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id     uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	run_id         uuid NOT NULL REFERENCES model_run(id) ON DELETE CASCADE,
	-- Paired: the baseline ensemble (another run's) whose kept members this re-runs.
	baseline_id    uuid REFERENCES run_uncertainty(id) ON DELETE CASCADE,
	runoff_model   text NOT NULL CHECK (runoff_model IN ('gr4j', 'legacy')),
	engine_version text NOT NULL CHECK (char_length(engine_version) BETWEEN 1 AND 40),
	method         text NOT NULL CHECK (method IN ('lhs')),
	seed           bigint NOT NULL CHECK (seed BETWEEN 0 AND 2147483647),
	members        integer NOT NULL CHECK (members BETWEEN 30 AND 1000),
	-- ResolvedEnsembleOptions (packages/engine/src/uncertainty/ensemble.ts), seed included.
	options        jsonb NOT NULL CHECK (jsonb_typeof(options) = 'object'),
	status         text NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'complete')),
	-- Kept members (ensemble) or pairs (paired); set on completion.
	accepted       integer CHECK (accepted >= 0),
	-- The bands, coverage, notes and decision rule (EnsembleSummary / PairedSummary).
	summary        jsonb,
	-- The engine version, header, members and coverage the summary was built from.
	result         jsonb,
	created_by     uuid NOT NULL REFERENCES app_user(id),
	created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
	completed_at   timestamptz,
	CHECK ((status = 'complete') = (accepted IS NOT NULL AND summary IS NOT NULL AND result IS NOT NULL AND completed_at IS NOT NULL))
);
-- Covering indexes for every foreign key (guarded by catalogue.db.test.ts);
-- run_id leads the history index.
CREATE INDEX run_uncertainty_run_idx ON run_uncertainty (run_id, created_at DESC);
CREATE INDEX run_uncertainty_project_idx ON run_uncertainty (project_id);
CREATE INDEX run_uncertainty_baseline_idx ON run_uncertainty (baseline_id);
CREATE INDEX run_uncertainty_created_by_idx ON run_uncertainty (created_by);

COMMENT ON TABLE run_uncertainty IS
	'Uncertainty ensembles of a run (014_run_uncertainty, engine >= 0.26.0): the seed drawn by the database, the resolved options, then once the result. water_app may SELECT, INSERT and complete a started row once; never delete.';
COMMENT ON COLUMN run_uncertainty.seed IS 'Drawn by run_uncertainty_start (or the baseline''s, for a paired row); the app cannot choose it.';
COMMENT ON COLUMN run_uncertainty.baseline_id IS 'Paired: the baseline run''s complete ensemble whose kept members were re-run on this run; NULL = an ensemble of this run.';
COMMENT ON COLUMN run_uncertainty.status IS 'started (seed drawn, nothing stored yet; abandoned if never completed) or complete (result checked and stored, never changed).';

-- Stamps who and when, draws the seed (or copies the baseline's sample for a
-- paired row) and caps a run at 50 starts.
CREATE FUNCTION run_uncertainty_start() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
		run_project uuid;
		base run_uncertainty%ROWTYPE;
	BEGIN
		IF uid IS NULL THEN
			RAISE EXCEPTION 'an ensemble needs a signed-in user' USING ERRCODE = 'insufficient_privilege';
		END IF;
		-- One start at a time per run, so the cap can't race.
		PERFORM pg_advisory_xact_lock(hashtextextended('run_uncertainty:' || NEW.run_id::text, 0));
		SELECT project_id INTO run_project FROM model_run WHERE id = NEW.run_id;
		IF run_project IS DISTINCT FROM NEW.project_id THEN
			RAISE EXCEPTION 'run % belongs to a different project', NEW.run_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		IF (SELECT count(*) FROM run_uncertainty WHERE run_id = NEW.run_id) >= 50 THEN
			RAISE EXCEPTION 'the run has reached its limit of 50 ensembles' USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.baseline_id IS NOT NULL THEN
			SELECT * INTO base FROM run_uncertainty WHERE id = NEW.baseline_id;
			IF base.project_id IS DISTINCT FROM NEW.project_id THEN
				RAISE EXCEPTION 'baseline % belongs to a different project', NEW.baseline_id USING ERRCODE = 'foreign_key_violation';
			END IF;
			IF base.status <> 'complete' OR base.baseline_id IS NOT NULL OR base.run_id = NEW.run_id THEN
				RAISE EXCEPTION 'a paired band needs a complete ensemble of another run' USING ERRCODE = 'check_violation';
			END IF;
			-- Nothing about a paired row is chosen: it is its baseline's sample.
			NEW.options := base.options;
			NEW.seed := base.seed;
			NEW.members := base.members;
			NEW.method := base.method;
			NEW.runoff_model := base.runoff_model;
		ELSE
			NEW.seed := floor(random() * 2147483648)::bigint;
			NEW.options := jsonb_set(NEW.options, '{seed}', to_jsonb(NEW.seed));
		END IF;
		NEW.status := 'started';
		NEW.accepted := NULL;
		NEW.summary := NULL;
		NEW.result := NULL;
		NEW.completed_at := NULL;
		NEW.created_by := uid;
		NEW.created_at := clock_timestamp();
		RETURN NEW;
	END
	$$;
CREATE TRIGGER run_uncertainty_start BEFORE INSERT ON run_uncertainty
	FOR EACH ROW EXECUTE FUNCTION run_uncertainty_start();

-- A started row is completed once, by whoever started it; after that it is fixed.
CREATE FUNCTION run_uncertainty_complete() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF OLD.status <> 'started' THEN
			RAISE EXCEPTION 'an ensemble is stored once and never changed' USING ERRCODE = 'check_violation';
		END IF;
		IF app_current_user_id() IS DISTINCT FROM OLD.created_by THEN
			RAISE EXCEPTION 'only whoever started an ensemble can complete it' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF NEW.status <> 'complete' THEN
			RAISE EXCEPTION 'a started ensemble can only be completed' USING ERRCODE = 'check_violation';
		END IF;
		NEW.completed_at := clock_timestamp();
		RETURN NEW;
	END
	$$;
CREATE TRIGGER run_uncertainty_complete BEFORE UPDATE ON run_uncertainty
	FOR EACH ROW EXECUTE FUNCTION run_uncertainty_complete();

-- Read = viewer; start and complete = editor. No DELETE policy and no DELETE
-- grant: nothing the app does removes an ensemble.
ALTER TABLE run_uncertainty ENABLE ROW LEVEL SECURITY;
CREATE POLICY run_uncertainty_select ON run_uncertainty FOR SELECT USING (app_has_role(project_id, 'viewer'));
CREATE POLICY run_uncertainty_insert ON run_uncertainty FOR INSERT WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY run_uncertainty_update ON run_uncertainty FOR UPDATE
	USING (app_has_role(project_id, 'editor') AND status = 'started')
	WITH CHECK (app_has_role(project_id, 'editor'));

GRANT SELECT, INSERT ON run_uncertainty TO water_app;
GRANT UPDATE (status, accepted, summary, result, completed_at) ON run_uncertainty TO water_app;
