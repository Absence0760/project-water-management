-- 237_gazetteer_alternate_names — the Map's search finds a place by another
-- spelling or an old name, and ranks the larger place first (docs/maps.md
-- § Search, § Gazetteer; ad hoc testing 2026-10-13: the basemap labels
-- "Tsabong", GeoNames' main name is "Tshabong", and the search found nothing;
-- "Windhoek" listed South African hamlets before Namibia's capital).
--
-- In this file:
--  * gazetteer_reference.alt_names: the place's other names as GeoNames
--    publishes them (the dump's alternatenames column), only those the loader
--    keeps (geo/loadGazetteer.ts alternateNames: Latin script, no codes or
--    links, none folding to the main name or to one already kept). Shown with
--    a match found by one ("Tshabong (also Tsabong)").
--  * gazetteer_reference.alt_search: the same names folded as search_name is
--    (geo/gazetteer.ts searchKey), in the same order, joined by ' | '. A
--    folded name holds only letters, digits and single spaces, so the
--    separator never occurs inside one, and the search splits it back to pair
--    each with its alt_names entry. The CHECK holds the two to the same count.
--  * gazetteer_reference_alt_search_trgm_idx: the alternate names' word-start
--    test goes through its own trigram index, as the main name's goes through
--    225's, so a search reads the rows the two indexes offer (a BitmapOr on
--    this one table, no join), never the whole table. The query's expression
--    must be the index's, ' ' || alt_search.
--  * gazetteer_reference.population: GeoNames' population (0 where it gives
--    none: most hamlets and every farm). The search ranks a larger place
--    first among matches of the same closeness and kind.
--  * Expand only: every column has a default that a place loaded before this
--    migration holds (no alternate names, population unknown), and a loader
--    of the previous release, which writes none of them, still loads. A reload
--    of the same dump fills them (docs/deployment.md § Reference datasets).
--  * No RLS or grant change: the table's read policy and water_app's SELECT
--    grant (225) cover the new columns; the app still never writes the table.

ALTER TABLE gazetteer_reference
	ADD COLUMN alt_names text[] NOT NULL DEFAULT '{}',
	ADD COLUMN alt_search text NOT NULL DEFAULT '',
	ADD COLUMN population bigint NOT NULL DEFAULT 0
		CONSTRAINT gazetteer_reference_population_check CHECK (population >= 0),
	ADD CONSTRAINT gazetteer_reference_alt_names_check CHECK (
		cardinality(alt_names) <= 200
		AND char_length(alt_search) <= 45000
		AND cardinality(alt_names) = cardinality(string_to_array(alt_search, ' | '))
	);

CREATE INDEX gazetteer_reference_alt_search_trgm_idx ON gazetteer_reference USING gin ((' ' || alt_search) gin_trgm_ops);

COMMENT ON COLUMN gazetteer_reference.alt_names IS
	'The place''s other names as GeoNames publishes them, those the loader keeps (Latin script, no codes or links; 237). Shown with a match found by one.';
COMMENT ON COLUMN gazetteer_reference.alt_search IS
	'alt_names folded as search_name is, in the same order, joined by '' | '' (237). The search''s word-start test goes through its trigram index on '' '' || alt_search.';
COMMENT ON COLUMN gazetteer_reference.population IS
	'GeoNames'' population; 0 where it gives none (237). Ranks a larger place first among matches of the same closeness and kind.';
