-- 195_effective_area — take a delineated area into the model gross or
-- effective (gross less what drains into pans), and record which (the
-- hydrologist's review, finding 8's follow-up; docs/design/delineation.md
-- § Pans, docs/design/pans-research.md, docs/data-model.md § Catchment map).
--
-- 193 reports, beside every delineation, the area draining into pans; until
-- now every path that writes a unit's area from a delineation (Use this area
-- on an accepted proposal or a saved sub-catchment, Start's and Divide's
-- area ticks) took the gross area only.
--
-- In this file:
--  * map_feature.non_contributing_m2: of the feature's area, what drains into
--    pans, when the feature was made from a delineation that looked (accept,
--    sub-catchments save, a Start or Divide parcel). NULL for a feature drawn,
--    imported or split, and for one reshaped since (the figure belonged to the
--    old outline; the app clears it with the geometry). Never more than the
--    feature's area.
--  * node.area_basis: with area_source = 'map', which of the feature's areas
--    the unit took: 'gross' (its whole area, as WR2012's quaternary areas
--    are) or 'effective' (without what drains into pans). NULL exactly when
--    the area is typed: a typed change clears it with area_source (store.ts).
--  * Backfill: an accepted proposal's feature gets its pans figure, and a Start or
--    Divide parcel its piece's from the applied plan, each only while its area
--    is still the delineated one (a reshaped feature keeps NULL); every area already
--    from the map was taken gross (the only choice there was).
--  * No new table, policy, grant or function: the columns inherit their
--    tables' RLS and water_app's table grants (152).

ALTER TABLE map_feature
	ADD COLUMN non_contributing_m2 double precision
		CHECK (non_contributing_m2 IS NULL OR (non_contributing_m2 >= 0 AND area_m2 IS NOT NULL AND non_contributing_m2 <= area_m2));

COMMENT ON COLUMN map_feature.non_contributing_m2 IS
	'Of area_m2, what drains into pans (m²; 193, pans.ts), when the feature was made from a delineation that looked: the effective area is area_m2 less it. NULL when unknown (drawn, imported, split, or reshaped since).';

ALTER TABLE node
	ADD COLUMN area_basis text CHECK (area_basis IN ('gross', 'effective'));

-- Every area from the map so far was the gross one.
UPDATE node SET area_basis = 'gross' WHERE area_source = 'map';

ALTER TABLE node
	ADD CONSTRAINT node_area_basis_map CHECK ((area_source = 'map') = (area_basis IS NOT NULL));

COMMENT ON COLUMN node.area_basis IS
	'With area_source = ''map'', which area of area_feature_id was taken: gross (all of it) or effective (less map_feature.non_contributing_m2, what drains into pans; 195). NULL when typed.';

-- An accepted delineation's feature: the proposal's figure (capped at the area, which it never exceeds), only while the
-- feature still has the proposal's area (not reshaped since: the figure was the delineated outline's).
UPDATE map_feature f
	SET non_contributing_m2 = LEAST((p.pans ->> 'nonContributingM2')::double precision, f.area_m2)
	FROM delineation_proposal p
	WHERE p.feature_id = f.id AND p.project_id = f.project_id AND p.status = 'accepted'
		AND p.pans ? 'nonContributingM2' AND f.area_m2 IS NOT NULL
		AND jsonb_typeof(p.pans -> 'nonContributingM2') = 'number'
		AND abs(f.area_m2 - p.area_m2) <= 1e-6 * p.area_m2 + 0.01;

-- A Start or Divide parcel: its piece's figure from the applied plan (a unit's by its key, the rest's), the
-- newest plan that made or redrew it, and only while the parcel still has that piece's area (not reshaped since).
UPDATE map_feature f
	SET non_contributing_m2 = LEAST(x.nc, f.area_m2)
	FROM (
		SELECT DISTINCT ON (parcel_id) project_id, parcel_id, nc, area
		FROM (
			SELECT sp.project_id, sp.decided_at, (d ->> 'parcelId')::uuid AS parcel_id,
				(u ->> 'nonContributingM2')::double precision AS nc, (u ->> 'areaM2')::double precision AS area
			FROM start_proposal sp,
				jsonb_array_elements(sp.decision -> 'units') d,
				jsonb_array_elements(sp.plan -> 'units') u
			WHERE sp.status = 'applied' AND d ->> 'parcelId' IS NOT NULL AND u ->> 'key' = d ->> 'key'
				AND jsonb_typeof(u -> 'nonContributingM2') = 'number' AND jsonb_typeof(u -> 'areaM2') = 'number'
			UNION ALL
			SELECT sp.project_id, sp.decided_at, (sp.decision -> 'rest' ->> 'parcelId')::uuid,
				(sp.plan -> 'rest' ->> 'nonContributingM2')::double precision, (sp.plan -> 'rest' ->> 'areaM2')::double precision
			FROM start_proposal sp
			WHERE sp.status = 'applied' AND sp.decision -> 'rest' ->> 'parcelId' IS NOT NULL
				AND jsonb_typeof(sp.plan -> 'rest' -> 'nonContributingM2') = 'number' AND jsonb_typeof(sp.plan -> 'rest' -> 'areaM2') = 'number'
		) made
		ORDER BY parcel_id, decided_at DESC
	) x
	WHERE f.id = x.parcel_id AND f.project_id = x.project_id AND f.kind = 'farm_parcel' AND f.area_m2 IS NOT NULL
		AND abs(f.area_m2 - x.area) <= 1e-6 * x.area + 0.01;
