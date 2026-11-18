-- 320_yield_result_ops_sha256 — a scenario's yield records the changes it ran on (the hydrologist's report 2026-11-09).
--
-- A yield on a scenario runs the scenario's ops on its base run as they are
-- when the job runs; the ops can change after. Until now the Yield panel
-- showed the newest stored result with no way to tell it was worked out on
-- an earlier set of changes (a dam's yield from before its capacity was
-- raised read as the yield of the raised dam). From here the yield job
-- writes the scenario's ops_sha256 at the time into `ops_sha256`, the API
-- serves it, and the panel says "worked out before the scenario's latest
-- changes" when it differs from the scenario's current hash.
--
-- NULL: a yield on a run (a run's input never changes), or one on a scenario
-- from before this (unknown; the panel judges it by the scenario's
-- updated_at). No backfill: the ops at the time can't be recovered.
--
-- A new column of yield_result: the table's existing grants (SELECT, INSERT,
-- DELETE to water_app, 040) and policies (040, 045, 096) cover it.
ALTER TABLE yield_result ADD COLUMN ops_sha256 text
	CHECK (ops_sha256 ~ '^[0-9a-f]{64}$');
COMMENT ON COLUMN yield_result.ops_sha256 IS
	'The scenario''s ops_sha256 when its yield job ran (320). NULL = a yield on a run, or a scenario''s from before 320.';
