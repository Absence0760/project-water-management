-- 193_delineation_pans — the area of a delineated catchment that drains into
-- pans (the hydrologist's review, finding 8; docs/design/delineation.md
-- § Pans, docs/design/pans-research.md, docs/data-model.md § Catchment map).
--
-- Priority-Flood fills every closed depression in the DEM so that D8 can
-- route it to the outlet. In South Africa's interior many of those are pans,
-- whose catchments WR2012 counts as non-contributing ("endoreic areas"). The
-- delineation now reports, beside the (unchanged) catchment, the area that
-- drains into a closed depression deep, wide and capacious enough to be a pan
-- (backend/src/delineation/pans.ts), with the largest pans and the method.
--
-- In this file:
--  * delineation_proposal.pans: that report as a small jsonb object
--    ({ nonContributingM2, count, largest[≤ 5], method }). NULL on proposals
--    made before delineate-9, which never looked. Written once with the
--    proposal; 185's proposal_record trigger already keeps every column but
--    the decision's as proposed, this one included.
--  * Start and Divide proposals carry the same report inside their plan
--    (start_proposal.plan, start-11), so they need no column.
--  * No new table, policy, grant or function: the column inherits the
--    table's RLS and water_app's grants (175).

ALTER TABLE delineation_proposal
	ADD COLUMN pans jsonb CHECK (pans IS NULL OR (jsonb_typeof(pans) = 'object' AND pg_column_size(pans) < 20000));

COMMENT ON COLUMN delineation_proposal.pans IS
	'What of the catchment drains into pans (closed depressions the fill routed onward): { nonContributingM2, count, largest, method } (193, pans.ts). Reported, never taken out of area_m2 or the polygon; NULL before delineate-9.';
