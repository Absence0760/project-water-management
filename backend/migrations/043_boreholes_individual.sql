-- 043_boreholes_individual — individual boreholes on farms and other users
-- (engine 0.36.0, roadmap WP-3.9, docs/model.md §2.7d).
--
-- One row per borehole: the node it supplies, a name (e.g. its number on the
-- geohydrology report), its capacity (m3/day, the specialist's sustainable
-- yield), an annual cap per water year (NULL = none), a supply mode, the dam
-- level below which an emergency borehole runs, where its water goes (straight
-- to the crop or user, or into the farm dam) and the share of its pumping the
-- river eventually loses (the node's stream_depletion_lag_days, 012, applies).
-- They add to the node's combined borehole capacity (012), which stays.
--
-- Part of the model document (GET/PUT /projects/:id/model), rewritten whole on
-- save like land_cover. No project has any, so no stored result changes meaning.
--
-- A new project-data table: RLS with the viewer/editor policies every model
-- table has, a farmer-aware SELECT policy (own linked farms only, as
-- land_cover in 020), the same-project trigger on node_id, covering indexes
-- on both foreign keys, and the grant to water_app, all in this file.

CREATE TABLE borehole (
	id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id          uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	node_id             uuid NOT NULL REFERENCES node(id) ON DELETE CASCADE,
	name                text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
	capacity_m3_day     double precision NOT NULL CHECK (capacity_m3_day >= 0),
	annual_cap_m3       double precision CHECK (annual_cap_m3 >= 0),
	mode                text NOT NULL DEFAULT 'supplemental'
		CHECK (mode IN ('none', 'supplemental', 'primary', 'emergency')),
	emergency_below_pct double precision NOT NULL DEFAULT 0.3 CHECK (emergency_below_pct BETWEEN 0 AND 1),
	target              text NOT NULL DEFAULT 'direct' CHECK (target IN ('direct', 'dam')),
	depletion_factor    double precision NOT NULL DEFAULT 0 CHECK (depletion_factor BETWEEN 0 AND 1)
);
CREATE INDEX borehole_project_idx ON borehole (project_id);
CREATE INDEX borehole_node_idx ON borehole (node_id);

COMMENT ON TABLE borehole IS
	'Individual boreholes on a farm or other user: capacity, annual cap per water year, supply mode, target (crop or dam) and stream-depletion share. Engine >= 0.36.0.';
COMMENT ON COLUMN borehole.annual_cap_m3 IS
	'Most it may pump per water year (October-September), m3; NULL = no cap. The model shows modelled use against it and the GN 538 ceiling; it never decides legality.';
COMMENT ON COLUMN borehole.emergency_below_pct IS
	'mode emergency: it runs while the farm dam holds less than this fraction of its capacity at the start of the day.';
COMMENT ON COLUMN borehole.depletion_factor IS
	'Share (0-1) of what it pumps that is eventually taken from the river at its node, through the node''s depletion lag.';

ALTER TABLE borehole ENABLE ROW LEVEL SECURITY;
CREATE POLICY borehole_select ON borehole FOR SELECT USING (app_has_role(project_id, 'viewer'));
-- A farmer (020) reads the boreholes of their own linked farms only.
CREATE POLICY borehole_select_farmer ON borehole FOR SELECT
	USING (node_id IN (SELECT app_farm_nodes(project_id)));
CREATE POLICY borehole_insert ON borehole FOR INSERT WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY borehole_update ON borehole FOR UPDATE USING (app_has_role(project_id, 'editor')) WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY borehole_delete ON borehole FOR DELETE USING (app_has_role(project_id, 'editor'));

CREATE TRIGGER borehole_same_project BEFORE INSERT OR UPDATE ON borehole
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('node_id');

GRANT SELECT, INSERT, UPDATE, DELETE ON borehole TO water_app;
