-- 134_demand_object_source — where a demand object's number comes from, by
-- rule (engine 1.56.0, issue #54 Q11, docs/model.md §2.7f).
--
-- The client confirmed the rule (issue #90): a demand comes from meter
-- records where they exist, else the reconciliation strategy's AADD, else
-- population × litres per person per day, and the model records which. Until
-- now that record was the free-text `note`, so a report couldn't grade a
-- demand by rule. `meter` and `aadd` are sized `monthly`, `perCapita` is
-- sized `perUnit`, `other` either; the engine's save rules check the fit
-- (the CHECK here only keeps the value in the list). NULL = not recorded:
-- every object saved before it, and the run is the same either way.
--
-- A column on an existing project table (088): its RLS policies, the
-- same-project trigger and the grant to water_app already cover it, and it
-- adds no foreign key. Expand only: nothing reads a missing column, and no
-- stored object is guessed a source.

ALTER TABLE demand_object
	ADD COLUMN source text
		CONSTRAINT demand_object_source_known CHECK (source IS NULL OR source IN ('meter', 'aadd', 'perCapita', 'other'));

COMMENT ON COLUMN demand_object.source IS
	'Where the demand comes from: meter (records, sized monthly), aadd (a reconciliation strategy''s AADD, monthly), perCapita (count x litres a day, perUnit), other. NULL = not recorded. Engine >= 1.56.0, docs/model.md 2.7f.';
