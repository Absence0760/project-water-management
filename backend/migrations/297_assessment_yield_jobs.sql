-- 297_assessment_yield_jobs — a cumulative assessment fans its dams' firm
-- yields out to jobs of their own and gathers them (docs/followups.md § Cumulative
-- impact, "More dams than one assessment's yield budget"; docs/scenarios.md
-- § Cumulative impact, docs/data-model.md § Assessments, docs/api.md
-- § Assessments).
--
-- The `assessment` job (145) worked out a firm yield for each dam the
-- applications touch on every run inside its own transaction, so it took at
-- most floor(20 ÷ (applications + 2)) dams to stay inside one job's 300 s
-- Lambda. Now it runs the baseline, each member alone and all together as
-- before, keeps the report it built (the dam rows' firm yields still empty)
-- in `assessment.gathering`, and queues one `assessment_yield` job per dam
-- and run, each with an `assessment_yield` row. Each of those jobs, as the
-- same editor and under RLS, works out its one firm yield, stores it on its
-- row and, holding a per-assessment lock, completes the assessment once every
-- row has its yield (filling the report's `dam_firm_yield` rows); the report
-- keeps its shape (report format unchanged). A row whose job died, or ended
-- without storing it, fails the assessment, by its sibling's gather or, when
-- no sibling is left, as the API reads it (assessments/yields.ts), so it never
-- hangs pending.
--
-- In this file:
--  * `job.kind` accepts 'assessment_yield' (latest list: 293_scenario_run_job).
--  * `assessment.gathering`: the report waiting for its yields, written once
--    by whoever asked, while pending, and cleared when it completes
--    (assessment_gathering_guard; never read by the API).
--  * `assessment_yield`: one firm-yield search of an assessment, with RLS
--    (editors, as assessment), grants, covering indexes, a guard on insert
--    (its assessment's project, still pending and the inserter's own; its job
--    an `assessment_yield` job of the project naming this row) and an
--    outcome-once guard. No personal data: dam names and numbers.

-- ---------------------------------------------------------------------------
-- job: the new kind. Latest definition: 293_scenario_run_job.sql.
-- ---------------------------------------------------------------------------
ALTER TABLE job DROP CONSTRAINT job_kind_check;
ALTER TABLE job ADD CONSTRAINT job_kind_check
	CHECK (kind IN ('feed_fetch', 'feed_ingest', 'rerun', 'alert_eval', 'report_render', 'yield', 'sweep', 'outlook', 'auto_calibration',
		'uncertainty', 'pack_render', 'assessment', 'pack_reproduce', 'applicant_pack_render', 'delineate', 'future_yield', 'climate_factors',
		'scenario_run', 'assessment_yield'));

-- ---------------------------------------------------------------------------
-- assessment.gathering
-- ---------------------------------------------------------------------------
ALTER TABLE assessment ADD COLUMN gathering jsonb
	CHECK (gathering IS NULL OR (jsonb_typeof(gathering) = 'object' AND status = 'pending'));
COMMENT ON COLUMN assessment.gathering IS
	'The report waiting for its dams'' firm yields (297): written once by the assessment job while pending, read by the assessment_yield jobs that complete it, cleared on completion. Never served.';

-- Set once, by whoever asked (the assessment job runs as them), while
-- pending; cleared only as the assessment leaves pending. Never at insert.
CREATE FUNCTION assessment_gathering_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF TG_OP = 'INSERT' THEN
			NEW.gathering := NULL;
			RETURN NEW;
		END IF;
		IF OLD.status <> 'pending' THEN
			RAISE EXCEPTION 'a finished assessment is never changed' USING ERRCODE = 'check_violation';
		END IF;
		IF app_current_user_id() IS DISTINCT FROM OLD.created_by THEN
			RAISE EXCEPTION 'only whoever asked for an assessment can store its work' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF NEW.gathering IS NOT NULL AND OLD.gathering IS NOT NULL THEN
			RAISE EXCEPTION 'an assessment''s report waiting for its yields is written once' USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.gathering IS NULL AND NEW.status = 'pending' THEN
			RAISE EXCEPTION 'an assessment''s report waiting for its yields is cleared only as it completes' USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER assessment_gathering_guard BEFORE INSERT OR UPDATE OF gathering ON assessment
	FOR EACH ROW EXECUTE FUNCTION assessment_gathering_guard();

GRANT UPDATE (gathering) ON assessment TO water_app;

-- ---------------------------------------------------------------------------
-- assessment_yield
-- ---------------------------------------------------------------------------
CREATE TABLE assessment_yield (
	id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	assessment_id   uuid NOT NULL REFERENCES assessment(id) ON DELETE CASCADE,
	project_id      uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- The job that works it out; SET NULL when the 30-day purge deletes the
	-- job (a pending row without one reads as stopped).
	job_id          uuid REFERENCES job(id) ON DELETE SET NULL,
	-- Which run: the baseline, one member alone (its position), or all together.
	run             text NOT NULL CHECK (run IN ('baseline', 'single', 'combined')),
	member_position smallint CHECK (member_position BETWEEN 0 AND 7),
	-- The dam's place in report.dams.nodeIds; at most the engine's
	-- CUMULATIVE_YIELD_SEARCHES_MAX (160) searches an assessment, so below that.
	dam_position    smallint NOT NULL CHECK (dam_position BETWEEN 0 AND 159),
	node_id         text NOT NULL CHECK (char_length(node_id) BETWEEN 1 AND 100),
	dam_name        text NOT NULL CHECK (char_length(dam_name) BETWEEN 1 AND 200),
	-- How the report's warnings and problems name the run: "The baseline", "<name>" alone, "All together".
	run_label       text NOT NULL CHECK (char_length(run_label) BETWEEN 1 AND 220),
	-- pending: queued. done: `yield_m3_year` holds the firm yield, or null
	-- with `warning` saying why the search found none.
	status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
	yield_m3_year   double precision CHECK (yield_m3_year >= 0),
	warning         text CHECK (char_length(warning) BETWEEN 1 AND 2000),
	finished_at     timestamptz,
	CHECK ((run = 'single') = (member_position IS NOT NULL)),
	CHECK ((status = 'pending') = (finished_at IS NULL)),
	CHECK (status = 'done' OR (yield_m3_year IS NULL AND warning IS NULL))
);
COMMENT ON TABLE assessment_yield IS
	'One firm-yield search of a cumulative assessment (297): a dam on one of its runs, worked out by its own assessment_yield job and gathered into the assessment''s report. Derived; goes with the assessment.';

-- Covering indexes: the unique index leads with assessment_id; one row per job.
CREATE UNIQUE INDEX assessment_yield_place_idx ON assessment_yield (assessment_id, run, member_position, dam_position) NULLS NOT DISTINCT;
CREATE UNIQUE INDEX assessment_yield_job_idx ON assessment_yield (job_id);
CREATE INDEX assessment_yield_project_idx ON assessment_yield (project_id);

-- Its assessment is its project's, pending and the inserter's own (the
-- assessment job runs as whoever asked); its job is an assessment_yield job
-- of that project whose payload names this row and assessment; a member
-- position names a member. It starts pending.
CREATE FUNCTION assessment_yield_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		a assessment%ROWTYPE;
	BEGIN
		SELECT * INTO a FROM assessment WHERE id = NEW.assessment_id;
		IF a.project_id IS DISTINCT FROM NEW.project_id THEN
			RAISE EXCEPTION 'assessment % belongs to a different project', NEW.assessment_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		IF a.status <> 'pending' THEN
			RAISE EXCEPTION 'a finished assessment takes no new yields' USING ERRCODE = 'check_violation';
		END IF;
		IF app_current_user_id() IS DISTINCT FROM a.created_by THEN
			RAISE EXCEPTION 'only whoever asked for an assessment can queue its yields' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF NEW.run = 'single' AND NOT EXISTS (
			SELECT 1 FROM assessment_member m WHERE m.assessment_id = NEW.assessment_id AND m.position = NEW.member_position
		) THEN
			RAISE EXCEPTION 'assessment % has no member at %', NEW.assessment_id, NEW.member_position USING ERRCODE = 'foreign_key_violation';
		END IF;
		IF NEW.job_id IS NULL OR NOT EXISTS (
			SELECT 1 FROM job j WHERE j.id = NEW.job_id AND j.project_id = NEW.project_id AND j.kind = 'assessment_yield'
			  AND j.payload->>'yieldId' = NEW.id::text AND j.payload->>'assessmentId' = NEW.assessment_id::text
		) THEN
			RAISE EXCEPTION 'job % is not this yield''s job', NEW.job_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		NEW.status := 'pending';
		NEW.yield_m3_year := NULL;
		NEW.warning := NULL;
		NEW.finished_at := NULL;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER assessment_yield_guard BEFORE INSERT ON assessment_yield
	FOR EACH ROW EXECUTE FUNCTION assessment_yield_guard();

-- A pending row gets its outcome once, from whoever asked for the assessment (its job runs as them).
CREATE FUNCTION assessment_yield_outcome() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF OLD.status <> 'pending' THEN
			RAISE EXCEPTION 'an assessment''s yield is stored once and never changed' USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.status <> 'done' THEN
			RAISE EXCEPTION 'an assessment''s yield is stored as done' USING ERRCODE = 'check_violation';
		END IF;
		IF app_current_user_id() IS DISTINCT FROM (SELECT created_by FROM assessment WHERE id = OLD.assessment_id) THEN
			RAISE EXCEPTION 'only whoever asked for an assessment can store its results' USING ERRCODE = 'insufficient_privilege';
		END IF;
		NEW.finished_at := clock_timestamp();
		RETURN NEW;
	END
	$$;
-- Only on the outcome's columns: the 30-day purge's job_id SET NULL passes (water_app can't write it).
CREATE TRIGGER assessment_yield_outcome
	BEFORE UPDATE OF status, yield_m3_year, warning, finished_at ON assessment_yield
	FOR EACH ROW EXECUTE FUNCTION assessment_yield_outcome();

-- Editors only, as the assessment (145).
ALTER TABLE assessment_yield ENABLE ROW LEVEL SECURITY;
CREATE POLICY assessment_yield_select ON assessment_yield FOR SELECT USING (app_has_role(project_id, 'editor'));
CREATE POLICY assessment_yield_insert ON assessment_yield FOR INSERT WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY assessment_yield_update ON assessment_yield FOR UPDATE
	USING (app_has_role(project_id, 'editor') AND status = 'pending')
	WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY assessment_yield_delete ON assessment_yield FOR DELETE USING (app_has_role(project_id, 'editor'));

GRANT SELECT, INSERT, DELETE ON assessment_yield TO water_app;
-- The outcome only: the assessment, run, dam and job are fixed at insert.
GRANT UPDATE (status, yield_m3_year, warning, finished_at) ON assessment_yield TO water_app;
