-- 181_evaporation_accepted — where a project's evaporation input accepted
-- from the map came from (issue #326 B-evap; docs/maps.md § Evaporation from
-- the map, docs/data-model.md § Catchment map).
--
-- In this file:
--  * evaporation_accepted: one row per (project, target) whose monthly values
--    an editor set from the evaporation summary over the catchment boundary
--    (POST /projects/:id/evaporation-from-map). target 'pe' is GR4J's
--    monthly PE (settings.pe, from a reference-ET dataset); 'apan' the A-pan
--    row (settings.apanMm, from an A-pan dataset). The row keeps the 12
--    values accepted, the dataset with its kind, source, version and method
--    as they stood then (copied, so a reload of the dataset doesn't rewrite
--    what was cited), and the share of the boundary the grid covered. The
--    model revision's reason says the same, which is what an evidence pack
--    prints; this row lets Settings say whether the row still holds the
--    accepted values.
--  * Settings are rewritten whole on a save, so the row is not tied to them
--    by a key: it stays when the values are typed over, and is current only
--    while the settings still hold monthly_mm. It goes with its project (ON
--    DELETE CASCADE), and a new acceptance replaces it.
--  * A new project table: RLS with the viewer/editor policies every model
--    table has, the primary key covering the project's foreign key, and the
--    grant to water_app, all here. No node column, so no same-project
--    trigger and no farmer decision (catalogue.db.test.ts): farmers never
--    get viewer access to it.

CREATE TABLE evaporation_accepted (
	project_id  uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	target      text NOT NULL CHECK (target IN ('pe', 'apan')),
	-- Oct … Sep, mm per month, as written into the settings.
	monthly_mm  double precision[] NOT NULL CHECK (cardinality(monthly_mm) = 12),
	dataset     text NOT NULL CHECK (char_length(dataset) BETWEEN 1 AND 50),
	kind        text NOT NULL CHECK (kind IN ('et0', 'apan')),
	source      text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 500),
	version     text NOT NULL CHECK (char_length(version) BETWEEN 1 AND 100),
	method      text NOT NULL CHECK (char_length(method) BETWEEN 1 AND 1000),
	-- The share of the boundary's area the grid had values for, 0–1.
	coverage    double precision NOT NULL CHECK (coverage > 0 AND coverage <= 1),
	accepted_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (project_id, target),
	CHECK ((target = 'pe') = (kind = 'et0'))
);

COMMENT ON TABLE evaporation_accepted IS
	'Evaporation accepted from the map (181, issue #326 B-evap): GR4J''s monthly PE from a reference-ET grid, or the A-pan row from an A-pan grid, with the dataset''s source, version and method then. Current while the settings still hold monthly_mm.';

ALTER TABLE evaporation_accepted ENABLE ROW LEVEL SECURITY;
CREATE POLICY evaporation_accepted_select ON evaporation_accepted FOR SELECT USING (app_has_role(project_id, 'viewer'));
CREATE POLICY evaporation_accepted_insert ON evaporation_accepted FOR INSERT WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY evaporation_accepted_update ON evaporation_accepted FOR UPDATE USING (app_has_role(project_id, 'editor')) WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY evaporation_accepted_delete ON evaporation_accepted FOR DELETE USING (app_has_role(project_id, 'editor'));

GRANT SELECT, INSERT, UPDATE, DELETE ON evaporation_accepted TO water_app;
