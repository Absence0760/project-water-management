-- 077_run_stamp — runs signed by the backend (docs/security.md § Applicants,
-- § Run stamps; docs/data-model.md § Runs).
--
-- model_run_insert_contributor (045) lets an applicant insert their own
-- application's run rows, and the editors' policies (001) let an editor insert
-- any run of their project: the database can't tell a row the backend stored
-- after running the engine from one written straight in SQL as the same role
-- and user. So the backend signs every run it stores: `stamp` is an
-- HMAC-SHA256, under a key the database never holds (derived from
-- AUTH_JWT_SECRET, backend/src/runs/stamp.ts), over app_run_digest(run). A
-- sign-off and an application's decision refuse a run whose stamp is missing
-- or doesn't match; the run responses say `verified`.
--
-- app_run_digest is a SHA-256 over a canonical encoding of what a run's
-- evidence is: its id, project, engine version, dates, trigger, the inputs
-- snapshot, the summary, its stored input series (kind, start, blob hash; each
-- blob keyed by its own content since 074) and every output series (node,
-- key, meta and the values' binary encoding). What it leaves out changes
-- legitimately after the run: the note, the pin, the label shown, who made it
-- (account deletion), the input series' live series id (ON DELETE SET NULL,
-- 056) and the scenario id (ON DELETE SET NULL, 024; the snapshot's scenario
-- id is covered through `inputs`, and a column that names another scenario
-- than the snapshot changes the digest).
--
-- Every piece is rendered independently of session settings: jsonb and uuid
-- text, dates through to_char, float8 arrays through array_send (IEEE bytes),
-- series ordered by node and key under the "C" collation.
--
-- SECURITY DEFINER, since the storing transaction of an applicant can't read
-- its own run's rows (046): it answers only for a run the caller reads under
-- model_run_select (046, latest) or a scenario run they stored in this very
-- transaction (app_own_new_scenario_run, 046); anyone else gets NULL. A digest
-- of a run you read tells you nothing its rows don't.

ALTER TABLE model_run ADD COLUMN stamp bytea CHECK (stamp IS NULL OR octet_length(stamp) = 32);
COMMENT ON COLUMN model_run.stamp IS
	'HMAC-SHA256 of app_run_digest(id) under the backend''s run-stamp key (077); NULL = not stored by the backend (or before 077): unverified.';

CREATE FUNCTION app_run_digest(p_run uuid) RETURNS bytea
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
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
		(SELECT COALESCE(jsonb_agg(jsonb_build_array(s.node_id, s.key, s.meta, encode(sha256(array_send(s."values")), 'hex'))
			ORDER BY s.node_id NULLS FIRST, s.key COLLATE "C"), '[]'::jsonb)
		 FROM run_series s WHERE s.run_id = r.id)
	)::text, 'UTF8'))
	FROM model_run r
	WHERE r.id = p_run
	  AND (
		(app_has_role(r.project_id, 'viewer') AND (r.scenario_id IS NULL OR app_scenario_readable(r.scenario_id)))
		OR app_own_new_scenario_run(r.project_id, r.id)
	  )
	$$;

-- The backend writes the stamp of a run it has just stored, in the storing
-- transaction (runs/execute.ts storeRun). water_app has no UPDATE on the
-- column (its column grants are notes and pinned, 007/015), so this is the
-- one writer: only the run's maker, only in the transaction that made it,
-- only once. A caller without the key can write only a stamp that doesn't
-- verify.
CREATE FUNCTION app_set_run_stamp(p_run uuid, p_stamp bytea) RETURNS boolean
	LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		UPDATE model_run SET stamp = p_stamp
		WHERE id = p_run AND stamp IS NULL AND created_by = app_current_user_id() AND created_at = now();
		RETURN FOUND;
	END
	$$;

REVOKE ALL ON FUNCTION app_run_digest(uuid), app_set_run_stamp(uuid, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_run_digest(uuid), app_set_run_stamp(uuid, bytea) TO water_app;
