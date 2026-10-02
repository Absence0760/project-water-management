-- 185_proposal_record — a delineation or start/divide proposal stays as it
-- was proposed and decided (175, 178, 182; docs/security.md § Map uploads).
--
-- The headers of 175 and 178 say an accepted or applied proposal "stays on
-- record" (the map feature's and the model's provenance), but their final
-- triggers locked only the decision columns (and the plan and mode), so an
-- editor's transaction (an API bug, an injected query) could still:
--   * rewrite what was proposed after the fact: the polygon, its area, the
--     dataset, the method (delineation_proposal), the dataset and method
--     (start_proposal);
--   * move a proposal to another project they also edit (project_id);
--   * name someone else as its maker (created_by, never pinned on insert);
--   * delete an accepted or applied proposal (the delete policies had no
--     status condition), losing the feature's or model's provenance.
-- And the "has the decider's account gone?" check ran with the caller's
-- privileges, so app_user's RLS could hide a live decider and let decided_by
-- be cleared (066 and 138 use SECURITY DEFINER for that check).
--
-- Now, starting from each trigger's latest definition (175's; 182's for
-- start_proposal):
--   * every column but the decision's never changes: what was proposed, its
--     project, its id and time. created_by changes only when its foreign key
--     clears it (the account is gone);
--   * the decision columns stay final as before (status, decided_at,
--     decided_by, feature_id, decision);
--   * on insert, created_by is the signed-in user when there is one (the
--     schema owner, with no user, plants test rows);
--   * both functions are SECURITY DEFINER, with search_path pinned;
--   * editors may delete a proposal nobody acted on (open, superseded,
--     rejected or discarded: the routes' pruning); an accepted or applied
--     one, the provenance, goes only with its project (a foreign key's
--     cascade isn't subject to RLS).

-- The columns a decision may move; every other column is what was proposed.
CREATE OR REPLACE FUNCTION delineation_proposal_final() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		decision_cols text[] := ARRAY['status', 'decided_at', 'decided_by', 'feature_id', 'created_by'];
	BEGIN
		IF TG_OP = 'INSERT' THEN
			IF app_current_user_id() IS NOT NULL THEN
				NEW.created_by := app_current_user_id();
			END IF;
			RETURN NEW;
		END IF;
		IF (to_jsonb(NEW) - decision_cols) IS DISTINCT FROM (to_jsonb(OLD) - decision_cols) THEN
			RAISE EXCEPTION 'a delineation proposal stays as it was proposed' USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.created_by IS DISTINCT FROM OLD.created_by
			AND (NEW.created_by IS NOT NULL OR EXISTS (SELECT 1 FROM app_user u WHERE u.id = OLD.created_by)) THEN
			RAISE EXCEPTION 'who proposed a delineation never changes' USING ERRCODE = 'check_violation';
		END IF;
		IF OLD.decided_at IS NOT NULL AND (
			NEW.status IS DISTINCT FROM OLD.status
			OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
			OR (NEW.feature_id IS DISTINCT FROM OLD.feature_id AND NEW.feature_id IS NOT NULL)
			OR (NEW.decided_by IS DISTINCT FROM OLD.decided_by
				AND (NEW.decided_by IS NOT NULL OR EXISTS (SELECT 1 FROM app_user u WHERE u.id = OLD.decided_by)))
		) THEN
			RAISE EXCEPTION 'a delineation proposal is decided once, and the decision stays' USING ERRCODE = 'check_violation';
		END IF;
		IF OLD.status = 'superseded' AND NEW.status IS DISTINCT FROM 'superseded' THEN
			RAISE EXCEPTION 'a superseded delineation proposal stays superseded' USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END
	$$;
REVOKE ALL ON FUNCTION delineation_proposal_final() FROM PUBLIC, water_app;
DROP TRIGGER delineation_proposal_final ON delineation_proposal;
CREATE TRIGGER delineation_proposal_final BEFORE INSERT OR UPDATE ON delineation_proposal
	FOR EACH ROW EXECUTE FUNCTION delineation_proposal_final();

CREATE OR REPLACE FUNCTION start_proposal_final() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		decision_cols text[] := ARRAY['status', 'decided_at', 'decided_by', 'decision', 'created_by'];
	BEGIN
		IF TG_OP = 'INSERT' THEN
			IF app_current_user_id() IS NOT NULL THEN
				NEW.created_by := app_current_user_id();
			END IF;
			RETURN NEW;
		END IF;
		-- The plan and the mode are among what was proposed (178, 182), now with the dataset, method and project.
		IF NEW.plan IS DISTINCT FROM OLD.plan THEN
			RAISE EXCEPTION 'a start proposal''s plan stays as proposed' USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.mode IS DISTINCT FROM OLD.mode THEN
			RAISE EXCEPTION 'a start proposal''s mode stays as proposed' USING ERRCODE = 'check_violation';
		END IF;
		IF (to_jsonb(NEW) - decision_cols) IS DISTINCT FROM (to_jsonb(OLD) - decision_cols) THEN
			RAISE EXCEPTION 'a start proposal stays as it was proposed' USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.created_by IS DISTINCT FROM OLD.created_by
			AND (NEW.created_by IS NOT NULL OR EXISTS (SELECT 1 FROM app_user u WHERE u.id = OLD.created_by)) THEN
			RAISE EXCEPTION 'who proposed a start proposal never changes' USING ERRCODE = 'check_violation';
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
REVOKE ALL ON FUNCTION start_proposal_final() FROM PUBLIC, water_app;
DROP TRIGGER start_proposal_final ON start_proposal;
CREATE TRIGGER start_proposal_final BEFORE INSERT OR UPDATE ON start_proposal
	FOR EACH ROW EXECUTE FUNCTION start_proposal_final();

-- Editors prune what nobody acted on or what was turned down; an accepted or applied proposal stays.
DROP POLICY delineation_proposal_delete ON delineation_proposal;
CREATE POLICY delineation_proposal_delete ON delineation_proposal FOR DELETE
	USING (status IN ('proposed', 'superseded', 'rejected') AND app_has_role(project_id, 'editor'));
DROP POLICY start_proposal_delete ON start_proposal;
CREATE POLICY start_proposal_delete ON start_proposal FOR DELETE
	USING (status IN ('proposed', 'superseded', 'discarded') AND app_has_role(project_id, 'editor'));
