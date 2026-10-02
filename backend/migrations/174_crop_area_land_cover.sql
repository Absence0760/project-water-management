-- 174_crop_area_land_cover — where a planted area accepted from land cover
-- came from (issue #326 B-landcover; docs/maps.md § Cultivated area from land
-- cover, docs/data-model.md § Catchment map).
--
-- In this file:
--  * crop_area_land_cover: one row per (unit, crop) whose planted area an
--    editor set from the land-cover summary (POST …/crop-area-from-land-cover):
--    the area accepted, the dataset with its source, version and method as
--    they stood then (copied, so a reload of the dataset doesn't rewrite what
--    was cited), and whether it was the unit's parcels together or one
--    parcel (by name). The model revision's reason says the same, which is
--    what an evidence pack prints; this row lets the Crops page say which
--    planted areas still hold the accepted value.
--  * crop_area is rewritten whole on every model save (model/store.ts), so
--    this row is not tied to it by a key: it stays when the area is typed
--    over, and is current only while crop_area.area_m2 still equals area_m2.
--    It goes with its unit, crop or project (ON DELETE CASCADE), and a new
--    acceptance replaces it.
--  * A new project table: RLS with the viewer/editor policies every model
--    table has, the same-project trigger on node_id and crop_id, covering
--    indexes on every foreign key, and the grant to water_app, all here.
--    Farmers don't read it (catalogue.db.test.ts FARMERS_NEVER_READ): it is
--    the modeller's provenance, not a farm's figures.

CREATE TABLE crop_area_land_cover (
	project_id   uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	node_id      uuid NOT NULL REFERENCES node(id) ON DELETE CASCADE,
	crop_id      uuid NOT NULL REFERENCES crop(id) ON DELETE CASCADE,
	area_m2      double precision NOT NULL CHECK (area_m2 >= 0),
	dataset      text NOT NULL CHECK (char_length(dataset) BETWEEN 1 AND 50),
	source       text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 500),
	version      text NOT NULL CHECK (char_length(version) BETWEEN 1 AND 100),
	method       text NOT NULL CHECK (char_length(method) BETWEEN 1 AND 1000),
	-- 'unit': every parcel linked to the unit, summed; 'parcel': one parcel, named in feature_name.
	basis        text NOT NULL CHECK (basis IN ('unit', 'parcel')),
	feature_name text CHECK (feature_name IS NULL OR char_length(feature_name) <= 100),
	accepted_at  timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (node_id, crop_id),
	CHECK ((basis = 'parcel') = (feature_name IS NOT NULL))
);
CREATE INDEX crop_area_land_cover_project_idx ON crop_area_land_cover (project_id);
CREATE INDEX crop_area_land_cover_crop_idx ON crop_area_land_cover (crop_id);

COMMENT ON TABLE crop_area_land_cover IS
	'A planted area accepted from the land-cover summary (174, issue #326 B-landcover): the area, the dataset''s source, version and method then, and the parcels it covered. Current while crop_area.area_m2 equals area_m2.';

ALTER TABLE crop_area_land_cover ENABLE ROW LEVEL SECURITY;
CREATE POLICY crop_area_land_cover_select ON crop_area_land_cover FOR SELECT USING (app_has_role(project_id, 'viewer'));
CREATE POLICY crop_area_land_cover_insert ON crop_area_land_cover FOR INSERT WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY crop_area_land_cover_update ON crop_area_land_cover FOR UPDATE USING (app_has_role(project_id, 'editor')) WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY crop_area_land_cover_delete ON crop_area_land_cover FOR DELETE USING (app_has_role(project_id, 'editor'));

CREATE TRIGGER crop_area_land_cover_same_project BEFORE INSERT OR UPDATE ON crop_area_land_cover
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('node_id', 'crop_id');

GRANT SELECT, INSERT, UPDATE, DELETE ON crop_area_land_cover TO water_app;
