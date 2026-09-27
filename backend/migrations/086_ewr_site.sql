-- 086_ewr_site — whether a gauge is an EWR site (engine 1.5.0, audit Q17
-- follow-on, roadmap WP-3.7, docs/model.md §2.7b).
--
-- Until engine 1.5.0 every gauge was an EWR site: the EWR was assessed there
-- and its shortfall charged to the farms upstream. ewr_site = false makes a
-- gauge a flow-record station only: it keeps its flow and EWR-shortfall
-- series but charges nobody, and a Reserve rule table at it is skipped.
--
-- DEFAULT true: every existing row stays an EWR site, so every existing
-- project runs exactly as before. The CHECK keeps the flag false only on a
-- gauge; that the outlet is always a site is a model rule (the engine's
-- modelRuleIssues, which the API applies on save), not a constraint, because
-- a save clears the nodes' topology part-way (model/store.ts saveModel).
--
-- A new column on an existing table: the table-level grants to water_app in
-- 001 and its RLS policies already cover it; no foreign key, so no index.

ALTER TABLE node
	ADD COLUMN ewr_site boolean NOT NULL DEFAULT true,
	ADD CONSTRAINT node_ewr_site_gauge CHECK (ewr_site OR kind = 'gauge');

COMMENT ON COLUMN node.ewr_site IS
	'Gauges: whether the EWR is assessed here (its shortfall charged upstream, a Reserve rule table may sit here). Default true; false only on a gauge, never the outlet (model rule). Engine >= 1.5.0.';
