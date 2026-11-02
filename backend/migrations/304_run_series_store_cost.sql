-- 304_run_series_store_cost — storing a run's series costs a fraction of
-- what it did (docs/followups.md § V1 run budget, docs/data-model.md §
-- Series storage, docs/security.md § Run stamps).
--
-- A client-sized run (13 nodes, 16 161 days) stores 432 series, ~7 million
-- float8 values, ~56 MB before compression. Measured on the dev laptop, per
-- run, after the backend began sending the arrays in binary (db/float8Array.ts):
-- the run_series insert 1.2 s and stamping 0.33 s. Two changes here:
--
-- 1. run_series."values" compresses with lz4, not pglz. pglz was half the
--    insert's server time: the insert took 0.6 s with lz4 (0.8 s with no
--    compression, the extra WAL), and lz4 decompresses several times faster
--    for every reader. Compression is invisible to SQL: the values,
--    array_send's bytes, every run's digest and stamp, the readers and the
--    policies are unchanged. Only values written from now on use lz4; rows
--    already stored stay pglz and read as before (Postgres records the
--    method per value), so the ALTER is a catalogue change and rewrites
--    nothing. lz4 is built into the docker image's Postgres 17 and RDS's.
--
-- 2. app_run_signing_digest: the digest storeRun signs, with each series'
--    SHA-256 given by the backend rather than recomputed. app_run_digest
--    (077, 115's body) hashes array_send of every stored series, and
--    array_send calls float8send once a value: 0.3 s of the 0.33 s, to hash
--    values the backend sent a moment earlier in exactly that format (the
--    binary parameter is array_send's format, byte for byte). The backend
--    hashes its own parameters instead; everything else in the digest (the
--    run row, the inputs, the meta the database stored, which a DWS mark may
--    have been stripped from, 235) is read here as before, through the same
--    canonical body, so the digest is the one app_run_digest gives for the
--    same rows. Nothing about verifying changes: verifiedRuns, a sign-off and
--    an application's decision still compare the stamp with app_run_digest
--    over the rows as they stand. A given hash that doesn't match what was
--    stored can't forge anything: the run just doesn't verify (fails
--    closed), and the stamp key is still the backend's alone. The function
--    answers only for the run the caller is stamping (app_set_run_stamp's
--    rule: their own, unstamped, made in this transaction) and only when
--    each stored series has exactly one given hash; else NULL, and storeRun
--    throws rather than store an unsigned run.
--
-- app_run_digest_body (115, its latest) keeps its definition and its digest:
-- it is replaced by the same canonical form, now in app_run_digest_from,
-- which both it and the signing digest call with the series part.

ALTER TABLE run_series ALTER COLUMN "values" SET COMPRESSION lz4;

-- The run's digest, from the series part (an array of [node_id, key, meta,
-- sha256 hex] in node, then "C" key order): 115's app_run_digest_body with its
-- run_series subquery lifted out, so its output is unchanged.
CREATE FUNCTION app_run_digest_from(p_run uuid, p_series jsonb) RETURNS bytea
	LANGUAGE sql STABLE SET search_path = public
	AS $$
	SELECT sha256(convert_to(jsonb_build_array(
		'wm-run-digest:v1',
		r.id,
		r.project_id,
		r.engine_version,
		to_char(r.start_date, 'YYYY-MM-DD'),
		to_char(r.end_date, 'YYYY-MM-DD'),
		r."trigger",
		r.scenario_id IS NOT NULL AND r.scenario_id::text IS DISTINCT FROM r.inputs->'scenario'->>'id',
		encode(sha256(convert_to(r.inputs::text, 'UTF8')), 'hex'),
		encode(sha256(convert_to(r.summary::text, 'UTF8')), 'hex'),
		(SELECT COALESCE(jsonb_agg(jsonb_build_array(i.kind, to_char(i.start_date, 'YYYY-MM-DD'), i.sha256) ORDER BY i.kind COLLATE "C"), '[]'::jsonb)
		 FROM run_input_series i WHERE i.run_id = r.id),
		p_series
	)::text, 'UTF8'))
	FROM model_run r
	WHERE r.id = p_run AND p_series IS NOT NULL
	$$;
REVOKE ALL ON FUNCTION app_run_digest_from(uuid, jsonb) FROM PUBLIC, water_app;

-- From 115 (its latest): the same digest, the series part now passed to app_run_digest_from.
CREATE OR REPLACE FUNCTION app_run_digest_body(p_run uuid) RETURNS bytea
	LANGUAGE sql STABLE SET search_path = public
	AS $$
	SELECT app_run_digest_from(p_run, (
		SELECT COALESCE(jsonb_agg(jsonb_build_array(s.node_id, s.key, s.meta, encode(sha256(array_send(s."values")), 'hex'))
			ORDER BY s.node_id NULLS FIRST, s.key COLLATE "C"), '[]'::jsonb)
		FROM run_series s WHERE s.run_id = p_run
	))
	$$;
REVOKE ALL ON FUNCTION app_run_digest_body(uuid) FROM PUBLIC, water_app;

-- The digest storeRun signs: the series' hashes given (p_node_ids, p_keys,
-- p_sha256, one entry a series, NULL node = catchment-level), the rest read.
CREATE FUNCTION app_run_signing_digest(p_run uuid, p_node_ids uuid[], p_keys text[], p_sha256 text[]) RETURNS bytea
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	WITH given AS (
		SELECT g.node_id, g.key, g.sha FROM unnest(p_node_ids, p_keys, p_sha256) AS g(node_id, key, sha)
	), stored AS (
		-- Equality on both sides (a NULL node matched as its own case), so this is one hash join, not 432².
		SELECT s.node_id, s.key, s.meta, g.sha
		FROM run_series s
		LEFT JOIN given g ON (g.node_id IS NULL) = (s.node_id IS NULL)
			AND coalesce(g.node_id, '00000000-0000-0000-0000-000000000000') = coalesce(s.node_id, '00000000-0000-0000-0000-000000000000')
			AND g.key = s.key
		WHERE s.run_id = p_run
	)
	SELECT app_run_digest_from(r.id, (
		-- One well-formed hash for each stored series, and nothing given that wasn't stored: else no digest.
		SELECT CASE
			WHEN count(*) = count(st.sha)
				AND count(*) = (SELECT count(*) FROM given)
				AND count(*) = (SELECT count(*) FROM (SELECT DISTINCT g.node_id, g.key FROM given g) d)
				AND bool_and(st.sha ~ '^[0-9a-f]{64}$') IS NOT FALSE
			THEN COALESCE(jsonb_agg(jsonb_build_array(st.node_id, st.key, st.meta, st.sha) ORDER BY st.node_id NULLS FIRST, st.key COLLATE "C"), '[]'::jsonb)
		END
		FROM stored st
	))
	FROM model_run r
	WHERE r.id = p_run AND r.stamp IS NULL AND r.created_by = app_current_user_id() AND r.created_at = now()
	  AND cardinality(p_node_ids) = cardinality(p_keys) AND cardinality(p_keys) = cardinality(p_sha256)
	$$;
REVOKE ALL ON FUNCTION app_run_signing_digest(uuid, uuid[], text[], text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_run_signing_digest(uuid, uuid[], text[], text[]) TO water_app;
