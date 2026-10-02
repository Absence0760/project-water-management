-- 175_delineation — catchments delineated from a clicked outlet (issue #326
-- B-delineate, #342 map item 4; docs/design/delineation.md, docs/maps.md §
-- Delineation, docs/data-model.md § Catchment map).
--
-- In this file:
--  * delineation_proposal: what the DEM proposed for one click on one
--    project's map (the polygon, its area, the snapped outlet), with the
--    dataset and method it came from, and what the editor decided. The
--    server computes it (backend/src/delineation); the polygon reaches the
--    map only when an editor accepts it, as a new map_feature (the
--    catchment boundary, or an "other" polygon). A new proposal supersedes
--    the project's open one, so at most one is open at a time.
--  * RLS: viewers read a project's proposals; editors propose and decide.
--    An accepted proposal stays on record (the feature's provenance) until
--    its project goes; superseded and rejected ones beyond the newest 20 are
--    pruned by the route that adds one, so the table can't grow without
--    bound (editors may delete). The accepted feature is tied by a composite foreign
--    key (same project by construction); deleting that feature keeps the
--    proposal and clears the link.
--  * No node column, so no farmer policy: farmers never read proposals.

CREATE TABLE delineation_proposal (
	id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id       uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	status           text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'rejected', 'superseded')),
	-- What the editor said they clicked: it names the proposal, the method is the same.
	click_kind       text NOT NULL CHECK (click_kind IN ('outlet', 'dam_wall')),
	click_lon        double precision NOT NULL CHECK (click_lon BETWEEN -180 AND 180),
	click_lat        double precision NOT NULL CHECK (click_lat BETWEEN -90 AND 90),
	-- The snapped outlet: the most-accumulating cell's centre near the click.
	outlet_lon       double precision NOT NULL CHECK (outlet_lon BETWEEN -180 AND 180),
	outlet_lat       double precision NOT NULL CHECK (outlet_lat BETWEEN -90 AND 90),
	snap_distance_m  double precision NOT NULL CHECK (snap_distance_m >= 0),
	-- GeoJSON Polygon, WGS84, checked by geo/geojson.ts before it gets here.
	geometry         jsonb NOT NULL CHECK (jsonb_typeof(geometry) = 'object' AND geometry ->> 'type' = 'Polygon'),
	-- Geodesic area of the polygon (geo/area.ts), m².
	area_m2          double precision NOT NULL CHECK (area_m2 > 0 AND area_m2 < 1e13),
	cells            integer NOT NULL CHECK (cells > 0),
	cell_size_m      double precision NOT NULL CHECK (cell_size_m > 0),
	zoom             smallint NOT NULL CHECK (zoom BETWEEN 0 AND 24),
	window_cells     integer NOT NULL CHECK (window_cells > 0),
	-- The DEM: its label (DEM_LABEL or the archive's name) and fingerprint (SHA-256 of its header and root directory, 16 hex).
	dataset          text NOT NULL CHECK (char_length(dataset) BETWEEN 1 AND 200),
	dataset_fingerprint text NOT NULL CHECK (dataset_fingerprint ~ '^[0-9a-f]{16}$'),
	method           text NOT NULL CHECK (char_length(method) BETWEEN 1 AND 1000),
	method_version   text NOT NULL CHECK (char_length(method_version) BETWEEN 1 AND 50),
	-- The map feature an accept made; NULL until then, and again once that feature is deleted.
	feature_id       uuid,
	created_by       uuid REFERENCES app_user(id) ON DELETE SET NULL,
	created_at       timestamptz NOT NULL DEFAULT now(),
	decided_by       uuid REFERENCES app_user(id) ON DELETE SET NULL,
	decided_at       timestamptz,
	CHECK ((status IN ('proposed', 'superseded')) = (decided_at IS NULL)),
	CHECK (feature_id IS NULL OR status = 'accepted'),
	FOREIGN KEY (feature_id, project_id) REFERENCES map_feature (id, project_id) ON DELETE SET NULL (feature_id)
);
-- The project's latest proposals (also covers the project_id foreign key).
CREATE INDEX delineation_proposal_project_idx ON delineation_proposal (project_id, created_at DESC);
-- At most one open proposal per project: a new one supersedes it (delineation/routes.ts).
CREATE UNIQUE INDEX delineation_proposal_one_open_idx ON delineation_proposal (project_id) WHERE status = 'proposed';
CREATE INDEX delineation_proposal_feature_idx ON delineation_proposal (feature_id, project_id);
CREATE INDEX delineation_proposal_created_by_idx ON delineation_proposal (created_by);
CREATE INDEX delineation_proposal_decided_by_idx ON delineation_proposal (decided_by);

COMMENT ON TABLE delineation_proposal IS
	'A catchment the DEM proposed upstream of a clicked outlet or dam wall, with its dataset and method, and the editor''s decision (175, issue #326 B-delineate). The polygon reaches the map only through an accept.';

ALTER TABLE delineation_proposal ENABLE ROW LEVEL SECURITY;
CREATE POLICY delineation_proposal_select ON delineation_proposal FOR SELECT USING (app_has_role(project_id, 'viewer'));
CREATE POLICY delineation_proposal_insert ON delineation_proposal FOR INSERT WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY delineation_proposal_update ON delineation_proposal FOR UPDATE
	USING (app_has_role(project_id, 'editor')) WITH CHECK (app_has_role(project_id, 'editor'));

CREATE POLICY delineation_proposal_delete ON delineation_proposal FOR DELETE USING (app_has_role(project_id, 'editor'));

GRANT SELECT, INSERT, UPDATE, DELETE ON delineation_proposal TO water_app;
