-- 215_allocation_holder_keys — gate every "5 or more registered users"
-- total on the holders whose volumes are in it (issue #523 G, decision D3;
-- docs/security.md § Allocations, docs/allocations.md § Who sees what).
--
-- 162's app_allocation_volumes counts a water source's holders over all of
-- its rows, whatever their dates, but the totals the API sums from it are of
-- the rows in force on a day (GET …/allocations) or in a water year (the run
-- comparison's totals, the evidence report's "Other registered users"). With
-- staggered valid_from / valid_to, a total of "5 or more" could be one
-- holder's volume. So each row now carries an opaque holder key, and the
-- caller counts the holders of the rows it actually sums:
--
--  1. app_allocation_holder_keys(project): internal (not SECURITY DEFINER,
--     not granted): every row of the project with its holder, counted as 162
--     counts them (the name ignoring case and spaces, else a name another row
--     of the same unit carries, else the unit, else the row), as an ordinal
--     1..n over the md5 of the project and that key. The ordinal says only
--     which rows share a holder: no name, and not a hash a list of names
--     could be matched against.
--  2. app_allocation_volumes(project): 162's, by its latest definition (162),
--     plus `holder`, that ordinal. Its return type changes, so it is dropped
--     and created again, with 162's grants.
--  3. app_allocation_holders(project): every row's id, unit and holder
--     ordinal, no volume, for any member from viewer up: the evidence report
--     (§ 5's per-year gate) and the authorised-impact board read the run's
--     own allocation ids against it, whoever builds the report, so the
--     report is the same for every reader.

-- ---------------------------------------------------------------------------
-- 1. Each row's holder, as an ordinal
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_allocation_holder_keys(p_project uuid)
	RETURNS TABLE (id uuid, node_id uuid, water_source text, holder integer)
	LANGUAGE sql STABLE SET search_path = public
	AS $$
		WITH named AS (
			SELECT a.id, a.node_id, a.water_source, nullif(lower(regexp_replace(btrim(h.user_display), '\s+', ' ', 'g')), '') AS name
			FROM allocation a LEFT JOIN allocation_holder h ON h.allocation_id = a.id
			WHERE a.project_id = p_project
		), keyed AS (
			SELECT x.id, x.node_id, x.water_source, coalesce(
				'h:' || x.name,
				'h:' || (SELECT min(y.name) FROM named y WHERE y.node_id = x.node_id AND y.name IS NOT NULL),
				'n:' || x.node_id::text,
				'a:' || x.id::text
			) AS k
			FROM named x
		)
		SELECT keyed.id, keyed.node_id, keyed.water_source, (dense_rank() OVER (ORDER BY md5(p_project::text || keyed.k)))::integer
		FROM keyed
	$$;
COMMENT ON FUNCTION app_allocation_holder_keys(uuid) IS
	'Internal (215, #523 G): each allocation row of a project with its holder as an ordinal, counted as 162 counts holders. Called only by app_allocation_volumes and app_allocation_holders, which check the caller''s role.';
REVOKE ALL ON FUNCTION app_allocation_holder_keys(uuid) FROM PUBLIC, water_app;

-- ---------------------------------------------------------------------------
-- 2. The volumes behind a viewer's totals, each with its holder
-- ---------------------------------------------------------------------------
-- Latest definition: 162_allocation_viewer_units.sql. Adds `holder`.
DROP FUNCTION app_allocation_volumes(uuid);
CREATE FUNCTION app_allocation_volumes(p_project uuid)
	RETURNS TABLE (water_source text, holders integer, holder integer, node_id uuid, volume_m3_year double precision, storage_m3 double precision,
		water_use text, valid_from date, valid_to date)
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	BEGIN
		IF NOT app_has_role(p_project, 'viewer') THEN
			RAISE EXCEPTION 'not a member of this project' USING ERRCODE = 'insufficient_privilege';
		END IF;
		RETURN QUERY
		WITH h AS (
			SELECT * FROM app_allocation_holder_keys(p_project)
		), k AS (
			SELECT h.water_source, count(DISTINCT h.holder)::integer AS holders FROM h GROUP BY h.water_source
		)
		SELECT a.water_source, k.holders, h.holder, a.node_id, a.volume_m3_year, a.storage_m3, a.water_use, a.valid_from, a.valid_to
		FROM allocation a
		JOIN h ON h.id = a.id
		JOIN k ON k.water_source = a.water_source
		WHERE a.project_id = p_project AND k.holders >= 5
		ORDER BY a.water_source, a.id;
	END
	$$;
COMMENT ON FUNCTION app_allocation_volumes(uuid) IS
	'The volumes behind a viewer''s registered-water totals (162, D3; 215): each water source held by at least 5 registered users (FARMER_K), each row with an opaque holder ordinal so the API counts the holders of the rows it sums (in force that day or year) and gives no total of fewer than 5. No name, number or property. The API sums them; it never returns a row.';

-- ---------------------------------------------------------------------------
-- 3. Who holds each row: for § 5's per-year gate and the authorised mix
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_allocation_holders(p_project uuid)
	RETURNS TABLE (id uuid, node_id uuid, holder integer)
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	BEGIN
		IF NOT app_has_role(p_project, 'viewer') THEN
			RAISE EXCEPTION 'not a member of this project' USING ERRCODE = 'insufficient_privilege';
		END IF;
		RETURN QUERY SELECT h.id, h.node_id, h.holder FROM app_allocation_holder_keys(p_project) h ORDER BY h.id;
	END
	$$;
COMMENT ON FUNCTION app_allocation_holders(uuid) IS
	'Each allocation row''s id, unit and opaque holder ordinal (215, #523 G), no volume: the evidence report counts the holders behind each "Other registered users" year from a run''s own allocation ids, the same for every reader. The API never returns it.';

REVOKE ALL ON FUNCTION app_allocation_volumes(uuid), app_allocation_holders(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_allocation_volumes(uuid), app_allocation_holders(uuid) TO water_app;
