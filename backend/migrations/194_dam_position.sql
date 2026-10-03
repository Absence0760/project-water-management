-- 194_dam_position — whether a dam on the map stands on its river or off it
-- (the hydrologist's review, finding 9's durable fix; docs/followups.md
-- "Ask whether a dam is on its river or off it", docs/maps.md § Start from
-- the map, docs/data-model.md § Catchment map).
--
-- Start, Divide and their sub-catchments place a dam polygon at its outflow
-- (backend/src/delineation/subcatchments.ts damOutflow). Since start-10 an
-- outline that only clips a much larger river goes at its own footprint's
-- outflow, but the geometry can't tell a long off-channel storage dam lying
-- along the river, overlapping it for most of its length, from a narrow
-- reservoir on it: that dam took the river's whole catchment. The editor now
-- says which it is, in the map's feature sheet.
--
-- In this file:
--  * map_feature.dam_position: 'on_channel' (a dam on the watercourse: the
--    river forms its reservoir; placed at the river's cell), 'off_channel'
--    (an off-channel storage dam beside the river, filled by a pump or a
--    furrow, as DWS's dam registration and its OCS schemes call it; placed
--    at its own outflow, the river never taken), or NULL (not said: the
--    outline decides, exactly as before, so existing rows and proposals are
--    unchanged and START_METHOD_VERSION stays start-12).
--  * Only a dam polygon takes one: a point has no footprint to place by.
--    The CHECK holds it to that; the PATCH route clears it when a feature
--    stops being a dam polygon, and refuses it on anything else (400).
--  * No new table, policy, grant, function or foreign key: the column
--    inherits map_feature's RLS (viewers read, editors write; a farmer sees
--    only their own linked dams) and water_app's table grant (152).

ALTER TABLE map_feature
	ADD COLUMN dam_position text CHECK (dam_position IN ('on_channel', 'off_channel')),
	ADD CONSTRAINT map_feature_dam_position_dam CHECK (
		dam_position IS NULL OR (kind = 'dam' AND geometry ->> 'type' IN ('Polygon', 'MultiPolygon'))
	);

COMMENT ON COLUMN map_feature.dam_position IS
	'A dam polygon''s position against its river, as the editor said (194): on_channel (on the watercourse), off_channel (off-channel storage, filled by a pump or a furrow), NULL = not said (the outline decides, subcatchments.ts damOutflow).';
