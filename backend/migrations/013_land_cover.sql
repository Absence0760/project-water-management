-- 013_land_cover — land-cover streamflow reductions (engine 0.24.0, roadmap
-- WP-1.35, docs/model.md §2.5a): invasive alien trees and commercial forestry
-- on a farm (hydrological unit) reduce the natural runoff it passes on.
--
-- One row per patch: the farm it lies on, its cover class, its area and
-- condensed (canopy) cover, and optional reductions overriding the class
-- defaults (factors = {"mar": 0-1, "lowFlow": 0-1}). Part of the model
-- document (GET/PUT /projects/:id/model), rewritten whole on save like
-- crop_area. No project has any, so no stored result changes meaning.
--
-- A new project-data table: RLS with the viewer/editor policies every model
-- table has, the same-project trigger on node_id, covering indexes on both
-- foreign keys, and the grant to water_app, all in this file.

CREATE TABLE land_cover (
	id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id  uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	node_id     uuid NOT NULL REFERENCES node(id) ON DELETE CASCADE,
	cover_class text NOT NULL CHECK (cover_class IN ('eucalyptus', 'pine', 'invasive', 'invasiveRiparian', 'other')),
	area_km2    double precision NOT NULL CHECK (area_km2 >= 0),
	density_pct double precision NOT NULL CHECK (density_pct BETWEEN 0 AND 1),
	factors     jsonb CHECK (
		factors IS NULL OR (
			jsonb_typeof(factors) = 'object'
			AND jsonb_typeof(factors -> 'mar') = 'number' AND (factors ->> 'mar')::double precision BETWEEN 0 AND 1
			AND jsonb_typeof(factors -> 'lowFlow') = 'number' AND (factors ->> 'lowFlow')::double precision BETWEEN 0 AND 1
		)
	)
);
CREATE INDEX land_cover_project_idx ON land_cover (project_id);
CREATE INDEX land_cover_node_idx ON land_cover (node_id);

COMMENT ON TABLE land_cover IS
	'Land-cover patches (invasive plants, forestry) reducing a farm''s runoff: area x condensed cover x the class reductions. Engine >= 0.24.0.';
COMMENT ON COLUMN land_cover.factors IS
	'Reductions at full cover overriding the class defaults: {"mar": 0-1, "lowFlow": 0-1}; NULL = the class defaults.';

ALTER TABLE land_cover ENABLE ROW LEVEL SECURITY;
CREATE POLICY land_cover_select ON land_cover FOR SELECT USING (app_has_role(project_id, 'viewer'));
CREATE POLICY land_cover_insert ON land_cover FOR INSERT WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY land_cover_update ON land_cover FOR UPDATE USING (app_has_role(project_id, 'editor')) WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY land_cover_delete ON land_cover FOR DELETE USING (app_has_role(project_id, 'editor'));

CREATE TRIGGER land_cover_same_project BEFORE INSERT OR UPDATE ON land_cover
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('node_id');

GRANT SELECT, INSERT, UPDATE, DELETE ON land_cover TO water_app;
