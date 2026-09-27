-- 074_series_blob_digest — the database, not the caller, makes a stored input
-- series' key (docs/security.md § Stored run inputs, § Applicants).
--
-- series_blob (021) is content-addressed: the key is the SHA-256 of
-- seriesDigest(values) (engine manifest.ts: JSON.stringify of the array), and
-- a blob already under a hash is the one every later run using that hash
-- references (storeRunInputs, runs/execute.ts: ON CONFLICT DO NOTHING).
-- Until now the caller sent both the hash and the values and nothing checked
-- one against the other, so a direct insert past the API (a second-layer
-- bypass) by an editor or, since 045's series_blob_insert_contributor, a
-- licence applicant could plant other values under a hash the project would
-- later store; that run would then fail loadRunInput's SHA-256 check (not
-- reproducible, not citable), and so would every run after it.
--
-- Now water_app can't insert a blob at all. It calls app_store_series_blob
-- with the values as JSON text (JSON.stringify(values), exactly the text
-- seriesHash hashes), and the function keys the blob by the SHA-256 of that
-- text and stores the values parsed from that same text. A hash names only
-- the values of a text that hashes to it: a text other than JSON.stringify's
-- (`1.0` for `1`) gets a key of its own, which no run's snapshot holds. The
-- digest isn't recomputed from float8 values in SQL: float8's shortest text
-- and ECMAScript's differ in their digits for some values (2e23), so a
-- reimplementation would refuse a legitimate run.
--
-- Who may store: whoever the two insert policies admitted (an editor; a
-- contributor, whose application runs store their inputs as an editor's
-- do). Parsing: jsonb holds each number as the exact decimal written, and
-- its float8 cast rounds correctly, so the shortest text JSON.stringify
-- writes comes back as the same double; `null` is NULL. The latest policies
-- are 021's series_blob_insert and 045's series_blob_insert_contributor.

DROP POLICY series_blob_insert ON series_blob;
DROP POLICY series_blob_insert_contributor ON series_blob;
REVOKE INSERT ON series_blob FROM water_app;

CREATE FUNCTION app_store_series_blob(p_project uuid, p_values_json text) RETURNS text
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_json jsonb;
		v_sha text;
	BEGIN
		IF NOT (app_has_role(p_project, 'editor') OR app_is_contributor(p_project)) THEN
			RAISE EXCEPTION 'not allowed to store run inputs in this project' USING ERRCODE = 'insufficient_privilege';
		END IF;
		v_json := p_values_json::jsonb;
		IF jsonb_typeof(v_json) IS DISTINCT FROM 'array' THEN
			RAISE EXCEPTION 'run input values must be a JSON array' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		v_sha := encode(sha256(convert_to(p_values_json, 'UTF8')), 'hex');
		INSERT INTO series_blob (project_id, sha256, "values")
		SELECT p_project, v_sha, coalesce(array_agg(CASE WHEN jsonb_typeof(e) = 'null' THEN NULL ELSE e::float8 END ORDER BY i), '{}')
		FROM jsonb_array_elements(v_json) WITH ORDINALITY AS t(e, i)
		ON CONFLICT DO NOTHING;
		RETURN v_sha;
	END
	$$;

COMMENT ON FUNCTION app_store_series_blob(uuid, text) IS
	'Store a run input series under the SHA-256 of its JSON text (JSON.stringify(values), as seriesHash), for an editor or a contributor of the project; returns the key. The only way water_app adds a series_blob row (074_series_blob_digest).';
