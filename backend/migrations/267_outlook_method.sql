-- 267_outlook_method — how a seasonal outlook uses its analogue years (issue
-- #620 step 4; docs/model.md §2.15c, docs/api.md § Seasonal outlooks).
--
--   esp           every analogue year alike (063's outlook, the default, so
--                 every existing row keeps meaning what it meant).
--   climateState  the same ESP result, and beside it the same members
--                 summarised on the years nearest this season's ENSO and SAM
--                 state (ONI and AAO from the data mirror's indices, the
--                 engine's selectClimateAnalogues), stored in `result`.
--
-- A forecast-conditioned method (C3S, issue #620 steps 5–7) would widen the
-- CHECK. Fixed at insert like the season and the levels: the column grant
-- is 063's table-wide INSERT, and no UPDATE grant names it, so a completed
-- outlook's method can't change under its result. No new table, so no policy
-- or index; the guard (seasonal_outlook_guard, latest definition 106) reads
-- no column of it and stays as it is.

ALTER TABLE seasonal_outlook
	ADD COLUMN method text NOT NULL DEFAULT 'esp'
		CONSTRAINT seasonal_outlook_method CHECK (method IN ('esp', 'climateState'));

COMMENT ON COLUMN seasonal_outlook.method IS
	'How the analogue years are used: esp (every year alike) or climateState (also the years nearest this season''s ENSO and SAM state, result.climate). 267_outlook_method, issue #620.';
