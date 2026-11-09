-- 318_evaporation_span_kind_removed — take the Symons-pan (S-pan) grid kind
-- back out of evaporation_dataset (issue #738; docs/maps.md § The evaporation
-- grid).
--
-- 316 admitted kind 'span' for CCWR's S-pan grids from the WRC Atlas of
-- Agrohydrology 2008. On 2026-11-09 the Atlas turned out to ship no S-pan
-- grids (#738 step 1), so the kind had no source and the operator asked for
-- it to be removed. Production never loaded one. The WR2012 monthly S-pan per
-- quaternary (quaternary_evaporation, 310) is a different table and is
-- untouched.
--
-- In this file, starting from the latest definitions (316's kind check, 317's
-- period check):
--  * A guard: if any evaporation_dataset row still has kind 'span', the
--    migration stops with an error naming how many, rather than deleting them
--    or letting the new check fail with a bare constraint violation. Delete
--    those datasets (their cells cascade) as the schema owner first.
--  * evaporation_dataset_period_check (317) is recreated for A-pan only: both
--    years set, or both null and the grid an A-pan one.
--  * evaporation_dataset_kind_check (180, then 316) admits 'et0' and 'apan'
--    again.
--  * Contract only: no stored row changes, and the backend no longer writes
--    'span'. evaporation_accepted (181) never admitted it. No policy, grant
--    or trigger changes (180's cover the table).

DO $$
DECLARE
	n integer;
BEGIN
	SELECT count(*) INTO n FROM evaporation_dataset WHERE kind = 'span';
	IF n > 0 THEN
		RAISE EXCEPTION '318: % evaporation_dataset row(s) still have kind ''span'' (S-pan grids, issue #738); delete them as the schema owner before this migration', n;
	END IF;
END
$$;

ALTER TABLE evaporation_dataset DROP CONSTRAINT evaporation_dataset_period_check;
ALTER TABLE evaporation_dataset ADD CONSTRAINT evaporation_dataset_period_check CHECK (
	(first_year IS NOT NULL AND last_year IS NOT NULL)
	OR (first_year IS NULL AND last_year IS NULL AND kind = 'apan')
);

ALTER TABLE evaporation_dataset DROP CONSTRAINT evaporation_dataset_kind_check;
ALTER TABLE evaporation_dataset ADD CONSTRAINT evaporation_dataset_kind_check CHECK (kind IN ('et0', 'apan'));

COMMENT ON COLUMN evaporation_dataset.kind IS
	'et0: FAO-56 reference ET, proposed as GR4J''s monthly PE; apan: Class-A pan, proposed as the A-pan row. (316 added span, S-pan; 318 removed it again, issue #738.)';
COMMENT ON COLUMN evaporation_dataset.first_year IS
	'The first calendar year the monthly means average, inclusive; null (with last_year) for an A-pan grid whose source states no period, such as the WRC Atlas''s (317, issue #755).';
