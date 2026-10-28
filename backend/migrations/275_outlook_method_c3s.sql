-- 275_outlook_method_c3s — the forecast-conditioned outlook's method value
-- (issue #620 step 7; docs/model.md §2.15d, docs/api.md § Seasonal outlooks).
--
--   c3s  the same ESP result, and beside it the chance of each drought
--        restriction level on each review date from the C3S seasonal
--        forecasts held in the data mirror (the engine's
--        runForecastOutlook, fed by backend/src/outlooks/c3s.ts), stored in
--        `result.forecast`. With no forecast issued by the decision date, or
--        no hindcast in the copy, it is `status: 'off'` with the reason and
--        the ESP stands alone, unchanged.
--
-- Widens 267's CHECK, starting from its latest (and only) definition, 267:
-- the constraint is dropped by its exact name and added again with the third
-- value. Every existing row is 'esp' or 'climateState', so the new CHECK
-- holds on them all and the ADD validates without rewriting the table (a
-- CHECK scan of a small table under the ALTER's lock). Nothing else changes: the method is
-- still fixed at insert (063's table-wide INSERT grant; no UPDATE grant names
-- it), no new table, policy, trigger, function or index, and the guard
-- (seasonal_outlook_guard, latest definition 106) reads no column of it.

ALTER TABLE seasonal_outlook DROP CONSTRAINT seasonal_outlook_method;
ALTER TABLE seasonal_outlook
	ADD CONSTRAINT seasonal_outlook_method CHECK (method IN ('esp', 'climateState', 'c3s'));

COMMENT ON COLUMN seasonal_outlook.method IS
	'How the analogue years are used: esp (every year alike), climateState (also the years nearest this season''s ENSO and SAM state, result.climate) or c3s (also the chance of each restriction level from the C3S seasonal forecasts, result.forecast). 267_outlook_method, 275_outlook_method_c3s, issue #620.';
