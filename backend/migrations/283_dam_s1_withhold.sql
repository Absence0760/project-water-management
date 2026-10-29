-- 283_dam_s1_withhold — the worker withholds a dam's Sentinel-1 radar rows
-- (issue #624 open question 3; docs/architecture.md § Dam observations,
-- docs/data-model.md § Dam observations).
--
-- Radar's water threshold is fixed, not tuned per dam, so its rows reach
-- users only for a dam whose own S1/S2 agreement passes (the fetcher's
-- dams/s1-agreement.json: at least 10 paired days, 85 % of them within 0.1
-- of the full area), and only with DAM_OBSERVATIONS_S1=on. In `measure`
-- (the pass runs and the agreement is logged) and `off`, and for a dam that
-- doesn't pass (or has too few pairs to judge), the worker loads none, and
-- removes any it loaded before: a dam that stops passing, or radar turned
-- back to measure or off, takes its radar off the panel and the farm card.
-- The rows come back from the pass's file when the dam passes again.
--
-- New function only: app_dam_s1_withhold(key) deletes one dam's 's1' rows.
-- Worker only (mirror_worker_context, 245), as 261's loader and marks are;
-- SECURITY DEFINER because water_app holds no DELETE on dam_observation;
-- search_path pinned. No table, policy, grant on a table or trigger changes.

CREATE FUNCTION app_dam_s1_withhold(p_key text, OUT removed integer)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NOT mirror_worker_context() THEN
			RAISE EXCEPTION 'only the worker withholds dam observations' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_key IS NULL OR p_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
			RAISE EXCEPTION 'not a dam feature id' USING ERRCODE = 'check_violation';
		END IF;
		DELETE FROM dam_observation WHERE feature_id = p_key::uuid AND source = 's1';
		GET DIAGNOSTICS removed = ROW_COUNT;
	END
	$$;
COMMENT ON FUNCTION app_dam_s1_withhold(text) IS
	'Remove one dam''s Sentinel-1 radar rows (283, issue #624): radar is shown only for a dam whose S1/S2 agreement passes, with DAM_OBSERVATIONS_S1=on. For the worker (no user) only.';
REVOKE ALL ON FUNCTION app_dam_s1_withhold(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_dam_s1_withhold(text) TO water_app;
