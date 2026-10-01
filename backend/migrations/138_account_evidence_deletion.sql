-- 138_account_evidence_deletion — an account that made project evidence can
-- be deleted (issue #112; docs/security.md § Personal information (POPIA),
-- "Evidence that names its maker"; deployment.md § Runbooks item 7).
--
-- Until now seven foreign keys to app_user were RESTRICT, so deleting the
-- account of anyone who had created a project, a team, a run, an ensemble, a
-- nomination, a scenario or an import was refused, and Privacy §7 promised
-- to "agree" an outcome first. The rule now (pre-counsel research on POPIA
-- s14 and s16, not yet confirmed by the client's information officer, #90):
-- **keep the evidence, remove the name**, as the audit log already does
-- (D12, 048). Moving it to a colleague's name would make the record false
-- (s16), so nothing is reassigned. A sign-off keeps its typed name and
-- registration (the signature), with the account cleared, as before.
--
--   1. project.created_by, team.created_by, model_run.created_by,
--      run_uncertainty.created_by, run_nomination.nominated_by,
--      project_import.imported_by and scenario.owner_user_id:
--      RESTRICT → ON DELETE SET NULL, and NOT NULL dropped (the
--      constraints keep their names; each column already has its covering
--      index). The readers that inner-joined app_user on them now left-join
--      (runs, compare, ensembles, the import record, scenarios), so a row
--      whose maker is gone stays visible with no name.
--
--   2. app_maker_kept, a new BEFORE INSERT OR UPDATE OF created_by trigger
--      on project, team and model_run: dropping NOT NULL mustn't let a row be
--      made without its maker, or let anyone clear or change a live maker.
--      An insert needs one; an update may only clear it when the account it
--      named no longer exists (the foreign key's SET NULL, run after the
--      app_user row is gone, the 066 pattern). water_app holds UPDATE on
--      project and team (table grants), so before this an editor could have
--      rewritten who created them; now nobody can. model_run has no UPDATE
--      grant on created_by. The other four keep their maker through their
--      stamp triggers (run_uncertainty_start, run_nomination_stamp,
--      project_import_stamp, scenario_guard), which set it from the session
--      on insert and refuse an insert with no signed-in user.
--
--   3. run_uncertainty_complete (from its only definition, 014): every
--      update of a completed ensemble was refused ("stored once and never
--      changed"), the foreign key's SET NULL included, so every completed
--      ensemble would have blocked the deletion. An update whose only
--      change is clearing created_by, for an account that no longer exists,
--      passes untouched (066's sweep and outlook guards do the same).
--
--   4. scenario_guard (from its latest definition, 129_scenario_statement):
--      052's early exit for decided_by also covers owner_user_id. An update
--      whose only changes are those two going to NULL, each for an account
--      that no longer exists, passes untouched; while the account exists the
--      "owner never changes" branch still refuses it.
--
--   5. app_user_pseudonymise (from its latest definition, 066), before the
--      row goes:
--      - deletes the person's still-started ensembles: never completed,
--        nothing rests on them, and only their starter could complete one;
--      - deletes their **draft applications** (origin 'applicant', status
--        'draft') with their runs (scenario_drop_application_runs). A draft
--        is the applicant's own work in progress, which the project has
--        never been asked to judge. A submitted, withdrawn or decided one is
--        the project's record and stays, its applicant cleared (as its
--        assessor is, 052). A draft the delete guards keep (public comments,
--        a signed run or an evidence pack, 072 and 115) or one with a run
--        the project keeps (pinned, nominated or cited, app_run_kept) stays
--        too, its applicant cleared, so no run is left in the project with
--        its scenario gone. A team scenario is the team's: kept, maker
--        cleared.
--
-- What deletion still refuses: an account that is the only owner of a
-- project or the only admin of a team (the deferred project_member_keep_owner
-- and team_member_keep_admin triggers, at commit). Hand it over first.
--
-- Forward-only from main; expand-only for readers (a column becoming
-- nullable). No grants change: water_app's grants on these tables are as
-- before, and the new trigger function is closed to PUBLIC and water_app
-- like every trigger function (028).

ALTER TABLE project DROP CONSTRAINT project_created_by_fkey,
	ADD CONSTRAINT project_created_by_fkey FOREIGN KEY (created_by) REFERENCES app_user (id) ON DELETE SET NULL,
	ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE team DROP CONSTRAINT team_created_by_fkey,
	ADD CONSTRAINT team_created_by_fkey FOREIGN KEY (created_by) REFERENCES app_user (id) ON DELETE SET NULL,
	ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE model_run DROP CONSTRAINT model_run_created_by_fkey,
	ADD CONSTRAINT model_run_created_by_fkey FOREIGN KEY (created_by) REFERENCES app_user (id) ON DELETE SET NULL,
	ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE run_uncertainty DROP CONSTRAINT run_uncertainty_created_by_fkey,
	ADD CONSTRAINT run_uncertainty_created_by_fkey FOREIGN KEY (created_by) REFERENCES app_user (id) ON DELETE SET NULL,
	ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE run_nomination DROP CONSTRAINT run_nomination_nominated_by_fkey,
	ADD CONSTRAINT run_nomination_nominated_by_fkey FOREIGN KEY (nominated_by) REFERENCES app_user (id) ON DELETE SET NULL,
	ALTER COLUMN nominated_by DROP NOT NULL;
ALTER TABLE project_import DROP CONSTRAINT project_import_imported_by_fkey,
	ADD CONSTRAINT project_import_imported_by_fkey FOREIGN KEY (imported_by) REFERENCES app_user (id) ON DELETE SET NULL,
	ALTER COLUMN imported_by DROP NOT NULL;
ALTER TABLE scenario DROP CONSTRAINT scenario_owner_user_id_fkey,
	ADD CONSTRAINT scenario_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES app_user (id) ON DELETE SET NULL,
	ALTER COLUMN owner_user_id DROP NOT NULL;

-- 2. A maker on every new project, team and run; never changed, only cleared with its account.
CREATE FUNCTION app_maker_kept() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF TG_OP = 'INSERT' THEN
			IF NEW.created_by IS NULL THEN
				RAISE EXCEPTION 'a new % needs the account that made it', TG_TABLE_NAME USING ERRCODE = 'not_null_violation';
			END IF;
		ELSIF NEW.created_by IS DISTINCT FROM OLD.created_by
			AND NOT (NEW.created_by IS NULL AND NOT EXISTS (SELECT 1 FROM app_user u WHERE u.id = OLD.created_by)) THEN
			RAISE EXCEPTION 'who made a % never changes', TG_TABLE_NAME USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER project_maker_kept BEFORE INSERT OR UPDATE OF created_by ON project
	FOR EACH ROW EXECUTE FUNCTION app_maker_kept();
CREATE TRIGGER team_maker_kept BEFORE INSERT OR UPDATE OF created_by ON team
	FOR EACH ROW EXECUTE FUNCTION app_maker_kept();
CREATE TRIGGER model_run_maker_kept BEFORE INSERT OR UPDATE OF created_by ON model_run
	FOR EACH ROW EXECUTE FUNCTION app_maker_kept();
REVOKE ALL ON FUNCTION app_maker_kept() FROM PUBLIC, water_app;

-- 3. A completed ensemble lets its starter's account go.
CREATE OR REPLACE FUNCTION run_uncertainty_complete() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		-- An account going: its foreign key clears who started it, nothing else.
		IF NEW.created_by IS NULL AND OLD.created_by IS NOT NULL
			AND to_jsonb(NEW) - 'created_by' = to_jsonb(OLD) - 'created_by'
			AND NOT EXISTS (SELECT 1 FROM app_user u WHERE u.id = OLD.created_by) THEN
			RETURN NEW;
		END IF;
		IF OLD.status <> 'started' THEN
			RAISE EXCEPTION 'an ensemble is stored once and never changed' USING ERRCODE = 'check_violation';
		END IF;
		IF app_current_user_id() IS DISTINCT FROM OLD.created_by THEN
			RAISE EXCEPTION 'only whoever started an ensemble can complete it' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF NEW.status <> 'complete' THEN
			RAISE EXCEPTION 'a started ensemble can only be completed' USING ERRCODE = 'check_violation';
		END IF;
		NEW.completed_at := clock_timestamp();
		RETURN NEW;
	END
	$$;

-- 4. scenario_guard, from 129: the owner's account going clears owner_user_id, as the assessor's clears decided_by (052).
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
		-- An account going (the owner's or the assessor's): its foreign key clears
		-- owner_user_id or decided_by, nothing else, and only once the account is gone.
		IF TG_OP = 'UPDATE'
			AND (to_jsonb(NEW) - 'decided_by' - 'owner_user_id') = (to_jsonb(OLD) - 'decided_by' - 'owner_user_id')
			AND (NEW.decided_by, NEW.owner_user_id) IS DISTINCT FROM (OLD.decided_by, OLD.owner_user_id)
			AND (NEW.decided_by IS NOT DISTINCT FROM OLD.decided_by
				OR (NEW.decided_by IS NULL AND NOT EXISTS (SELECT 1 FROM app_user u WHERE u.id = OLD.decided_by)))
			AND (NEW.owner_user_id IS NOT DISTINCT FROM OLD.owner_user_id
				OR (NEW.owner_user_id IS NULL AND NOT EXISTS (SELECT 1 FROM app_user u WHERE u.id = OLD.owner_user_id)))
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

-- 5. app_user_pseudonymise, from 066: also the person's started ensembles and their draft applications.
CREATE OR REPLACE FUNCTION app_user_pseudonymise() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		UPDATE audit_event SET actor_label = 'Deleted user' WHERE actor_user_id = OLD.id;
		UPDATE audit_event SET subject = jsonb_set(subject, '{displayName}', to_jsonb('Deleted user'::text))
			WHERE subject->>'userId' = OLD.id::text AND subject ? 'displayName';
		-- note.deleted names the note's author: by id since 048 (authorId), and
		-- through the note itself for the events written before.
		UPDATE audit_event e SET subject = jsonb_set(e.subject, '{author}', to_jsonb('Deleted user'::text))
			WHERE e.kind = 'note.deleted' AND e.subject ? 'author' AND (
				e.subject->>'authorId' = OLD.id::text
				OR EXISTS (SELECT 1 FROM note n WHERE n.id::text = e.subject->>'noteId' AND n.author_id = OLD.id)
			);
		-- 066: a PDF someone else asked for no longer names them as a recipient
		-- (their own reports go with requested_by's cascade).
		UPDATE report SET email_to = array_remove(email_to, OLD.id)
			WHERE OLD.id = ANY (email_to) AND requested_by <> OLD.id;
		-- 138: an ensemble they started and never completed; nothing rests on it.
		DELETE FROM run_uncertainty WHERE created_by = OLD.id AND status = 'started';
		-- 138: their draft applications, with the runs only they could see
		-- (scenario_drop_application_runs), unless the project keeps the draft
		-- or one of its runs (then it stays, its applicant cleared by the key).
		DELETE FROM scenario s
			WHERE s.owner_user_id = OLD.id AND s.origin = 'applicant' AND s.status = 'draft'
			  AND NOT EXISTS (SELECT 1 FROM note n WHERE n.scenario_id = s.id AND n.visibility = 'public_participation')
			  AND NOT EXISTS (SELECT 1 FROM evidence_pack ep WHERE ep.scenario_id = s.id)
			  AND NOT EXISTS (SELECT 1 FROM model_run r WHERE r.scenario_id = s.id AND app_run_kept(r.id));
		RETURN OLD;
	END
	$$;
