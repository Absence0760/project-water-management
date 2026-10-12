-- 225_gazetteer — place and farm names for the Map's search (issue #523 C5,
-- #90 Q23, reversing #326 D-C3; docs/maps.md § Search, docs/data-model.md §
-- Catchment map).
--
-- In this file:
--  * gazetteer_reference: a reference dataset of named places (towns,
--    settlements, farms, rivers, dams, peaks, areas), each a point, loaded by
--    the operator with `pnpm import:gazetteer` locally, or in production
--    through load-reference.yml (geo/referenceLoad.ts kind 'gazetteer'), never
--    by the app. The Map's search box reads it after the map's own layers
--    (gauge codes, the register's dam names, quaternary codes) to move the
--    view to a match. Searches go to our backend only, never a third-party
--    geocoder. Global, not per project: any signed-in user reads it; water_app
--    never writes it (like gauge_station_reference, 156).
--  * The repo ships only an invented, synthetic dataset
--    (backend/fixtures/geo/gazetteer.synthetic.txt, in GeoNames' dump
--    format). Production loads GeoNames' South Africa dump (CC BY 4.0, credit
--    shown with every search that lists a place; docs/maps.md § Sources).
--  * search_name is the name as the search compares it (lower case, accents
--    and punctuation folded, one space between words: geo/gazetteer.ts
--    searchKey), written by the loader so the query compares like with like.
--    A search matches the start of the whole name (the index below) or of any
--    word in it.
--  * reference_load (192) records which bucket file a production load read,
--    by kind: 'gazetteer' joins its kinds.

CREATE TABLE gazetteer_reference (
	-- Which load it came from: 'synthetic' (the repo's invented fixture) or the operator's label ('GeoNames-ZA-2026-10').
	dataset      text NOT NULL CHECK (char_length(dataset) BETWEEN 1 AND 50),
	-- The place's id in its dataset (GeoNames' geonameid).
	place_id     text NOT NULL CHECK (char_length(place_id) BETWEEN 1 AND 30),
	name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200 AND name !~ '[\u0001-\u001f\u007f-\u009f]'),
	search_name  text NOT NULL CHECK (char_length(search_name) BETWEEN 1 AND 200),
	-- GeoNames' feature class and code, as 'P.PPL' (a populated place), 'S.FRM' (a farm), 'H.STM' (a stream).
	feature      text NOT NULL CHECK (feature ~ '^[A-Z]\.[A-Z0-9]{1,10}$'),
	-- The province (GeoNames' admin1 code for South Africa, e.g. '11' Western Cape); '' when not given.
	admin1       text NOT NULL DEFAULT '' CHECK (char_length(admin1) <= 20),
	lon          double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
	lat          double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
	-- Shown with every match from it: the dataset's credit (GeoNames' CC BY 4.0 attribution).
	source       text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 500),
	loaded_at    timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (dataset, place_id)
);
-- A match on the start of the whole name; the any-word match reads the table (a country's dump is about 150 000 rows).
CREATE INDEX gazetteer_reference_search_idx ON gazetteer_reference (search_name text_pattern_ops);

COMMENT ON TABLE gazetteer_reference IS
	'Named places (towns, farms, rivers, peaks) for the Map''s search, loaded by the operator (pnpm import:gazetteer, or load-reference.yml), read-only to the app (225, issue #523 C5). The repo ships a synthetic dataset only.';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE gazetteer_reference ENABLE ROW LEVEL SECURITY;
-- Public reference data: anyone signed in reads it; the app never writes it.
CREATE POLICY gazetteer_reference_select ON gazetteer_reference FOR SELECT USING (app_current_user_id() IS NOT NULL);

GRANT SELECT ON gazetteer_reference TO water_app;

-- ---------------------------------------------------------------------------
-- reference_load: a production load of the gazetteer records its file too.
-- ---------------------------------------------------------------------------
ALTER TABLE reference_load DROP CONSTRAINT reference_load_kind_check;
ALTER TABLE reference_load ADD CONSTRAINT reference_load_kind_check CHECK (kind IN ('land-cover', 'evaporation', 'rivers', 'gazetteer'));
