-- 281_et_units — what the observed ET tick reads to write the WaPOR pass's
-- wanted list (issue #623 step 4; docs/architecture.md § Observed actual ET).
--
-- 277 gave the worker its loader and load marks but no way to list the units
-- to observe: the worker runs with no user (245 mirror_worker_context), and
-- both map_feature (a project's) and cropland_cell_reference (173: any signed-in
-- user) need one under RLS. So, two worker-only reads, like 261's
-- app_dam_outlines and app_waterbody_candidates:
--  * app_et_units(): every unit (a node of kind 'farm') in any project with
--    at least one farm parcel, its parcels' polygons as one jsonb array, and
--    when its parcels last changed (277's load mark for the source asked), so
--    the wanted list changes whenever the parcels do, even back to the same
--    shape (each change drops the unit's rows, so the pass must hand over a
--    file made after it). At most 5000 units, by unit id.
--  * app_et_cropland(box): the default land-cover dataset's cropland cells in
--    a box of at most 1° a side (the real dataset before the synthetic one,
--    then the newest load: cropland.ts croplandDatasets' order), with the
--    dataset's label and cell size on every row. No rows: no dataset loaded,
--    or no cropland there. The pass weights each WaPOR pixel by the cropland
--    share of the cell its centre is in (parcels ∩ cropland).
-- Neither writes anything, and neither returns a name, a user or a value of
-- the model: only geometry, ids and times. Worker only: water_app may call
-- them, and they refuse unless the session is the worker's (no user, no API
-- key).

CREATE FUNCTION app_et_units(p_source text)
	RETURNS TABLE (node_id uuid, project_id uuid, parcels jsonb, parcels_changed_at timestamptz)
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NOT mirror_worker_context() THEN
			RAISE EXCEPTION 'only the worker lists the units observed ET is read for' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_source IS NULL OR p_source NOT IN ('wapor', 'ssebop') THEN
			RAISE EXCEPTION 'not an observed ET source' USING ERRCODE = 'check_violation';
		END IF;
		RETURN QUERY
			SELECT n.id, n.project_id,
				(SELECT jsonb_agg(f.geometry ORDER BY f.id) FROM map_feature f
					WHERE f.node_id = n.id AND f.kind = 'farm_parcel' AND f.geometry ->> 'type' IN ('Polygon', 'MultiPolygon')),
				k.parcels_changed_at
			FROM node n
			LEFT JOIN et_observation_load_mark k ON k.node_id = n.id AND k.source = p_source
			WHERE n.kind = 'farm'
				AND EXISTS (SELECT 1 FROM map_feature f WHERE f.node_id = n.id AND f.kind = 'farm_parcel' AND f.geometry ->> 'type' IN ('Polygon', 'MultiPolygon'))
			ORDER BY n.id
			LIMIT 5000;
	END
	$$;
COMMENT ON FUNCTION app_et_units(text) IS
	'Every unit with farm parcels, its parcels'' polygons and when they last changed (281, issue #623): the ET tick''s wanted list, for the worker (no user) only.';
REVOKE ALL ON FUNCTION app_et_units(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_et_units(text) TO water_app;

CREATE FUNCTION app_et_cropland(p_w double precision, p_s double precision, p_e double precision, p_n double precision)
	RETURNS TABLE (dataset text, cell_deg double precision, row_idx integer, col_idx integer, fraction real)
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		d cropland_dataset%ROWTYPE;
	BEGIN
		IF NOT mirror_worker_context() THEN
			RAISE EXCEPTION 'only the worker reads the cropland for observed ET' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_w IS NULL OR p_s IS NULL OR p_e IS NULL OR p_n IS NULL OR NOT (p_w <= p_e AND p_s <= p_n AND p_e - p_w <= 1 AND p_n - p_s <= 1)
			OR p_w < -180 OR p_e > 180 OR p_s < -90 OR p_n > 90 THEN
			RAISE EXCEPTION 'not a box of at most 1° a side' USING ERRCODE = 'check_violation';
		END IF;
		SELECT * INTO d FROM cropland_dataset c ORDER BY c.dataset = 'synthetic', c.loaded_at DESC, c.dataset LIMIT 1;
		IF d.dataset IS NULL THEN
			RETURN;
		END IF;
		-- Cell (row, col) is the square with south-west corner (col × cell_deg, row × cell_deg) (173).
		RETURN QUERY
			SELECT d.dataset, d.cell_deg, c.row_idx, c.col_idx, c.fraction
			FROM cropland_cell_reference c
			WHERE c.dataset = d.dataset
				AND c.row_idx >= floor(p_s / d.cell_deg)::integer AND c.row_idx <= floor(p_n / d.cell_deg)::integer
				AND c.col_idx >= floor(p_w / d.cell_deg)::integer AND c.col_idx <= floor(p_e / d.cell_deg)::integer
			ORDER BY c.row_idx, c.col_idx
			LIMIT 200000;
	END
	$$;
COMMENT ON FUNCTION app_et_cropland(double precision, double precision, double precision, double precision) IS
	'The default land-cover dataset''s cropland cells in a box of at most 1° (281, issue #623): the WaPOR pass''s cropland mask, for the worker (no user) only.';
REVOKE ALL ON FUNCTION app_et_cropland(double precision, double precision, double precision, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_et_cropland(double precision, double precision, double precision, double precision) TO water_app;
