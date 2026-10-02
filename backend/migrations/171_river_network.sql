-- 171_river_network — the sourced river network the catchment map draws as a
-- layer and proposes a project's river features from (issue #345; docs/maps.md
-- § River network, docs/data-model.md § Catchment map).
--
-- In this file:
--  * river_reference: a reference dataset of river reaches (one line each,
--    with its Strahler order, the area upstream of its outlet, its length and
--    long-term mean discharge where the source gives them), loaded by the
--    operator with `pnpm import:rivers` (never by the app). The app reads it to
--    draw the River network layer around a project and to *propose* reaches as
--    the project's own `river` features, one at a time: the modeller adds each
--    (POST …/map/rivers/add), which copies the line into map_feature with its
--    source named. Global, not per project, like quaternary_reference (152):
--    any signed-in user reads it; water_app never writes it.
--  * The repo ships only an invented, synthetic network (dataset 'synthetic').
--    The real source is HydroRIVERS v1.0 (WWF HydroSHEDS; licence allows
--    commercial use with attribution, docs/maps.md § Sources), loaded from the
--    operator's own download (`pnpm dev:tiles:rivers`), never committed.
--  * No PostGIS (WP-3.12): a reach's bounding box is four columns, indexed,
--    for the layer's bbox query; the line itself is GeoJSON in jsonb.

CREATE TABLE river_reference (
	-- Which load it came from: 'synthetic' (the repo's invented fixture) or the operator's label ('HydroRIVERS-v10').
	dataset        text NOT NULL CHECK (char_length(dataset) BETWEEN 1 AND 50),
	-- The source's own reach id (HydroRIVERS' HYRIV_ID), unique within its dataset.
	reach_id       bigint NOT NULL CHECK (reach_id > 0),
	-- The reach's name where the source gives one (HydroRIVERS has none); '' otherwise.
	name           text NOT NULL DEFAULT '' CHECK (char_length(name) <= 100),
	-- Strahler stream order (1 = a headwater stream); NULL = not given.
	strahler       smallint CHECK (strahler IS NULL OR strahler BETWEEN 1 AND 15),
	-- Area draining to the reach's outlet, km²; NULL = not given.
	upstream_km2   double precision CHECK (upstream_km2 IS NULL OR (upstream_km2 >= 0 AND upstream_km2 < 1e8)),
	-- Length of the reach, km; NULL = not given.
	length_km      double precision CHECK (length_km IS NULL OR (length_km >= 0 AND length_km < 1e5)),
	-- Long-term mean discharge at the reach's outlet, m³/s, as the source models it; NULL = not given.
	discharge_m3s  double precision CHECK (discharge_m3s IS NULL OR (discharge_m3s >= 0 AND discharge_m3s < 1e6)),
	geometry       jsonb NOT NULL CHECK (jsonb_typeof(geometry) = 'object' AND geometry ->> 'type' IN ('LineString', 'MultiLineString')),
	-- The line's bounding box, for the layer's bbox query.
	min_lon        double precision NOT NULL,
	min_lat        double precision NOT NULL,
	max_lon        double precision NOT NULL,
	max_lat        double precision NOT NULL,
	-- Shown with the layer and copied into every reach added to a project: the product, version and attribution.
	source         text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 500),
	loaded_at      timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (dataset, reach_id),
	CHECK (min_lon <= max_lon AND min_lat <= max_lat)
);
CREATE INDEX river_reference_bbox_idx ON river_reference (min_lon, max_lon, min_lat, max_lat);

COMMENT ON TABLE river_reference IS
	'River reaches (line, Strahler order, upstream area, length, mean discharge), loaded by the operator (pnpm import:rivers), read-only to the app; the map draws them as a layer and proposes them as a project''s river features (171, issue #345). The repo ships a synthetic network only.';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE river_reference ENABLE ROW LEVEL SECURITY;
-- Public reference data: anyone signed in reads it; the app never writes it.
CREATE POLICY river_reference_select ON river_reference FOR SELECT USING (app_current_user_id() IS NOT NULL);

GRANT SELECT ON river_reference TO water_app;
