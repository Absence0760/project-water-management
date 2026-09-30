-- 124_demand_object_population — the people a demand object serves, for the
-- basic-needs floor (engine 1.38.0, issue #123, docs/model.md §2.7f).
--
-- The client agreed (issue #90, Q13) that a restriction never cuts domestic
-- supply below 25 litres per person per day. The engine's floor is
-- population × 25 l on a domestic or municipal object: a `perUnit` object's
-- count by default, this column when entered (a `monthly` object, sized from
-- a meter record or an AADD, has no count). NULL = the count, or no floor;
-- the engine reads it only for those two categories.
--
-- A column on an existing project table (088): its RLS policies, the
-- same-project trigger and the grant to water_app already cover it, and it
-- adds no foreign key. Expand only: nothing reads a missing column, and every
-- stored object keeps the floor its count gives it.

ALTER TABLE demand_object
	ADD COLUMN population double precision
		CONSTRAINT demand_object_population_nonneg CHECK (population IS NULL OR (population >= 0 AND population < 'Infinity'::double precision));

COMMENT ON COLUMN demand_object.population IS
	'People served, for the basic-needs floor (population x 25 l/person/day) of a domestic or municipal object. NULL = a perUnit object''s count, else no floor. Engine >= 1.38.0, docs/model.md 2.7f.';
