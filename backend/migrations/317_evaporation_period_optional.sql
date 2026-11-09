-- 317_evaporation_period_optional — an A-pan or S-pan grid whose source
-- states no period for its monthly means (issue #755; docs/maps.md § The
-- evaporation grid, docs/deployment.md § Reference datasets).
--
-- The WRC Atlas of Agrohydrology 2008 (Section 13.2) says its A-pan
-- equivalent maps are unchanged from the 1997 Atlas (Schulze 1997), derived
-- from regression equations (Schulze and Maharaj 1991) fitted at more than 570
-- stations with at least 3 years of concurrent records; it states no period
-- for the means. 180 made first_year and last_year NOT NULL, so a load had to
-- invent one. The operator chose to store none instead.
--
-- In this file:
--  * evaporation_dataset.first_year and last_year (180) drop NOT NULL. Their
--    inline range checks (1900–2200) and the table check first_year <=
--    last_year pass on NULL, so they stay as they are.
--  * A new check, evaporation_dataset_period_check: both years set, or both
--    null and the grid an A-pan or S-pan one. A reference-ET grid (dPET) is
--    always averaged over the years read from its files, so it always has a
--    period.
--  * Expand only: every stored row has both years and passes the new check,
--    and a backend that always writes both is unaffected. No policy, grant or
--    trigger changes (180's cover the table).

ALTER TABLE evaporation_dataset ALTER COLUMN first_year DROP NOT NULL;
ALTER TABLE evaporation_dataset ALTER COLUMN last_year DROP NOT NULL;
ALTER TABLE evaporation_dataset ADD CONSTRAINT evaporation_dataset_period_check CHECK (
	(first_year IS NOT NULL AND last_year IS NOT NULL)
	OR (first_year IS NULL AND last_year IS NULL AND kind IN ('apan', 'span'))
);

COMMENT ON COLUMN evaporation_dataset.first_year IS
	'The first calendar year the monthly means average, inclusive; null (with last_year) for an A-pan or S-pan grid whose source states no period, such as the WRC Atlas''s (317, issue #755).';
COMMENT ON COLUMN evaporation_dataset.last_year IS
	'The last calendar year the monthly means average, inclusive; null exactly when first_year is (317, issue #755).';
