-- 154_dam_register — the register of dams the catchment map proposes a dam's
-- capacity from (issue #326 Part B, "B-dams"; docs/maps.md § Dams from the
-- register and the map, docs/data-model.md § Catchment map).
--
-- In this file:
--  * dam_register_reference: a reference list of registered dams (register
--    number, name, river, farm, position, capacity, wall height, surface area
--    when published, completion year), loaded by the operator with
--    `pnpm import:dam-register` (never by the app). The app reads it to
--    *propose* a dam node's capacity from the registered dams within about
--    1 km of the dam on the map (geo/damProposals.ts); the modeller accepts
--    each value. Global, not per project, like quaternary_reference (152):
--    any signed-in user reads it; water_app never writes it.
--  * The repo ships only an invented, synthetic list (register numbers Z…,
--    dataset 'synthetic'). The real source, the DWS Dam Safety Office's List
--    of Registered Dams, is "blocked: licence unconfirmed" (docs/maps.md §
--    Sources): it is loaded only into the operator's own database from their
--    own download, never committed.
--  * No PostGIS: the position is lon/lat columns; the nearest-dam search is a
--    bounding-box pass on the index here and a geodesic distance in the backend.

CREATE TABLE dam_register_reference (
	-- The register's own number ("No of dam", e.g. A210/01). The synthetic list uses region Z, which DWS doesn't.
	register_no     text PRIMARY KEY CHECK (char_length(register_no) BETWEEN 1 AND 20),
	-- Which load it came from: 'synthetic' (the repo's invented fixture) or the operator's label ('DSO-2025-07').
	dataset         text NOT NULL CHECK (char_length(dataset) BETWEEN 1 AND 50),
	name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
	river           text CHECK (river IS NULL OR char_length(river) <= 200),
	farm            text CHECK (farm IS NULL OR char_length(farm) <= 200),
	lon             double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
	lat             double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
	-- Full-supply capacity, m³ (the register gives thousands of m³; the loader converts).
	capacity_m3     double precision CHECK (capacity_m3 IS NULL OR (capacity_m3 >= 0 AND capacity_m3 < 1e12)),
	wall_height_m   double precision CHECK (wall_height_m IS NULL OR (wall_height_m >= 0 AND wall_height_m < 1000)),
	-- Water surface at full supply, m², where the source publishes it (the DSO list doesn't).
	surface_area_m2 double precision CHECK (surface_area_m2 IS NULL OR (surface_area_m2 >= 0 AND surface_area_m2 < 1e12)),
	completion_year integer CHECK (completion_year IS NULL OR completion_year BETWEEN 1600 AND 2200),
	-- Shown with every proposed value: the list, its edition and the entry.
	source          text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 500),
	loaded_at       timestamptz NOT NULL DEFAULT now()
);
-- The nearest-dam search's first pass: a box of about 1 km round the point.
CREATE INDEX dam_register_reference_position_idx ON dam_register_reference (lat, lon);
CREATE INDEX dam_register_reference_dataset_idx ON dam_register_reference (dataset);

COMMENT ON TABLE dam_register_reference IS
	'Registered dams with position, capacity and wall height, loaded by the operator (pnpm import:dam-register), read-only to the app (154, issue #326 B-dams). The repo ships a synthetic list only.';
COMMENT ON COLUMN dam_register_reference.capacity_m3 IS
	'Full-supply capacity, m³. Proposed to a dam node''s damCapacityM3 only when the modeller accepts it (a model revision naming the entry).';

ALTER TABLE dam_register_reference ENABLE ROW LEVEL SECURITY;
-- Public reference data: anyone signed in reads it; the app never writes it.
CREATE POLICY dam_register_reference_select ON dam_register_reference FOR SELECT USING (app_current_user_id() IS NOT NULL);

GRANT SELECT ON dam_register_reference TO water_app;
