-- 236_gazetteer_country — the Map's search finds towns just over South
-- Africa's borders (docs/maps.md § Search, § Gazetteer; ad hoc testing
-- 2026-10-13: the basemap labels Kanye, Lobatse and Gaborone in Botswana, and
-- the search found none of them).
--
-- In this file:
--  * gazetteer_reference.country: the place's country, GeoNames' ISO 3166
--    code. The loader (geo/loadGazetteer.ts) now takes GeoNames' dumps for
--    South Africa's six neighbours (Botswana, Lesotho, Mozambique, Namibia,
--    Eswatini, Zimbabwe) as well as South Africa's, keeping a neighbour's
--    places only where the basemap draws (its extent, 16.3,-35,33,-22). The
--    search ranks South Africa's places before a neighbour's of the same
--    closeness and kind, and names a neighbour's country in the match
--    (geo/gazetteer.ts searchMap).
--  * The CHECK is the loader's allow-list (GAZETTEER_COUNTRIES), so not even
--    the schema owner can write another country's places. Adding a country
--    means a migration that widens it, with the loader's list.
--  * Expand only: every place loaded so far is South Africa's (the loader
--    took only ZA until now), so the default fills them, and a loader of the
--    previous release, which names no country, still writes ZA. No index:
--    the search orders by it only among the rows its trigram index offers.
--  * No RLS or grant change: the table's read policy and water_app's SELECT
--    grant (225) cover the new column.

ALTER TABLE gazetteer_reference
	ADD COLUMN country text NOT NULL DEFAULT 'ZA'
		CONSTRAINT gazetteer_reference_country_check CHECK (country IN ('ZA', 'BW', 'LS', 'MZ', 'NA', 'SZ', 'ZW'));

COMMENT ON COLUMN gazetteer_reference.country IS
	'The place''s country (GeoNames'' ISO 3166 code): South Africa or one of its six neighbours (236). Ranks South Africa''s places first and names a neighbour''s in a match.';
