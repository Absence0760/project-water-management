-- 182_divide_proposal — dividing a model that already has nodes into
-- sub-catchments from the map (issue #326 C3's follow-up; docs/design/start-from-map.md
-- § Dividing a model that has nodes, docs/maps.md § Start from the map,
-- docs/data-model.md § Catchment map). Numbered 182 by assignment.
--
-- In this file:
--  * start_proposal.mode: 'start' (178's proposals, an empty model's nodes
--    made from the map) or 'divide' (an existing model's units, each linked
--    to a point on the map, given its own sub-catchment's area and drains-into,
--    proposed against its current values and taken value by value). One
--    table: the two share the method, the dataset, the one-open-a-project
--    rule, the hourly cap and the final decision; the plan and the decision
--    hold the mode's own shape (backend/src/delineation/start.ts, divide.ts).
--    A division is always from the elevation model (without one there is
--    nothing to divide by), so a divide row has from_dem true.
--  * The final-decision trigger is redefined from its latest definition (178)
--    to keep the mode too: a proposal never changes what it is.
--  * No new table, so RLS, policies and grants are 178's (viewer reads,
--    editor proposes and decides), unchanged; existing rows are 'start'.

ALTER TABLE start_proposal
	ADD COLUMN mode text NOT NULL DEFAULT 'start' CHECK (mode IN ('start', 'divide'));
ALTER TABLE start_proposal
	ADD CONSTRAINT start_proposal_divide_from_dem CHECK (mode <> 'divide' OR from_dem);

COMMENT ON COLUMN start_proposal.mode IS
	'start: an empty model''s nodes proposed from the map (178). divide: an existing model''s units given their sub-catchments'' areas and order from the map, against their current values (182). Never changes.';

-- 178's trigger, with the mode kept as well as the plan.
CREATE OR REPLACE FUNCTION start_proposal_final() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF NEW.plan IS DISTINCT FROM OLD.plan THEN
			RAISE EXCEPTION 'a start proposal''s plan stays as proposed' USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.mode IS DISTINCT FROM OLD.mode THEN
			RAISE EXCEPTION 'a start proposal''s mode stays as proposed' USING ERRCODE = 'check_violation';
		END IF;
		IF OLD.decided_at IS NOT NULL AND (
			NEW.status IS DISTINCT FROM OLD.status
			OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
			OR NEW.decision IS DISTINCT FROM OLD.decision
			OR (NEW.decided_by IS DISTINCT FROM OLD.decided_by
				AND (NEW.decided_by IS NOT NULL OR EXISTS (SELECT 1 FROM app_user u WHERE u.id = OLD.decided_by)))
		) THEN
			RAISE EXCEPTION 'a start proposal is decided once, and the decision stays' USING ERRCODE = 'check_violation';
		END IF;
		IF OLD.status = 'superseded' AND NEW.status IS DISTINCT FROM 'superseded' THEN
			RAISE EXCEPTION 'a superseded start proposal stays superseded' USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END
	$$;
