-- 230_run_allocation_authorisation — freeze how each of a run's registered
-- volumes was held (licence, verified existing lawful use, registration, …)
-- with the run, so the headline board's authorised volume mix is the one the
-- baseline's rows gave, not the allocation rows as they are when the board is
-- built (issue #523 G2; docs/evidence-pack.md § Both impact bases).
--
-- 219 froze each run's holder keys in run_allocation_holder from the rows as
-- they were when the run was stored. This adds the row's `authorisation`
-- beside the key, written by the same trigger, and a lookup for it:
--
--  1. run_allocation_holder.authorisation: the allocation row's authorisation
--     when the run was stored; NULL for a row with no living row then (one a
--     scenario op added), which the mix counts as "unknown". Existing runs are
--     filled here from the rows living now (a run stored before 230 has no
--     other record of them), as 219 filled the keys. Owner-only, like the rest
--     of the table. Not personal information: it isn't reset on erasure.
--  2. run_allocation_holder_fill: 219's, by its latest definition (219), plus
--     the authorisation.
--  3. app_run_allocation_kinds(project, run, ids): the authorisation of the
--     given rows of one run, for a member from viewer up who can read that
--     run (model_run_select's rule, 046, as app_run_allocation_holders). The
--     board's builder (an editor) reads it; no volume, no holder.

-- ---------------------------------------------------------------------------
-- 1. The column, and existing runs
-- ---------------------------------------------------------------------------
ALTER TABLE run_allocation_holder ADD COLUMN authorisation text;
COMMENT ON COLUMN run_allocation_holder.authorisation IS
	'230 (#523 G2): the allocation row''s authorisation when the run was stored; NULL for a row with no living row then. Read by app_run_allocation_kinds.';

UPDATE run_allocation_holder h SET authorisation = a.authorisation
	FROM model_run r, allocation a
	WHERE r.id = h.run_id AND a.project_id = r.project_id AND a.id::text = h.allocation_id;

-- ---------------------------------------------------------------------------
-- 2. Written with the keys
-- ---------------------------------------------------------------------------
-- Latest definition: 219_allocation_holder_keys.sql. Adds the authorisation.
CREATE OR REPLACE FUNCTION run_allocation_holder_fill(p_project uuid, p_run uuid, p_inputs jsonb) RETURNS void
	LANGUAGE sql SET search_path = public
	AS $$
		INSERT INTO run_allocation_holder (run_id, allocation_id, holder, authorisation)
		SELECT p_run, e->>'id', coalesce(k.holder, 'gone'), a.authorisation
		FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_inputs->'model'->'allocations') = 'array' THEN p_inputs->'model'->'allocations' ELSE '[]'::jsonb END) e
		LEFT JOIN app_allocation_holder_keys(p_project) k ON k.id::text = e->>'id'
		LEFT JOIN allocation a ON a.project_id = p_project AND a.id::text = e->>'id'
		WHERE e->>'id' IS NOT NULL
		ON CONFLICT DO NOTHING
	$$;
REVOKE ALL ON FUNCTION run_allocation_holder_fill(uuid, uuid, jsonb) FROM PUBLIC, water_app;

-- ---------------------------------------------------------------------------
-- 3. A run's kinds, for the headline board's mix
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_run_allocation_kinds(p_project uuid, p_run uuid, p_ids text[])
	RETURNS TABLE (allocation_id text, authorisation text)
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	BEGIN
		IF NOT app_has_role(p_project, 'viewer') THEN
			RAISE EXCEPTION 'not a member of this project' USING ERRCODE = 'insufficient_privilege';
		END IF;
		-- Only a run the caller can read: model_run_select's rule (latest: 046), as this definer reads past it.
		IF NOT EXISTS (SELECT 1 FROM model_run r WHERE r.id = p_run AND r.project_id = p_project AND (r.scenario_id IS NULL OR app_scenario_readable(r.scenario_id))) THEN
			RETURN;
		END IF;
		RETURN QUERY
		SELECT h.allocation_id, h.authorisation
		FROM run_allocation_holder h
		WHERE h.run_id = p_run AND h.allocation_id = ANY(p_ids)
		ORDER BY h.allocation_id;
	END
	$$;
COMMENT ON FUNCTION app_run_allocation_kinds(uuid, uuid, text[]) IS
	'How the given allocation rows of one run the caller can read were held when it was stored (230, #523 G2): the headline board''s authorised volume mix as at the baseline. No volume, no holder.';
REVOKE ALL ON FUNCTION app_run_allocation_kinds(uuid, uuid, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_run_allocation_kinds(uuid, uuid, text[]) TO water_app;
