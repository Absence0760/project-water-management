-- 088_demand_objects — demand objects on units (engine 1.7.0, issue #54 item
-- 2b, docs/model.md §2.7f).
--
-- One row per object: the unit (a farm node) whose water supplies it, a
-- name, a category (the client's register: domestic, municipal, industrial,
-- livestock, irrigation not from crops, external, other), how it is sized
-- (monthly m3/day by water-year month, or per unit: a count x litres per
-- unit per day, grossed up for distribution losses, x a monthly profile), the
-- share it returns below the unit, its priority against the unit's crops
-- (first / shared / last), where its water ends up (internal, or piped out of
-- the catchment) and whether it is modelled at all, plus a note on where the
-- number comes from.
--
-- Part of the model document (GET/PUT /projects/:id/model), rewritten whole on
-- save like borehole (043). No project has any, so no stored result changes
-- meaning.
--
-- A new project-data table: RLS with the viewer/editor policies every model
-- table has, a farmer-aware SELECT policy (own linked farms only, as borehole
-- in 043; a linked contributor reads what a farmer with the same links reads,
-- 045), the same-project trigger on node_id, covering indexes on both foreign
-- keys, and the grant to water_app, all in this file.

CREATE TABLE demand_object (
	id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id           uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	node_id              uuid NOT NULL REFERENCES node(id) ON DELETE CASCADE,
	name                 text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
	category             text NOT NULL DEFAULT 'other'
		CHECK (category IN ('domestic', 'municipal', 'industrial', 'livestock', 'irrigation', 'external', 'other')),
	sizing               text NOT NULL DEFAULT 'monthly' CHECK (sizing IN ('monthly', 'perUnit')),
	monthly_m3_day       double precision[] CHECK (monthly_m3_day IS NULL OR cardinality(monthly_m3_day) = 12),
	unit_count           double precision CHECK (unit_count >= 0),
	litres_per_unit_day  double precision CHECK (litres_per_unit_day >= 0),
	loss_pct             double precision NOT NULL DEFAULT 0 CHECK (loss_pct >= 0 AND loss_pct < 1),
	monthly_factor       double precision[] CHECK (monthly_factor IS NULL OR cardinality(monthly_factor) = 12),
	return_pct           double precision NOT NULL DEFAULT 0 CHECK (return_pct BETWEEN 0 AND 1),
	priority             text NOT NULL DEFAULT 'shared' CHECK (priority IN ('first', 'shared', 'last')),
	destination          text NOT NULL DEFAULT 'internal' CHECK (destination IN ('internal', 'external')),
	enabled              boolean NOT NULL DEFAULT true,
	note                 text NOT NULL DEFAULT '' CHECK (char_length(note) <= 1000),
	CONSTRAINT demand_object_sized CHECK (
		(sizing = 'monthly' AND monthly_m3_day IS NOT NULL)
		OR (sizing = 'perUnit' AND unit_count IS NOT NULL AND litres_per_unit_day IS NOT NULL)
	),
	CONSTRAINT demand_object_external_returns_nothing CHECK (destination = 'internal' OR return_pct = 0)
);
CREATE INDEX demand_object_project_idx ON demand_object (project_id);
CREATE INDEX demand_object_node_idx ON demand_object (node_id);

COMMENT ON TABLE demand_object IS
	'Demand objects on a unit (farm node): a town, households, livestock or any demand that is not a crop, added to the unit''s crop demand and supplied from its dam, river pump and boreholes. Engine >= 1.7.0, docs/model.md 2.7f.';
COMMENT ON COLUMN demand_object.monthly_m3_day IS
	'sizing monthly: abstraction demand, m3/day per water-year month (Oct-Sep), losses included.';
COMMENT ON COLUMN demand_object.loss_pct IS
	'sizing perUnit: distribution losses as a share of what is abstracted; abstraction = count x litres / 1000 x factor / (1 - loss).';
COMMENT ON COLUMN demand_object.return_pct IS
	'Share (0-1) of what it is supplied that returns to the river below the unit the same day; 0 when piped out (destination external).';
COMMENT ON COLUMN demand_object.priority IS
	'Against the unit''s crops on a short day: first (before them), shared (pro rata with them), last (after them).';

ALTER TABLE demand_object ENABLE ROW LEVEL SECURITY;
CREATE POLICY demand_object_select ON demand_object FOR SELECT USING (app_has_role(project_id, 'viewer'));
-- A farmer (020) reads the demand objects of their own linked farms only.
CREATE POLICY demand_object_select_farmer ON demand_object FOR SELECT
	USING (node_id IN (SELECT app_farm_nodes(project_id)));
CREATE POLICY demand_object_insert ON demand_object FOR INSERT WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY demand_object_update ON demand_object FOR UPDATE USING (app_has_role(project_id, 'editor')) WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY demand_object_delete ON demand_object FOR DELETE USING (app_has_role(project_id, 'editor'));

CREATE TRIGGER demand_object_same_project BEFORE INSERT OR UPDATE ON demand_object
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('node_id');

GRANT SELECT, INSERT, UPDATE, DELETE ON demand_object TO water_app;
