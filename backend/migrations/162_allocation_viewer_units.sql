-- 162_allocation_viewer_units — registered water use (WARMS and the like)
-- outside the organisation: decision D3, provisional position (pre-counsel
-- research, 2026-10-01; docs/allocations.md § Who sees what, docs/security.md
-- § Allocations).
--
-- A per-farm registered volume beside a farm's name identifies its holder in
-- a rural catchment even without the holder's name, and viewers include
-- outside NGOs posting public-participation comments (POPIA s10, s15; NWA
-- s142 makes WARMS available only "subject to any limitations imposed by
-- law", and PAIA s34 would have DWS refuse a stranger this). So:
--
--  1. project.allocations_viewer_units, off by default: whether the
--     project's viewers read each allocation row (each farm's volumes). Only
--     an owner switches it (app_set_allocations_viewer_units), when every
--     viewer works for or was appointed by the organisation;
--     allocation_viewer_units_guard refuses water_app's own write.
--  2. allocation_select (038's, by its exact name): editors and owners as
--     before; viewers only while the project allows it. A farmer still reads
--     their own farms' rows (allocation_select_farmer, unchanged); names stay
--     editors' and the linked farmer's (allocation_holder_select, unchanged).
--  3. app_allocation_volumes(project): for the totals a viewer gets instead
--     (GET …/allocations and the run comparison sum them per water source,
--     never per unit), the volumes of each water source held by at least 5
--     holders (the share links' k, FARMER_K); a source with fewer returns
--     nothing. Holders are counted as distinct registered users: the name
--     (ignoring case and spaces), else a name another row of the same unit
--     carries (an unnamed row on a named holder's farm doesn't count twice),
--     else the unit, else the row. No name, registration number or property
--     leaves it.
--  4. allocation_source.reference is required for a WARMS extract: how the
--     organisation obtained it (the DWS or CMA letter or terms; operator
--     agreement 3A.1(d)). Existing rows without one are marked as such.

-- ---------------------------------------------------------------------------
-- 1. The project's switch
-- ---------------------------------------------------------------------------
ALTER TABLE project ADD COLUMN allocations_viewer_units boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN project.allocations_viewer_units IS
	'Viewers read each registered volume (allocation rows) only when true (162, decision D3); otherwise totals per water source at 5 or more holders (app_allocation_volumes). Owners set it (app_set_allocations_viewer_units).';

CREATE FUNCTION allocation_viewer_units_guard() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF current_user = 'water_app' AND (
			(TG_OP = 'INSERT' AND NEW.allocations_viewer_units)
			OR (TG_OP = 'UPDATE' AND NEW.allocations_viewer_units IS DISTINCT FROM OLD.allocations_viewer_units)
		) THEN
			RAISE EXCEPTION 'only an owner lets viewers read each registered volume (app_set_allocations_viewer_units)'
				USING ERRCODE = 'insufficient_privilege';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER allocation_viewer_units_guard BEFORE INSERT OR UPDATE ON project
	FOR EACH ROW EXECUTE FUNCTION allocation_viewer_units_guard();

-- Owners only. Returns whether it changed.
CREATE FUNCTION app_set_allocations_viewer_units(p_project uuid, p_on boolean) RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_changed boolean;
	BEGIN
		IF NOT app_has_role(p_project, 'owner') THEN
			RAISE EXCEPTION 'only an owner decides whether viewers read each registered volume' USING ERRCODE = 'insufficient_privilege';
		END IF;
		UPDATE project SET allocations_viewer_units = p_on
			WHERE id = p_project AND allocations_viewer_units IS DISTINCT FROM p_on
			RETURNING true INTO v_changed;
		RETURN coalesce(v_changed, false);
	END
	$$;

-- The policy's lookup. Definer: the policy runs it for any reader.
CREATE FUNCTION app_allocations_viewer_units(p_project uuid) RETURNS boolean
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT coalesce((SELECT p.allocations_viewer_units FROM project p WHERE p.id = p_project), false)
	$$;

-- ---------------------------------------------------------------------------
-- 2. allocation_select (038), now with the switch
-- ---------------------------------------------------------------------------
DROP POLICY allocation_select ON allocation;
CREATE POLICY allocation_select ON allocation FOR SELECT USING (
	app_has_role(project_id, 'editor')
	OR (app_has_role(project_id, 'viewer') AND app_allocations_viewer_units(project_id))
);

-- ---------------------------------------------------------------------------
-- 3. The volumes behind a viewer's totals
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_allocation_volumes(p_project uuid)
	RETURNS TABLE (water_source text, holders integer, node_id uuid, volume_m3_year double precision, storage_m3 double precision,
		water_use text, valid_from date, valid_to date)
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	BEGIN
		IF NOT app_has_role(p_project, 'viewer') THEN
			RAISE EXCEPTION 'not a member of this project' USING ERRCODE = 'insufficient_privilege';
		END IF;
		RETURN QUERY
		WITH named AS (
			-- Each row's holder, normalised; NULL when it has none.
			SELECT a.id, a.node_id, a.water_source, nullif(lower(regexp_replace(btrim(h.user_display), '\s+', ' ', 'g')), '') AS name
			FROM allocation a LEFT JOIN allocation_holder h ON h.allocation_id = a.id
			WHERE a.project_id = p_project
		), k AS (
			SELECT x.water_source, count(DISTINCT coalesce(
				'h:' || x.name,
				'h:' || (SELECT min(y.name) FROM named y WHERE y.node_id = x.node_id AND y.name IS NOT NULL),
				'n:' || x.node_id::text,
				'a:' || x.id::text
			))::integer AS holders
			FROM named x
			GROUP BY x.water_source
		)
		SELECT a.water_source, k.holders, a.node_id, a.volume_m3_year, a.storage_m3, a.water_use, a.valid_from, a.valid_to
		FROM allocation a JOIN k ON k.water_source = a.water_source
		WHERE a.project_id = p_project AND k.holders >= 5
		ORDER BY a.water_source, a.id;
	END
	$$;
COMMENT ON FUNCTION app_allocation_volumes(uuid) IS
	'The volumes behind a viewer''s registered-water totals (162, D3): each water source held by at least 5 registered users (FARMER_K), no name, number or property. The API sums them; it never returns a row.';

REVOKE ALL ON FUNCTION allocation_viewer_units_guard() FROM PUBLIC, water_app;
REVOKE ALL ON FUNCTION app_set_allocations_viewer_units(uuid, boolean), app_allocations_viewer_units(uuid), app_allocation_volumes(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_set_allocations_viewer_units(uuid, boolean), app_allocations_viewer_units(uuid), app_allocation_volumes(uuid) TO water_app;

-- ---------------------------------------------------------------------------
-- 4. A WARMS extract says how it was obtained
-- ---------------------------------------------------------------------------
UPDATE allocation_source SET reference = 'Not recorded (imported before the reference was required)'
	WHERE kind = 'warms_extract' AND btrim(reference) = '';
ALTER TABLE allocation_source ADD CONSTRAINT allocation_source_warms_reference
	CHECK (kind <> 'warms_extract' OR btrim(reference) <> '');
