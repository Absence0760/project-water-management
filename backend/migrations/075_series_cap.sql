-- 075_series_cap — the per-project series cap (SERIES_PER_PROJECT_MAX,
-- backend/src/series/limits.ts) made hard (docs/security.md § API keys).
--
-- Before, assertRoomForSeries counted time_series as the writer, under RLS:
--   * an API key limited to some series (allowed_series, 039_api_keys) sees
--     only those, so it counted only them and could keep creating series in a
--     full project (each key up to the cap, keys × cap in all);
--   * two creates at the limit counted at once and both passed.
--
-- app_project_series_count counts every series of the project, whoever asks,
-- and takes a per-project advisory lock first, held to the end of the
-- transaction, so the next create in that project counts only after this one
-- has committed or rolled back. It answers (and locks) only for a caller who
-- may write the project's series: an editor (the time_series_insert policy,
-- 001_init) or a live key of the project with series:write (the
-- time_series_api_key_insert policy, 039_api_keys). Anyone else gets NULL,
-- so it tells nobody how many series a project they can't write holds.
--
-- VOLATILE, so the count after the lock takes a fresh snapshot and sees the
-- series the lock's previous holder committed.

CREATE FUNCTION app_project_series_count(p_project uuid) RETURNS integer
	LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF p_project IS NULL
			OR NOT coalesce(app_has_role(p_project, 'editor') OR p_project = app_api_key_project('series:write'), false) THEN
			RETURN NULL;
		END IF;
		PERFORM pg_advisory_xact_lock(hashtextextended('series_cap:' || p_project::text, 0));
		RETURN (SELECT count(*)::integer FROM time_series WHERE project_id = p_project);
	END
	$$;

REVOKE ALL ON FUNCTION app_project_series_count(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_project_series_count(uuid) TO water_app;
