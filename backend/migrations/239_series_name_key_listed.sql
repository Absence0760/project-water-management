-- 239_series_name_key_listed — whether a live API key's series list names a
-- series, for the rename check (issue #556 follow-up; docs/api.md § Series,
-- docs/data-model.md § API keys).
--
-- PATCH …/series/:id { name } refuses to rename a series something outside
-- the app writes by its name. A data feed (data_feed, editor-readable) and a
-- key that has pushed days (series_key_days, editor-readable) are found under
-- RLS. A key whose allowed_series (039) lists { kind, name } but which hasn't
-- pushed yet is not: api_key is owner-only, and an editor may rename. After
-- such a rename the key's list no longer admits the series, and its next push
-- under the old name starts a new one; a rename *to* a listed name would turn
-- the key's future pushes into this series.
--
-- In this file:
--  * app_series_name_key_listed(project, kind, name): true when a live key of
--    that project (not revoked, not expired; neither can be undone, since
--    water_app may update only revoked_at / revoked_by) lists exactly that
--    { kind, name }, the containment app_api_key_allows tests on a push. A
--    key with no list (any series) isn't counted: it names nothing in
--    advance, and once it pushes, series_key_days catches it. False unless
--    the caller is an editor of the project (requireRole's rule for the
--    route), so it says nothing to anyone else, and false in a key's
--    transaction (no user). It returns only the boolean: no key id, name or
--    list leaves the function. No new table, column or policy.

CREATE FUNCTION app_series_name_key_listed(p_project uuid, p_kind text, p_name text) RETURNS boolean
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF p_project IS NULL OR p_kind IS NULL OR p_name IS NULL OR NOT app_has_role(p_project, 'editor') THEN
			RETURN false;
		END IF;
		RETURN EXISTS (
			SELECT 1 FROM api_key
			WHERE project_id = p_project
			  AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
			  AND allowed_series IS NOT NULL
			  AND allowed_series @> jsonb_build_array(jsonb_build_object('kind', p_kind, 'name', p_name))
		);
	END
	$$;

REVOKE ALL ON FUNCTION app_series_name_key_listed(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_series_name_key_listed(uuid, text, text) TO water_app;
