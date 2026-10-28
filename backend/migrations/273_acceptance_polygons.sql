-- 273_acceptance_polygons — which polygon a unit's MAP and a land-cover area
-- were taken over (issue #646 item 4, the hydrologist's review F7;
-- docs/maps.md § MAP for each unit, § Cultivated area from land cover, § Checks).
--
-- A unit's rain feed already records the polygon its cells came from (the
-- feed config's `unit` mark: featureId, updatedAt, areaKm2), so a redrawn
-- unit boundary can be told apart. A unit's MAP from the grid (node.map_mm)
-- and a planted area from land cover (crop_area_land_cover, 174) recorded
-- nothing of the kind, so the Map's Checks and the Start data list could not
-- say that either was taken over an outline since redrawn. Expand only:
--
--  * node.map_polygon: the polygon POST …/map/unit-map took the unit's MAP
--    over, `{ featureId, updatedAt, areaM2 }` as it stood then. Cleared when
--    the MAP is changed by a model save (model/store.ts), since a typed MAP
--    is over no polygon. NULL: unknown (a MAP from before 273, or typed).
--  * crop_area_land_cover.polygons: the polygons the area was summed over,
--    each `{ featureId, updatedAt, areaM2 }`. NULL: unknown (from before 273).
--
-- The values are a record of what was read, never a link: no foreign key, so
-- deleting or redrawing a polygon leaves the record to say it changed. RLS,
-- policies, grants and the same-project triggers of both tables are
-- unchanged (a column inherits them). No personal information.

ALTER TABLE node ADD COLUMN map_polygon jsonb
	CHECK (map_polygon IS NULL OR (jsonb_typeof(map_polygon) = 'object' AND map_polygon ?& ARRAY['featureId', 'updatedAt', 'areaM2'] AND octet_length(map_polygon::text) <= 500));
COMMENT ON COLUMN node.map_polygon IS
	'The polygon the unit''s MAP from the grid was taken over (273, issue #646 F7): { featureId, updatedAt, areaM2 } then. Cleared when a model save changes the MAP; NULL = unknown or typed.';

ALTER TABLE crop_area_land_cover ADD COLUMN polygons jsonb
	CHECK (polygons IS NULL OR (jsonb_typeof(polygons) = 'array' AND jsonb_array_length(polygons) BETWEEN 1 AND 500));
COMMENT ON COLUMN crop_area_land_cover.polygons IS
	'The polygons the accepted area was summed over (273, issue #646 F7): [{ featureId, updatedAt, areaM2 }] then. NULL = from before 273.';
