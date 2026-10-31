-- 293_scenario_run_job — run an issued licence's terms in the background
-- (docs/followups.md "The licensed-terms run isn't made for the assessor";
-- docs/scenarios.md § Applications, docs/api.md § Scenarios,
-- docs/data-model.md § Jobs, docs/architecture.md § Background work).
--
-- An issued licence whose granted terms differ from the ops applied for, or
-- one varied on appeal, counted in the evidence report's § 4 table only once
-- someone pressed **Run the licensed terms** (POST …/scenarios/:sid/runs
-- `terms: 'licensed'`): a scenario run was an engine run on the request path
-- only. Now POST …/decide and POST …/appeals queue a `scenario_run` job when
-- the licence in force afterwards has terms no run on its base has yet, and
-- the worker stores that run as the member who recorded the decision or the
-- event (the job's acting user, an editor), as the button does. The button
-- still works; a job that finds the run already made does nothing.
--
-- In this file only `job.kind` accepts 'scenario_run' (latest list:
-- 282_climate_factors.sql). No table, function, policy or grant changes: the
-- job is an ordinary editor's job under 016's policies, and it writes an
-- ordinary model_run under the run policies. No personal data.

-- Latest definition: 282_climate_factors.sql.
ALTER TABLE job DROP CONSTRAINT job_kind_check;
ALTER TABLE job ADD CONSTRAINT job_kind_check
	CHECK (kind IN ('feed_fetch', 'feed_ingest', 'rerun', 'alert_eval', 'report_render', 'yield', 'sweep', 'outlook', 'auto_calibration',
		'uncertainty', 'pack_render', 'assessment', 'pack_reproduce', 'applicant_pack_render', 'delineate', 'future_yield', 'climate_factors',
		'scenario_run'));
