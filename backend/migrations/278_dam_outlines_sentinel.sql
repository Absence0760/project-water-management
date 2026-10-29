-- 278_dam_outlines_sentinel — the dams tick's list of traced dams also gives
-- each dam's newest Sentinel-2 (s2) and Sentinel-1 (s1) observation, so the
-- wanted list can tell those passes where a dam's rows end, as it does WOfS
-- (issue #624 step 4; docs/data-model.md § Dam observations,
-- docs/architecture.md § Dam observations).
--
-- From app_dam_outlines' latest (and only) definition, 261's, unchanged but
-- for two columns added at the end: s2_newest and s1_newest, the newest
-- obs_date per source as waterbodies_newest and wofs_newest are. Postgres
-- can't change a function's result columns in place, so it is dropped and
-- created again: SECURITY DEFINER, STABLE, search_path pinned, and its
-- REVOKE from PUBLIC and GRANT to water_app restated. Nothing depends on it
-- (no view, no other function); the worker's one caller
-- (dams/observed/match.ts damOutlines) names its columns, so it reads the new
-- ones from the release that ships with this migration and ignores them
-- before. Dropping and creating in one transaction (the runner's), the
-- caller never sees it missing.
--
-- No table, policy, grant on a table, trigger or index changes. The extra
-- subqueries read dam_observation's UNIQUE (feature_id, source, obs_date) index,
-- as the two before them do.

DROP FUNCTION app_dam_outlines();

CREATE FUNCTION app_dam_outlines()
	RETURNS TABLE (
		feature_id uuid, project_id uuid, geometry jsonb, area_m2 double precision, updated_at timestamptz,
		status text, uid text, match_stale boolean, matched_at timestamptz, waterbodies_newest date, wofs_newest date,
		s2_newest date, s1_newest date
	)
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NOT mirror_worker_context() THEN
			RAISE EXCEPTION 'only the worker lists the traced dams' USING ERRCODE = 'insufficient_privilege';
		END IF;
		RETURN QUERY
			SELECT f.id, f.project_id, f.geometry, f.area_m2, f.updated_at,
				m.status, m.uid,
				m.feature_id IS NULL OR m.matched_at < coalesce((SELECT max(r.loaded_at) FROM waterbody_reference r), '-infinity'),
				m.matched_at,
				(SELECT max(o.obs_date) FROM dam_observation o WHERE o.feature_id = f.id AND o.source = 'waterbodies'),
				(SELECT max(o.obs_date) FROM dam_observation o WHERE o.feature_id = f.id AND o.source = 'wofs'),
				(SELECT max(o.obs_date) FROM dam_observation o WHERE o.feature_id = f.id AND o.source = 's2'),
				(SELECT max(o.obs_date) FROM dam_observation o WHERE o.feature_id = f.id AND o.source = 's1')
			FROM map_feature f
			LEFT JOIN dam_waterbody_match m ON m.feature_id = f.id
			WHERE f.kind = 'dam' AND f.geometry ->> 'type' IN ('Polygon', 'MultiPolygon')
			ORDER BY f.created_at, f.id
			LIMIT 5000;
	END
	$$;
COMMENT ON FUNCTION app_dam_outlines() IS
	'Every traced dam polygon with its waterbody match and newest observation per source, waterbodies, wofs, s2 and s1 (261, 278), for the worker (no user) only.';
REVOKE ALL ON FUNCTION app_dam_outlines() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_dam_outlines() TO water_app;
