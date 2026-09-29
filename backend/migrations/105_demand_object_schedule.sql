-- 105_demand_object_schedule — a demand object's daily schedule (engine
-- 1.17.0, issue #90 Q4 and Q12, docs/model.md §2.7f).
--
-- The client's answer: a demand's daily on/off pattern depends on its type
-- (fixed for a town, varying for irrigation) and is set by date, not by
-- river flow. So an object carries a list of date windows, each with a
-- factor on its demand on the days it covers (0 = off):
--   [{ "label", "span": always | yearly | range | easter, "from", "to",
--      "easterFrom", "easterTo", "weekdays": [1..7] | null, "factor" }]
-- The engine reads it (network/demandSchedule.ts); the backend validates
-- each window's shape (model/validate.ts) and meaning (the engine's
-- modelRuleProblems) before it gets here, so the column only guards that it
-- is a non-empty array of at most 24 windows. NULL = no schedule: every day
-- at its month's demand, as every stored object ran before this column.
--
-- A column on an existing project table (088): its RLS policies, the
-- same-project trigger and the grant to water_app already cover it, and it
-- adds no foreign key. Expand only: nothing reads a missing column.

ALTER TABLE demand_object
	ADD COLUMN schedule jsonb
		CONSTRAINT demand_object_schedule_shape CHECK (
			schedule IS NULL
			OR (jsonb_typeof(schedule) = 'array' AND jsonb_array_length(schedule) BETWEEN 1 AND 24)
		);

COMMENT ON COLUMN demand_object.schedule IS
	'Date windows with a factor on the daily demand (0 = off), set by date only; the later window wins, an uncovered day runs at 1. NULL = none. Engine >= 1.17.0, docs/model.md 2.7f.';
