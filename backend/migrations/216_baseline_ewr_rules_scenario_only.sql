-- 216_baseline_ewr_rules_scenario_only — the EWR is assessed in the baseline, never applied (issue #523 B4).
--
-- Decided by the client's hydrologist and the operator (2026-10-11, issue #90
-- R4 (b), #507 § Principle): in the baseline the EWR is assessed and
-- reported, never applied, and stays unadjusted. The rules that keep water
-- in the river for the EWR run only in a scenario, as allocationMode's cap
-- and full allocation do (213):
--   - a dam's pass-inflow release without monthly amounts (it passes up to
--     the EWR required at the unit): node.dam_release_rule 'passInflow' with
--     dam_release_m3_day NULL;
--   - a unit's hands-off flow that also leaves the EWR: node.hands_off_ewr;
--   - a river off-take's that does: transfer.hands_off_ewr;
--   - the drought restriction's EWR trigger: settings.droughtRestriction.ewrTrigger.
-- A set flow stays (a hands-off flow by month, a pass-inflow release with
-- amounts): an operating rule the hydrologist enters, not the EWR. From this
-- change the API refuses a save that switches one on (400
-- ewr_rule_scenario_only), an import, a copy or a restore switches them off
-- (backend/src/projects/ewrRules.ts), and the input a baseline run reads drops
-- them (runs/execute.ts loadLiveInput). A scenario switches them on with its
-- ops (docs/scenarios.md § The EWR-keeping rules).
--
-- Here every stored one is switched off: the release rule becomes 'none',
-- hands_off_ewr false, and the restriction loses its ewrTrigger (its storage
-- levels stay). Nothing is lost without a record: the project's History gets
-- one `model.ewr_rules_reset` event, with no actor (a migration, not a
-- person), listing each rule switched off with what it was ({ rules: [{ kind,
-- id, name } | { kind, id, from, to } | { kind, siteNodeId, level }] }), so
-- the owner can rebuild it as a scenario. Earlier runs and model revisions
-- keep them (records of the past); restoring one switches them off again.
-- Inert ones (on a node without a dam, a dam transfer, a switched-off
-- transfer) are switched off too: the engine's lister counts them, since one
-- edit would make them run.
CREATE TEMP TABLE ewr_reset (project_id uuid NOT NULL, ord int NOT NULL, rule jsonb NOT NULL) ON COMMIT DROP;

INSERT INTO ewr_reset (project_id, ord, rule)
SELECT n.project_id, 1, jsonb_build_object('kind', 'damPassInflow', 'id', n.id, 'name', n.name)
FROM node n
WHERE n.dam_release_rule = 'passInflow' AND n.dam_release_m3_day IS NULL;

INSERT INTO ewr_reset (project_id, ord, rule)
SELECT n.project_id, 2, jsonb_build_object('kind', 'unitHandsOff', 'id', n.id, 'name', n.name)
FROM node n
WHERE n.hands_off_ewr;

INSERT INTO ewr_reset (project_id, ord, rule)
SELECT t.project_id, 3, jsonb_build_object('kind', 'offtakeHandsOff', 'id', t.id, 'from', f.name, 'to', d.name)
FROM transfer t
JOIN node f ON f.id = t.from_node_id
JOIN node d ON d.id = t.to_node_id
WHERE t.hands_off_ewr;

INSERT INTO ewr_reset (project_id, ord, rule)
SELECT p.id, 4, jsonb_build_object('kind', 'restrictionEwrTrigger') || (p.settings -> 'droughtRestriction' -> 'ewrTrigger')
FROM project p
WHERE jsonb_typeof(p.settings -> 'droughtRestriction' -> 'ewrTrigger') = 'object';

UPDATE node SET dam_release_rule = 'none'
WHERE dam_release_rule = 'passInflow' AND dam_release_m3_day IS NULL;

UPDATE node SET hands_off_ewr = false WHERE hands_off_ewr;

UPDATE transfer SET hands_off_ewr = false WHERE hands_off_ewr;

UPDATE project SET settings = settings #- '{droughtRestriction,ewrTrigger}'
WHERE jsonb_typeof(settings -> 'droughtRestriction' -> 'ewrTrigger') = 'object';

INSERT INTO audit_event (project_id, actor_user_id, actor_label, kind, subject)
SELECT project_id, NULL, '', 'model.ewr_rules_reset', jsonb_build_object('rules', jsonb_agg(rule ORDER BY ord, rule ->> 'name', rule ->> 'id'))
FROM ewr_reset
GROUP BY project_id;
