-- 129_scenario_statement — Appendix C's fixed prompts (issue #71 follow-up
-- "Appendix C's fixed prompts"; docs/design/evidence-report.md § 4.3,
-- docs/data-model.md § Scenarios, docs/evidence-pack.md § What a pack holds).
--
-- Appendix C of the evidence report printed only the scenario's description
-- and the run's notes, as written. It now asks three fixed questions of every
-- application (engine evidence/prompts.ts, APPLICANT_PROMPTS): its purpose and
-- need, its mitigation and its monitoring, each answered or printed as "Not
-- given". The answers are the scenario's, written where it is edited, by whoever
-- may change it (an editor on a team scenario, only the applicant on an
-- application: the route's assertCanChange and the scenario_guard branch
-- below), so they follow the existing scenario RLS unchanged.
--
-- Expand-only.
--
--  1. Three text columns on scenario, each '' until answered and at most
--     4 000 characters, as `description` (024). No existing column fits: `ops`
--     is hashed into ops_sha256 and the run snapshot, and `op_names` is
--     display-only names of the ops' nodes, so a statement in either would
--     change or muddle what they record. Separate columns, not one jsonb, so
--     each answer has its own CHECK and none can grow a shape the report
--     doesn't print. No foreign key, so no index; no new policy: 045's four
--     origin-aware scenario policies decide who reads and writes the row,
--     these columns included, and 024's table-level
--     `GRANT SELECT, INSERT, UPDATE, DELETE ON scenario TO water_app` covers
--     them (a table-level grant extends to columns added later; the catalogue
--     test checks the grant).
--
--  2. scenario_guard, from its latest definition (052_scenario_decider_deletion;
--     045 before it, 024 first): an assessor's decision may not change the
--     answers, as it may not change the name or the description. The rest of
--     the function is 052's, unchanged (SECURITY DEFINER, search_path pinned).
--     Like the description, the answers are not frozen by a submission: the
--     applicant may still correct them while an application is submitted; an
--     issued evidence pack freezes what its Appendix C printed (its manifest).

-- ---------------------------------------------------------------------------
-- 1. The answers
-- ---------------------------------------------------------------------------
ALTER TABLE scenario
	ADD COLUMN purpose_need text NOT NULL DEFAULT '' CHECK (char_length(purpose_need) <= 4000),
	ADD COLUMN mitigation text NOT NULL DEFAULT '' CHECK (char_length(mitigation) <= 4000),
	ADD COLUMN monitoring text NOT NULL DEFAULT '' CHECK (char_length(monitoring) <= 4000);

COMMENT ON COLUMN scenario.purpose_need IS
	'Appendix C prompt "Purpose and need" (129): what the change is for and why the water is needed; '''' = not given.';
COMMENT ON COLUMN scenario.mitigation IS
	'Appendix C prompt "Mitigation" (129): what will avoid, reduce or offset the effect; '''' = not given.';
COMMENT ON COLUMN scenario.monitoring IS
	'Appendix C prompt "Monitoring" (129): how the effect will be measured once built; '''' = not given.';

-- ---------------------------------------------------------------------------
-- 2. scenario_guard, from 052_scenario_decider_deletion.sql
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION scenario_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		run_project uuid;
		run_scenario uuid;
		uid uuid := app_current_user_id();
		deciding boolean;
	BEGIN
		IF TG_OP = 'DELETE' THEN
			IF OLD.status IN ('submitted', 'decided') THEN
				RAISE EXCEPTION 'a % scenario can''t be deleted', OLD.status USING ERRCODE = 'check_violation';
			END IF;
			RETURN OLD;
		END IF;
		-- The assessor's account going: its foreign key clears decided_by, nothing else.
		IF TG_OP = 'UPDATE' AND OLD.decided_by IS NOT NULL AND NEW.decided_by IS NULL
			AND (to_jsonb(NEW) - 'decided_by') = (to_jsonb(OLD) - 'decided_by')
			AND NOT EXISTS (SELECT 1 FROM app_user u WHERE u.id = OLD.decided_by)
		THEN
			RETURN NEW;
		END IF;
		IF TG_OP = 'INSERT' THEN
			NEW.owner_user_id := uid;
			IF NEW.owner_user_id IS NULL THEN
				RAISE EXCEPTION 'a scenario needs a signed-in user' USING ERRCODE = 'insufficient_privilege';
			END IF;
			IF NEW.status <> 'draft' THEN
				RAISE EXCEPTION 'a new scenario is a draft' USING ERRCODE = 'check_violation';
			END IF;
			NEW.created_at := now();
			NEW.origin := CASE WHEN app_project_role(NEW.project_id) = 'contributor' THEN 'applicant' ELSE 'team' END;
			NEW.submitted_at := NULL;
			NEW.decided_at := NULL;
			NEW.decided_by := NULL;
			NEW.outcome := NULL;
			NEW.decision_note := '';
		ELSE
			IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
			   OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.origin IS DISTINCT FROM OLD.origin THEN
				RAISE EXCEPTION 'a scenario''s project, owner, origin and creation time never change' USING ERRCODE = 'check_violation';
			END IF;
			IF OLD.status <> 'draft' AND (NEW.ops IS DISTINCT FROM OLD.ops OR NEW.ops_sha256 IS DISTINCT FROM OLD.ops_sha256
			   OR NEW.base_run_id IS DISTINCT FROM OLD.base_run_id OR NEW.owned_node_ids IS DISTINCT FROM OLD.owned_node_ids) THEN
				RAISE EXCEPTION 'a % scenario is frozen', OLD.status USING ERRCODE = 'check_violation';
			END IF;
			IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
				(OLD.status = 'draft' AND NEW.status = 'submitted')
				OR (OLD.status = 'submitted' AND NEW.status IN ('withdrawn', 'decided'))
				OR (OLD.status = 'withdrawn' AND NEW.status = 'draft')
			) THEN
				RAISE EXCEPTION 'a scenario can''t go from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
			END IF;
			deciding := NEW.status = 'decided' AND OLD.status <> 'decided';
			IF OLD.origin = 'applicant' THEN
				IF deciding THEN
					IF uid IS NOT DISTINCT FROM OLD.owner_user_id OR NOT app_has_role(NEW.project_id, 'editor') THEN
						RAISE EXCEPTION 'only an assessor (an editor who didn''t make it) decides an application' USING ERRCODE = 'insufficient_privilege';
					END IF;
					IF NEW.outcome IS NULL THEN
						RAISE EXCEPTION 'a decision needs an outcome' USING ERRCODE = 'check_violation';
					END IF;
					-- 129: the applicant's answers to Appendix C's prompts are theirs too.
					IF NEW.name IS DISTINCT FROM OLD.name OR NEW.description IS DISTINCT FROM OLD.description
					   OR NEW.purpose_need IS DISTINCT FROM OLD.purpose_need OR NEW.mitigation IS DISTINCT FROM OLD.mitigation
					   OR NEW.monitoring IS DISTINCT FROM OLD.monitoring THEN
						RAISE EXCEPTION 'a decision changes nothing else in the application' USING ERRCODE = 'check_violation';
					END IF;
				ELSIF uid IS DISTINCT FROM OLD.owner_user_id THEN
					RAISE EXCEPTION 'only the applicant changes their application' USING ERRCODE = 'insufficient_privilege';
				END IF;
			END IF;
			IF deciding THEN
				NEW.decided_at := now();
				NEW.decided_by := uid;
			ELSIF NEW.outcome IS DISTINCT FROM OLD.outcome OR NEW.decision_note IS DISTINCT FROM OLD.decision_note
			   OR NEW.decided_at IS DISTINCT FROM OLD.decided_at OR NEW.decided_by IS DISTINCT FROM OLD.decided_by THEN
				RAISE EXCEPTION 'a decision is recorded when the scenario is decided, and never changes' USING ERRCODE = 'check_violation';
			END IF;
			IF NEW.status = 'submitted' AND OLD.status <> 'submitted' THEN
				NEW.submitted_at := now();
			ELSIF NEW.status = 'draft' THEN
				NEW.submitted_at := NULL;
			ELSE
				NEW.submitted_at := OLD.submitted_at;
			END IF;
		END IF;
		NEW.updated_at := now();
		IF TG_OP = 'INSERT' OR NEW.base_run_id IS DISTINCT FROM OLD.base_run_id THEN
			SELECT project_id, scenario_id INTO run_project, run_scenario FROM model_run WHERE id = NEW.base_run_id;
			IF run_project IS DISTINCT FROM NEW.project_id THEN
				RAISE EXCEPTION 'run % belongs to a different project', NEW.base_run_id USING ERRCODE = 'foreign_key_violation';
			END IF;
			IF run_scenario IS NOT NULL THEN
				RAISE EXCEPTION 'run % is a scenario run; base a scenario on a run of the model', NEW.base_run_id USING ERRCODE = 'check_violation';
			END IF;
			IF NEW.origin = 'applicant' AND NOT EXISTS (
				SELECT 1 FROM run_publication p WHERE p.run_id = NEW.base_run_id AND p.project_id = NEW.project_id
			) THEN
				RAISE EXCEPTION 'an application is based on a published run' USING ERRCODE = 'check_violation';
			END IF;
		END IF;
		RETURN NEW;
	END
	$$;
