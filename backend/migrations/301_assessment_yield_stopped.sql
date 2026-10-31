-- 301_assessment_yield_stopped — the job tick stores as failed a pending
-- assessment one of whose firm-yield jobs stopped without its yield, when
-- nothing else could (docs/scenarios.md § Cumulative impact,
-- docs/data-model.md § Assessments, docs/architecture.md § Background work).
--
-- 297 fanned an assessment's firm yields out to `assessment_yield` jobs; the
-- last one back completes it, and a yield job that dies fails it: through
-- its handler's onDead (the worker, as the user who asked) or a sibling's
-- gather. Two deaths reach neither: the claim killing a running job whose
-- lease ran out with no attempts left (app_claim_jobs, in SQL), and a job
-- whose user is no longer an editor (onDead runs as them and can't write the
-- assessment). The API read those as failed, but the row stayed pending.
--
-- In this file:
--  * assessment_stopped_yields(id): the problem lines of an assessment's
--    stopped yields (a pending row whose job is dead, done without storing
--    it, or purged), in the report's order, or NULL when none: the same
--    lines the backend writes and reads (assessments/yields.ts
--    stoppedYieldsSql). Not callable by water_app.
--  * app_fail_stopped_assessments(): the tick's sweep (jobs/runner.ts), the
--    worker only (no user, no API key: alert_worker_context, 051): every
--    pending, gathering assessment with a stopped yield becomes failed with
--    those lines and its gathering cleared. Returns how many.
--  * assessment_complete (latest: 145) and assessment_gathering_guard
--    (latest: 297) take one exception to "only whoever asked": an update
--    that fails, never completes, a pending assessment that is gathering,
--    whose problems are exactly assessment_stopped_yields' lines (so there
--    is a stopped yield), its engine the one it was gathering on, its
--    gathering cleared and no report. It records only what the job table
--    already says, so it holds whoever makes it; water_app's grants and the
--    update policy are unchanged.

-- ---------------------------------------------------------------------------
-- The stopped yields' lines (assessments/yields.ts stoppedYieldsSql)
-- ---------------------------------------------------------------------------
CREATE FUNCTION assessment_stopped_yields(p_assessment uuid) RETURNS jsonb
	LANGUAGE sql STABLE SET search_path = public
	AS $$
	SELECT jsonb_agg(s.problem ORDER BY s.o1, s.o2, s.o3)
	FROM (
		SELECT format('%s: the firm yield of "%s" didn''t finish (%s)', y.run_label, y.dam_name,
				CASE WHEN yj.id IS NULL THEN 'its job was cleared' WHEN yj.status = 'dead' THEN COALESCE(yj.last_error, 'its job stopped') ELSE 'its job ended without storing it' END) AS problem,
			CASE y.run WHEN 'baseline' THEN 0 WHEN 'single' THEN 1 ELSE 2 END AS o1, y.member_position AS o2, y.dam_position AS o3
		FROM assessment_yield y LEFT JOIN job yj ON yj.id = y.job_id
		WHERE y.assessment_id = p_assessment AND y.status = 'pending' AND (yj.id IS NULL OR yj.status IN ('dead', 'done'))
	) s
	$$;
REVOKE ALL ON FUNCTION assessment_stopped_yields(uuid) FROM PUBLIC, water_app;

-- Whether an update of a pending assessment is the one exception (module comment): failing it on its stopped
-- yields. Never NULL (coalesce): a NULL here must refuse, not slip past the guard's IF.
CREATE FUNCTION assessment_fails_on_stopped_yields(o assessment, n assessment) RETURNS boolean
	LANGUAGE sql STABLE SET search_path = public
	AS $$
	SELECT coalesce(o.status = 'pending' AND o.gathering IS NOT NULL
		AND n.status = 'failed' AND n.gathering IS NULL
		AND n.report IS NULL AND n.combined_summary IS NULL AND n.start_date IS NULL AND n.end_date IS NULL
		AND n.engine_version IS NOT DISTINCT FROM coalesce(o.gathering->>'engineVersion', 'unknown')
		AND assessment_stopped_yields(o.id) IS NOT NULL
		AND n.problems = assessment_stopped_yields(o.id), false)
	$$;
REVOKE ALL ON FUNCTION assessment_fails_on_stopped_yields(assessment, assessment) FROM PUBLIC, water_app;

-- ---------------------------------------------------------------------------
-- assessment_complete, from 145: the exception above
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assessment_complete() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF OLD.status <> 'pending' THEN
			RAISE EXCEPTION 'an assessment is completed once and never changed' USING ERRCODE = 'check_violation';
		END IF;
		-- 301: or a failure on its stopped yields, whoever records it (the tick's sweep).
		IF app_current_user_id() IS DISTINCT FROM OLD.created_by AND NOT assessment_fails_on_stopped_yields(OLD, NEW) THEN
			RAISE EXCEPTION 'only whoever asked for an assessment can complete it' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF NEW.status = 'pending' THEN
			RAISE EXCEPTION 'a pending assessment can only be completed, refused or failed' USING ERRCODE = 'check_violation';
		END IF;
		IF EXISTS (SELECT 1 FROM assessment_member m WHERE m.assessment_id = OLD.id AND m.status = 'pending') THEN
			RAISE EXCEPTION 'every member of an assessment needs an outcome before it is completed' USING ERRCODE = 'check_violation';
		END IF;
		NEW.completed_at := clock_timestamp();
		RETURN NEW;
	END
	$$;

-- ---------------------------------------------------------------------------
-- assessment_gathering_guard, from 297: the same exception for clearing it
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assessment_gathering_guard() RETURNS trigger
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
		-- 301: or a failure on its stopped yields, whoever records it (the tick's sweep).
		IF app_current_user_id() IS DISTINCT FROM OLD.created_by AND NOT assessment_fails_on_stopped_yields(OLD, NEW) THEN
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

-- ---------------------------------------------------------------------------
-- The tick's sweep
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_fail_stopped_assessments() RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		n integer;
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker fails assessments on their stopped yields' USING ERRCODE = 'insufficient_privilege';
		END IF;
		-- A row a yield job is gathering waits on its lock and, finished meanwhile, no longer matches (READ COMMITTED).
		UPDATE assessment a SET status = 'failed', problems = assessment_stopped_yields(a.id),
			engine_version = coalesce(a.gathering->>'engineVersion', 'unknown'), gathering = NULL
		WHERE a.status = 'pending' AND a.gathering IS NOT NULL AND assessment_stopped_yields(a.id) IS NOT NULL;
		GET DIAGNOSTICS n = ROW_COUNT;
		RETURN n;
	END
	$$;
COMMENT ON FUNCTION app_fail_stopped_assessments() IS
	'The job tick''s sweep (301): every pending assessment gathering its yields with a stopped one (its job dead, done without it, or purged) becomes failed, naming each. The worker only.';
REVOKE ALL ON FUNCTION app_fail_stopped_assessments() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_fail_stopped_assessments() TO water_app;
