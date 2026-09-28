-- 100_allocation_conditions — licence conditions on an allocation (roadmap
-- WP-3.10, issue #72; docs/allocations.md § What is stored, docs/data-model.md
-- § Allocations). Latest definition of the table: 038_allocations.sql.
--
-- A licence (or a verified existing lawful use) often limits more than the
-- volume a year: the months water may be taken in, the most it may take at
-- once, and conditions in words (a flow below which abstraction stops, a
-- metering duty). They are recorded and shown with the allocation; the engine
-- doesn't enforce them yet (allocationMode 'cap' caps the volume per water
-- year only, engine 1.16.0).
--
--  * months: the calendar months (1–12) the use may happen in; NULL = none
--    stated (all year). The CHECK holds each to 1–12 with no NULLs; the API
--    and the importer store them ascending and without repeats.
--  * max_rate_m3s: the most it may take at once, m³/s; NULL = none stated.
--  * conditions: the other conditions as written, a JSON array of up to 20
--    strings of 1–500 characters each; [] = none.
--
-- Additive only: every existing row reads as "none stated". No new table, so
-- the policies and grants of 038 cover the columns.

ALTER TABLE allocation
	ADD COLUMN months smallint[] CHECK (
		months IS NULL
		OR (cardinality(months) BETWEEN 1 AND 12 AND array_position(months, NULL) IS NULL AND 1 <= ALL (months) AND 12 >= ALL (months))
	),
	ADD COLUMN max_rate_m3s double precision CHECK (max_rate_m3s IS NULL OR (max_rate_m3s >= 0 AND max_rate_m3s < 1e6)),
	ADD COLUMN conditions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(conditions) = 'array' AND jsonb_array_length(conditions) <= 20);

COMMENT ON COLUMN allocation.months IS 'Licence condition: the calendar months (1–12) the use may happen in; NULL = none stated. Shown, not yet enforced by the engine (100, issue #72).';
COMMENT ON COLUMN allocation.max_rate_m3s IS 'Licence condition: the most it may take at once, m³/s; NULL = none stated. Shown, not yet enforced (100).';
COMMENT ON COLUMN allocation.conditions IS 'Licence conditions in words: a JSON array of up to 20 strings (1–500 characters, checked by the API); [] = none (100).';
