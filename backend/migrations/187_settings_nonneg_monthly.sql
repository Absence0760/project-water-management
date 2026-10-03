-- 187_settings_nonneg_monthly — engine 1.69.0 (erratum ER-17,
-- docs/engine-errata.md): a negative monthly A-pan made a dam gain water from
-- evaporation. The API now refuses a negative month in settings.apanMm and
-- settings.ewrPragmaticM3PerDay (backend/src/projects/settings.ts), and the
-- engine runs a negative A-pan month as 0 (prepare.ts mergeSettings).
--
-- The Settings tab saves the whole settings object, so a stored negative
-- month would make every later settings save fail. This clamps the stored
-- rows to what the engine already runs: each negative month becomes 0.
-- Other values (non-numbers, short rows) are left for mergeSettings, which
-- already falls back on them. Project settings only: stored runs keep the
-- inputs they ran with.

DO $$
DECLARE
	k text;
BEGIN
	FOREACH k IN ARRAY ARRAY['apanMm', 'ewrPragmaticM3PerDay'] LOOP
		UPDATE project
		SET settings = jsonb_set(
			settings,
			ARRAY[k],
			(
				SELECT jsonb_agg(CASE WHEN jsonb_typeof(e) = 'number' AND (e #>> '{}')::numeric < 0 THEN '0'::jsonb ELSE e END ORDER BY i)
				FROM jsonb_array_elements(settings -> k) WITH ORDINALITY AS a(e, i)
			)
		)
		WHERE jsonb_typeof(settings -> k) = 'array'
			AND EXISTS (
				SELECT 1 FROM jsonb_array_elements(settings -> k) AS e
				WHERE jsonb_typeof(e) = 'number' AND (e #>> '{}')::numeric < 0
			);
	END LOOP;
END
$$;
