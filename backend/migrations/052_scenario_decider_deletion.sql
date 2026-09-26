-- 052_scenario_decider_deletion — an account that decided an application can
-- be deleted (followups.md "Deleting an assessor's account is refused";
-- docs/security.md § Personal information (POPIA)).
--
-- scenario.decided_by is ON DELETE SET NULL (045_contributor_scope), but the
-- foreign key's update goes through scenario_guard, whose "a decision is
-- recorded when the scenario is decided, and never changes" branch refused
-- it: deleting the assessor's app_user row failed. The same bug 048 fixed in
-- note_guard.
--
-- scenario_guard, from its latest definition (045_contributor_scope; 047
-- only disabled it for a backfill), gains one early exit: an update whose
-- only change is decided_by going to NULL, when the account it named no
-- longer exists, passes untouched (updated_at too: nothing about the
-- scenario changed). Only the foreign key's SET NULL fits that: water_app
-- has UPDATE on scenario but can't delete an app_user row, so while the
-- assessor's account exists an update clearing decided_by still meets the
-- "never changes" branch, as does every other change to a decision. The
-- row comparison is over the whole row less decided_by, so a column added
-- later is covered without touching this again. The rest of the function is
-- 045's, unchanged.

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
					IF NEW.name IS DISTINCT FROM OLD.name OR NEW.description IS DISTINCT FROM OLD.description THEN
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
