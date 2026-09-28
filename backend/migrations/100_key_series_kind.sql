-- 100_key_series_kind — an API key may not add a second outlet series of a
-- kind (docs/security.md § API keys; issue #51, adversary finding 1).
--
-- A run reads the first outlet series of each kind by name
-- (runs/execute.ts loadLiveInput). A key that could create a series of a kind
-- the project already has could pick a name that sorts first, and the model
-- would silently read the key's days instead of the series a person chose.
-- series/merge.ts refuses that create (409); this function tells it whether
-- the kind is taken.
--
-- A key limited to some series (allowed_series, 039_api_keys) sees only
-- those under RLS, so the question has to be asked as the definer, like
-- app_project_series_count (075). It answers only a caller who may write the
-- project's series: an editor (time_series_insert, 001_init) or a live key of
-- the project with series:write (time_series_api_key_insert, 039). Anyone
-- else gets NULL, so it tells nobody which kinds a project they can't write
-- holds. Called after app_project_series_count, whose per-project advisory
-- lock (held to the end of the transaction) serialises concurrent creates,
-- so two keys can't each add the second series of a kind at once. VOLATILE
-- for the same reason as 075: a fresh snapshot after that lock.

CREATE FUNCTION app_project_has_outlet_series(p_project uuid, p_kind text) RETURNS boolean
	LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF p_project IS NULL
			OR NOT coalesce(app_has_role(p_project, 'editor') OR p_project = app_api_key_project('series:write'), false) THEN
			RETURN NULL;
		END IF;
		RETURN EXISTS (SELECT 1 FROM time_series WHERE project_id = p_project AND kind = p_kind AND site_node_id IS NULL);
	END
	$$;

REVOKE ALL ON FUNCTION app_project_has_outlet_series(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_project_has_outlet_series(uuid, text) TO water_app;
