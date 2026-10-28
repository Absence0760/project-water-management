-- 273_acceptance_polygons — which polygon a unit's MAP, a land-cover area and
-- an evaporation row were taken over, and where a gauge stood when it became
-- its node (issue #646 item 4, the hydrologist's review F7, F8 and F9;
-- docs/maps.md § Checks, § MAP for each unit, § Cultivated area from land
-- cover, § Evaporation from the map).
--
-- A unit's rain feed already records the polygon its cells came from (the
-- feed config's `unit` mark: featureId, updatedAt, areaKm2), and the boundary's
-- rain feed the boundary's (`boundary`), so a redrawn outline can be told
-- apart. A unit's MAP from the grid (node.map_mm), a planted area from land
-- cover (crop_area_land_cover, 174) and an evaporation row from the map
-- (evaporation_accepted, 181) recorded nothing of the kind, and a gauge's link
-- to its node nothing of where it stood, so the Map's Checks and the Start
-- data list could not say that any of them was taken over an outline since
-- redrawn, or from a gauge since moved. Expand only:
--
--  * node.map_polygon: the polygon POST …/map/unit-map took the unit's MAP
--    over, `{ featureId, updatedAt, areaM2 }` as it stood then. Cleared when
--    the MAP is changed by a model save (model/store.ts), since a typed MAP
--    is over no polygon. NULL: unknown (a MAP from before 273, or typed).
--  * crop_area_land_cover.polygons: the polygons the area was summed over,
--    each `{ featureId, updatedAt, areaM2 }`. NULL: unknown (from before 273).
--  * evaporation_accepted.boundary: the catchment boundary the 12 values were
--    summarised over, `{ featureId, updatedAt, areaM2 }`. NULL: from before 273.
--  * map_feature.link_point: a gauge's geometry (a Point) when it was linked
--    to its node, set by the trigger below and by nothing else: on insert
--    with a node, and whenever the node changes; NULL for anything but a
--    linked gauge, and for a gauge linked before 273 (unknown: no backfill,
--    since the update would stamp every gauge's updated_at). The Map's Checks
--    say how far a gauge moved since (F9).
--
-- The stamps are a record of what was read, never a link: no foreign key, so
-- deleting or redrawing a polygon leaves the record to say it changed. RLS,
-- policies, grants and the same-project triggers of the four tables are
-- unchanged (a column inherits them; water_app's grants on them are
-- table-wide). No personal information. The trigger function is SECURITY
-- INVOKER and pins its search_path (catalogue.db.test.ts).

ALTER TABLE node ADD COLUMN map_polygon jsonb
	CHECK (map_polygon IS NULL OR (jsonb_typeof(map_polygon) = 'object' AND map_polygon ?& ARRAY['featureId', 'updatedAt', 'areaM2'] AND octet_length(map_polygon::text) <= 500));
COMMENT ON COLUMN node.map_polygon IS
	'The polygon the unit''s MAP from the grid was taken over (273, issue #646 F7): { featureId, updatedAt, areaM2 } then. Cleared when a model save changes the MAP; NULL = unknown or typed.';

ALTER TABLE crop_area_land_cover ADD COLUMN polygons jsonb
	CHECK (polygons IS NULL OR CASE WHEN jsonb_typeof(polygons) = 'array' THEN jsonb_array_length(polygons) BETWEEN 1 AND 500 AND octet_length(polygons::text) <= 100000 ELSE false END);
COMMENT ON COLUMN crop_area_land_cover.polygons IS
	'The polygons the accepted area was summed over (273, issue #646 F7): [{ featureId, updatedAt, areaM2 }] then. NULL = from before 273.';

ALTER TABLE evaporation_accepted ADD COLUMN boundary jsonb
	CHECK (boundary IS NULL OR (jsonb_typeof(boundary) = 'object' AND boundary ?& ARRAY['featureId', 'updatedAt', 'areaM2'] AND octet_length(boundary::text) <= 500));
COMMENT ON COLUMN evaporation_accepted.boundary IS
	'The catchment boundary the values were summarised over (273, issue #646 F8): { featureId, updatedAt, areaM2 } then. NULL = from before 273.';

ALTER TABLE map_feature ADD COLUMN link_point jsonb
	CHECK (link_point IS NULL OR (kind = 'gauge' AND jsonb_typeof(link_point) = 'object' AND link_point ->> 'type' = 'Point' AND octet_length(link_point::text) <= 200));
COMMENT ON COLUMN map_feature.link_point IS
	'A gauge''s geometry when it was linked to its node (273, issue #646 F9), set only by the map_feature_link_point trigger; NULL = not a linked gauge, or linked before 273.';

-- Owns link_point: whatever an UPDATE or INSERT sends for it is replaced.
CREATE FUNCTION map_feature_link_point() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF NEW.kind <> 'gauge' OR NEW.node_id IS NULL THEN
			NEW.link_point := NULL;
		ELSIF TG_OP = 'INSERT' OR OLD.node_id IS DISTINCT FROM NEW.node_id OR OLD.kind <> 'gauge' THEN
			NEW.link_point := NEW.geometry;
		ELSE
			NEW.link_point := OLD.link_point;
		END IF;
		RETURN NEW;
	END
	$$;
-- Named to fire after map_feature_node_check (triggers fire in name order), which refuses a gauge linked to anything but a gauge node.
CREATE TRIGGER map_feature_s_link_point BEFORE INSERT OR UPDATE ON map_feature
	FOR EACH ROW EXECUTE FUNCTION map_feature_link_point();
