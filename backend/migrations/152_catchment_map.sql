-- 152_catchment_map — the catchment map, phases 1–2 (issue #288, roadmap
-- WP-3.12; docs/maps.md, docs/data-model.md § Catchment map).
--
-- In this file:
--  * geo_source: the GeoJSON file a batch of map features was imported from,
--    with its name, SHA-256 and CRS (provenance). Deleting it deletes its
--    features (undo an import). A feature placed in the app has none.
--  * map_feature: a catchment boundary, farm parcel, dam, gauge, river or
--    other feature of one project, as GeoJSON geometry (WGS84 lon/lat, 2D,
--    validated by backend/src/geo before it gets here), with its geodesic
--    area for polygons, computed on the server. Optionally tied to a node.
--    At most one catchment boundary per project.
--  * node.area_source / node.area_feature_id: whether a node's area was typed
--    or accepted from a map feature. The app proposes an area from a polygon
--    and the modeller accepts it (POST …/nodes/:nodeId/area-from-map); a
--    typed change sets it back to 'typed' (model/store.ts). Expand only:
--    both have defaults, so older code still writes valid rows.
--  * quaternary_reference: a reference dataset of quaternary catchments
--    (code, polygon, area, MAP, naturalised MAR and monthly means), loaded by
--    the operator with `pnpm import:quaternaries` (never by the app), used to
--    *propose* the WR2012 check's values for a point. Global, not per
--    project: any signed-in user reads it; water_app never writes it. The
--    repo ships only an invented, synthetic dataset (code Z…); the real
--    DWS/WR2012 data is loaded from the operator's own download (docs/maps.md
--    § Quaternary dataset; WR2012's redistribution terms are unconfirmed).
--  * RLS: viewers read map features and sources, editors write. A farmer or
--    contributor reads the catchment boundary, gauges and rivers and the
--    features tied to their own linked nodes, never another farm's (Step 2
--    D1; the catalogue guard's farmer-aware policy). No route serves them yet.
--  * Same project: composite foreign keys (source; node → feature) and
--    assert_same_project on map_feature.node_id; covering indexes on every
--    foreign key.
--  * No PostGIS (WP-3.12): geometry is jsonb, area and point-in-polygon are
--    computed in backend/src/geo.

-- ---------------------------------------------------------------------------
-- geo_source
-- ---------------------------------------------------------------------------
CREATE TABLE geo_source (
	id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id  uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	file_name   text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
	-- SHA-256 hex of the file's text as UTF-8.
	sha256      text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
	-- The coordinate reference system the file was read in; the server takes WGS84 only.
	crs         text NOT NULL DEFAULT 'EPSG:4326' CHECK (char_length(crs) BETWEEN 1 AND 100),
	imported_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
	imported_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (id, project_id)
);
-- Also covers the project_id foreign key; the same file can't be imported twice.
CREATE UNIQUE INDEX geo_source_sha_idx ON geo_source (project_id, sha256);
CREATE INDEX geo_source_imported_by_idx ON geo_source (imported_by);

COMMENT ON TABLE geo_source IS
	'The GeoJSON file a batch of map features was imported from, with its SHA-256 (152, WP-3.12). Deleting it deletes its features.';

-- ---------------------------------------------------------------------------
-- map_feature
-- ---------------------------------------------------------------------------
CREATE TABLE map_feature (
	id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id  uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	kind        text NOT NULL
		CHECK (kind IN ('catchment_boundary', 'farm_parcel', 'dam', 'gauge', 'river', 'other')),
	name        text NOT NULL DEFAULT '' CHECK (char_length(name) <= 100),
	-- The node it stands for (a farm's parcel or dam, a gauge); NULL = none.
	node_id     uuid REFERENCES node(id) ON DELETE SET NULL,
	-- GeoJSON geometry, WGS84 lon/lat, 2D. backend/src/geo validates it (rings,
	-- ranges, ≤ 50 000 vertices); the CHECKs here hold the type to the kind.
	geometry    jsonb NOT NULL CHECK (
		jsonb_typeof(geometry) = 'object'
		AND geometry ->> 'type' IN ('Point', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon')
		AND jsonb_typeof(geometry -> 'coordinates') = 'array'
	),
	-- Allowlisted keys only (geo/geojson.ts FEATURE_PROPERTIES).
	properties  jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(properties) = 'object'),
	-- Geodesic area of a polygon, m² (geo/area.ts, on the WGS84 ellipsoid); NULL for points and lines.
	area_m2     double precision CHECK (area_m2 IS NULL OR (area_m2 >= 0 AND area_m2 < 1e13)),
	source_id   uuid,
	created_by  uuid REFERENCES app_user(id) ON DELETE SET NULL,
	created_at  timestamptz NOT NULL DEFAULT now(),
	updated_at  timestamptz NOT NULL DEFAULT now(),
	CHECK (kind NOT IN ('catchment_boundary', 'farm_parcel') OR geometry ->> 'type' IN ('Polygon', 'MultiPolygon')),
	CHECK (kind <> 'gauge' OR geometry ->> 'type' = 'Point'),
	CHECK (kind <> 'dam' OR geometry ->> 'type' IN ('Point', 'Polygon', 'MultiPolygon')),
	CHECK (kind <> 'river' OR geometry ->> 'type' IN ('LineString', 'MultiLineString')),
	CHECK ((area_m2 IS NOT NULL) = (geometry ->> 'type' IN ('Polygon', 'MultiPolygon'))),
	FOREIGN KEY (source_id, project_id) REFERENCES geo_source (id, project_id) ON DELETE CASCADE,
	UNIQUE (id, project_id)
);
CREATE INDEX map_feature_project_idx ON map_feature (project_id, kind);
-- Covers the composite source foreign key (leading source_id).
CREATE INDEX map_feature_source_idx ON map_feature (source_id, project_id);
CREATE INDEX map_feature_node_idx ON map_feature (node_id);
CREATE INDEX map_feature_created_by_idx ON map_feature (created_by);
-- One catchment boundary per project: a new one replaces it (geo/routes.ts).
CREATE UNIQUE INDEX map_feature_one_boundary_idx ON map_feature (project_id) WHERE kind = 'catchment_boundary';

COMMENT ON TABLE map_feature IS
	'A map feature of one project: catchment boundary, farm parcel, dam, gauge, river or other (152, WP-3.12). GeoJSON geometry in WGS84; the area of a polygon is computed on the server.';
COMMENT ON COLUMN map_feature.area_m2 IS
	'Geodesic area of a polygon, m², on the WGS84 ellipsoid (geo/area.ts). Proposed to a node only when the modeller accepts it (node.area_source = ''map'').';

CREATE TRIGGER map_feature_same_project BEFORE INSERT OR UPDATE ON map_feature
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('node_id');

-- A feature stands for a node of a matching kind: a parcel or dam for a farm
-- (or another water user), a gauge for a gauge. SECURITY DEFINER so the
-- check sees the node past RLS (the caller is an editor, who sees it anyway).
CREATE FUNCTION map_feature_node_check() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		k text;
	BEGIN
		NEW.updated_at := now();
		IF NEW.node_id IS NULL THEN
			RETURN NEW;
		END IF;
		SELECT kind::text INTO k FROM node WHERE id = NEW.node_id;
		IF NEW.kind = 'gauge' AND k IS DISTINCT FROM 'gauge' THEN
			RAISE EXCEPTION 'a gauge on the map stands for a gauge node' USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.kind IN ('farm_parcel', 'dam') AND k NOT IN ('farm', 'user') THEN
			RAISE EXCEPTION 'a farm parcel or dam stands for a farm or water-user node' USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.kind IN ('catchment_boundary', 'river') THEN
			RAISE EXCEPTION 'a catchment boundary or river stands for no node' USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER map_feature_node_check BEFORE INSERT OR UPDATE ON map_feature
	FOR EACH ROW EXECUTE FUNCTION map_feature_node_check();

-- ---------------------------------------------------------------------------
-- node: where its area came from
-- ---------------------------------------------------------------------------
ALTER TABLE node
	ADD COLUMN area_source text NOT NULL DEFAULT 'typed' CHECK (area_source IN ('typed', 'map')),
	ADD COLUMN area_feature_id uuid,
	-- Same project by construction; deleting the feature keeps the area and forgets the link.
	ADD CONSTRAINT node_area_feature_fk FOREIGN KEY (area_feature_id, project_id)
		REFERENCES map_feature (id, project_id) ON DELETE SET NULL (area_feature_id);
CREATE INDEX node_area_feature_idx ON node (area_feature_id, project_id);

COMMENT ON COLUMN node.area_source IS
	'typed: entered by hand. map: accepted from a map feature''s polygon area (152, WP-3.12); a typed change sets it back.';
COMMENT ON COLUMN node.area_feature_id IS
	'The map feature whose area was accepted, while area_source = ''map''; NULL once that feature is deleted (the area stays).';

-- ---------------------------------------------------------------------------
-- quaternary_reference: the dataset the quaternary lookup proposes from
-- ---------------------------------------------------------------------------
CREATE TABLE quaternary_reference (
	-- Quaternary code: a drainage-region letter, two digits, a letter (A21B).
	-- The committed synthetic dataset uses region Z, which DWS doesn't.
	code          text PRIMARY KEY CHECK (code ~ '^[A-Z][0-9]{2}[A-Z]$'),
	-- Which load it came from: 'synthetic' (the repo's invented fixture) or the operator's label ('WR2012').
	dataset       text NOT NULL CHECK (char_length(dataset) BETWEEN 1 AND 50),
	geometry      jsonb NOT NULL CHECK (jsonb_typeof(geometry) = 'object' AND geometry ->> 'type' IN ('Polygon', 'MultiPolygon')),
	-- The polygon's bounding box, for the lookup's first pass.
	min_lon       double precision NOT NULL,
	min_lat       double precision NOT NULL,
	max_lon       double precision NOT NULL,
	max_lat       double precision NOT NULL,
	area_km2      double precision CHECK (area_km2 IS NULL OR area_km2 > 0),
	map_mm        double precision CHECK (map_mm IS NULL OR map_mm > 0),
	mar_mm3       double precision CHECK (mar_mm3 IS NULL OR mar_mm3 >= 0),
	-- Mean naturalised flow per month, Mm³, October … September.
	monthly_mm3   double precision[] CHECK (monthly_mm3 IS NULL OR cardinality(monthly_mm3) = 12),
	period_start  integer CHECK (period_start IS NULL OR period_start BETWEEN 1800 AND 2200),
	period_end    integer CHECK (period_end IS NULL OR period_end BETWEEN 1800 AND 2200),
	-- Shown with every proposed value: the study, volume, table or file.
	source        text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 500),
	loaded_at     timestamptz NOT NULL DEFAULT now(),
	CHECK (min_lon <= max_lon AND min_lat <= max_lat),
	CHECK (period_start IS NULL OR period_end IS NULL OR period_start <= period_end)
);
CREATE INDEX quaternary_reference_bbox_idx ON quaternary_reference (min_lon, max_lon, min_lat, max_lat);

COMMENT ON TABLE quaternary_reference IS
	'Quaternary catchments with their reference values, loaded by the operator (pnpm import:quaternaries), read-only to the app (152, WP-3.12). The repo ships a synthetic dataset only.';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE geo_source ENABLE ROW LEVEL SECURITY;
CREATE POLICY geo_source_select ON geo_source FOR SELECT USING (app_has_role(project_id, 'viewer'));
CREATE POLICY geo_source_insert ON geo_source FOR INSERT WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY geo_source_update ON geo_source FOR UPDATE
	USING (app_has_role(project_id, 'editor')) WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY geo_source_delete ON geo_source FOR DELETE USING (app_has_role(project_id, 'editor'));

ALTER TABLE map_feature ENABLE ROW LEVEL SECURITY;
CREATE POLICY map_feature_select ON map_feature FOR SELECT USING (app_has_role(project_id, 'viewer'));
-- A farmer or contributor: the shared features (boundary, gauges, rivers) and their own linked nodes' features, never another farm's.
CREATE POLICY map_feature_select_farmer ON map_feature FOR SELECT
	USING (
		(kind IN ('catchment_boundary', 'gauge', 'river') AND app_has_role(project_id, 'farmer'))
		OR node_id IN (SELECT app_farm_nodes(project_id))
	);
CREATE POLICY map_feature_insert ON map_feature FOR INSERT WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY map_feature_update ON map_feature FOR UPDATE
	USING (app_has_role(project_id, 'editor')) WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY map_feature_delete ON map_feature FOR DELETE USING (app_has_role(project_id, 'editor'));

ALTER TABLE quaternary_reference ENABLE ROW LEVEL SECURITY;
-- Public reference data: anyone signed in reads it; the app never writes it.
CREATE POLICY quaternary_reference_select ON quaternary_reference FOR SELECT USING (app_current_user_id() IS NOT NULL);

GRANT SELECT, INSERT, UPDATE, DELETE ON geo_source, map_feature TO water_app;
GRANT SELECT ON quaternary_reference TO water_app;
