-- 110_node_development — development that changes during a run: a dam losing
-- capacity to sediment, a dam in service from a date, and abstraction from a
-- date (engine 1.28.0, issue #67, docs/model.md §2.7g, docs/data-model.md
-- § Nodes).
--
-- dam_survey_date: the day the dam's capacity (and its survey curve) was
-- surveyed. NULL = not recorded; a sediment rate needs it.
--
-- dam_sediment_pct_per_year: the share (0-0.2, the engine's
-- DAM_SEDIMENT_MAX_PER_YEAR) of the surveyed capacity lost a year. The
-- capacity on a day is the entered one x (1 - rate x years since the survey
-- date): more before the survey, less after, never below empty. NULL or 0 =
-- none.
--
-- dam_in_service_from: the first day the dam holds water; before it the farm
-- has no dam. NULL = the whole run.
--
-- abstraction_from: the first day the unit (a farm or a water user)
-- abstracts; before it its demand is 0. NULL = the whole run.
--
-- Which kinds may carry which field (dam fields on farms only, no abstraction
-- start on a gauge) is a model rule (engine developmentProblem, through
-- modelRuleProblems), checked by the API on save as the other dam fields'
-- kinds are; the table checks only what holds for every row: the rate's
-- range, and a positive rate having a survey date.
--
-- New columns on an existing table: the table-level grants to water_app in 001
-- and node's RLS policies (members, and a farmer's own linked nodes) already
-- cover them; no foreign key, so no index. No view, function or trigger lists
-- node's columns (the model store, backend/src/model/store.ts, is the one
-- place that does). Expand only: every column is NULL on existing rows, which
-- is what every engine before 1.28.0 ran, so no stored result changes meaning.

ALTER TABLE node
	ADD COLUMN dam_survey_date date,
	ADD COLUMN dam_sediment_pct_per_year double precision
		CHECK (dam_sediment_pct_per_year BETWEEN 0 AND 0.2),
	ADD COLUMN dam_in_service_from date,
	ADD COLUMN abstraction_from date,
	ADD CONSTRAINT node_sediment_needs_survey
		CHECK (dam_sediment_pct_per_year IS NULL OR dam_sediment_pct_per_year = 0 OR dam_survey_date IS NOT NULL);

COMMENT ON COLUMN node.dam_survey_date IS
	'The day the dam capacity and survey curve were surveyed; NULL = not recorded. Needed by a sediment rate. Engine >= 1.28.0 (issue #67).';
COMMENT ON COLUMN node.dam_sediment_pct_per_year IS
	'Share (0-0.2) of the surveyed capacity lost to sediment a year, linear both ways from dam_survey_date; NULL or 0 = none. Engine >= 1.28.0.';
COMMENT ON COLUMN node.dam_in_service_from IS
	'First day the dam holds water; before it the farm has no dam. NULL = the whole run. Engine >= 1.28.0.';
COMMENT ON COLUMN node.abstraction_from IS
	'First day the unit (farm or water user) abstracts; before it its demand is 0. NULL = the whole run. Engine >= 1.28.0.';
