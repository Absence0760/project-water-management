-- 163_licensing_authority — the responsible authority decides; the app
-- records it (provisional position, pre-counsel research, 2026-10-01:
-- docs/legal/licensing-positions.md items 1 and 3; docs/scenarios.md
-- § Applications "Workflow", docs/data-model.md § Applications).
--
-- Under the National Water Act only the responsible authority (DWS, or a CMA
-- the power is assigned or delegated to) decides a licence (s1, s27, s41,
-- s42), and every licence carries conditions (s28(1)(d)). 045 let any editor
-- who didn't make an application "decide" it as approved, approved with
-- conditions or refused. Now:
--
--  1. Outcome words. scenario.outcome takes the Act's and GN R267's words:
--     licence_issued (s27, s28(1)(d)), licence_refused (s42),
--     application_rejected (R267 regs 9(1)(b), 11(2), 12(2)(b): formal
--     requirements) and not_considered (s40(4): the use is already
--     authorised). Existing rows map approved and approved_with_conditions
--     to licence_issued and refused to licence_refused. A decision also
--     records the authority's name (decision_authority, required), the date
--     on its decision letter (decision_date, separate from decided_at, the
--     app's stamp), its licence or file reference and whether written
--     reasons were received (s42(b)). Set once, with the outcome, and never
--     changed. A decision recorded before this migration has no authority,
--     date or reasons: its authority reads "Not recorded (before 163)". A
--     team scenario an editor marks decided (PATCH status, no outcome) is a
--     team's own what-if, no licence decision: it records none of this, as
--     before; recording an outcome on any scenario is the authority's.
--  2. Authority capacity. project_member.acts_for_authority: the project's
--     owner marks the members who act for the responsible authority. Only a
--     marked editor (or owner) records a decision. The authority's name
--     lives in settings.responsibleAuthority (backend
--     projects/authoritySettings.ts; no model input).
--  3. Baseline endorsement. run_publication.endorsed_by / endorsed_at /
--     endorsement_note: a marked editor endorses a published baseline for
--     the authority, once (s41(2): the authority decides what evidence it
--     accepts). Allowed on a superseded publication too, since an
--     application may rest on one; run_publication_final lets exactly that
--     through.
--  4. The conflict guard (D1 (c)). Nobody who holds editor or above in a
--     project (directly, or through its team) may be in an applying party
--     (project_member.party), own an application or be shared one
--     (scenario_member). Checked whenever any of those can start: a
--     project_member insert or role/party change, a team_member insert or
--     role change, a project moving team, a scenario insert, a
--     scenario_member insert. The error is check_violation with the
--     constraint name role_conflict, which the API answers as 409
--     `role_conflict` (http/errors.ts). Existing conflicts are not
--     rewritten; the next change to them is refused until they're resolved.
--
-- Changes (each from its latest definition):
--   scenario_guard        from 138: the decision needs a marked editor, an
--                         authority, a date and the reasons flag; the new
--                         columns join the "set once" rule.
--   run_publication_final from 067: lets the endorsement columns through on
--                         a superseded publication, and keeps them once set.

-- ---------------------------------------------------------------------------
-- 1. Outcome words and the decision's record.
-- ---------------------------------------------------------------------------
ALTER TABLE scenario DROP CONSTRAINT scenario_outcome_check;
ALTER TABLE scenario
	ADD COLUMN decision_authority text CHECK (decision_authority IS NULL OR (decision_authority = btrim(decision_authority) AND char_length(decision_authority) BETWEEN 1 AND 200)),
	ADD COLUMN decision_date date,
	ADD COLUMN decision_reference text NOT NULL DEFAULT '' CHECK (char_length(decision_reference) <= 200),
	ADD COLUMN reasons_received boolean;

-- The guard refuses any change to a decided scenario's outcome: off while the words move.
ALTER TABLE scenario DISABLE TRIGGER scenario_guard;
UPDATE scenario SET outcome = CASE outcome WHEN 'refused' THEN 'licence_refused' ELSE 'licence_issued' END
	WHERE outcome IN ('approved', 'approved_with_conditions', 'refused');
UPDATE scenario SET decision_authority = 'Not recorded (before 163)' WHERE status = 'decided' AND outcome IS NOT NULL;
ALTER TABLE scenario ENABLE TRIGGER scenario_guard;

ALTER TABLE scenario
	ADD CONSTRAINT scenario_outcome_check CHECK (outcome IN ('licence_issued', 'licence_refused', 'application_rejected', 'not_considered')),
	ADD CONSTRAINT scenario_decision_recorded CHECK ((outcome IS NOT NULL) = (decision_authority IS NOT NULL)),
	ADD CONSTRAINT scenario_decision_fields CHECK (status = 'decided' OR (decision_date IS NULL AND decision_reference = '' AND reasons_received IS NULL));

COMMENT ON COLUMN scenario.outcome IS
	'The responsible authority''s decision on an application, as recorded by a member acting for it (163): licence_issued, licence_refused, application_rejected or not_considered. Set once, on the move to decided, with decision_authority, decision_date, decision_reference, reasons_received, decided_at, decided_by and decision_note.';
COMMENT ON COLUMN scenario.decision_authority IS
	'The responsible authority whose decision this is (163), named by whoever recorded it; NOT NULL exactly when there is an outcome (every decided application; a team scenario marked decided has neither). "Not recorded (before 163)" on a decision recorded before 163.';
COMMENT ON COLUMN scenario.decision_date IS 'The date on the authority''s decision letter (163); decided_at is when the app recorded it. NULL only on a decision recorded before 163.';
COMMENT ON COLUMN scenario.decision_reference IS 'The authority''s licence or file reference (163); '''' = none given.';
COMMENT ON COLUMN scenario.reasons_received IS 'Whether the authority''s written reasons were received (NWA s42(b); 163). NULL only on a decision recorded before 163.';

-- ---------------------------------------------------------------------------
-- 2. Who acts for the authority.
-- ---------------------------------------------------------------------------
ALTER TABLE project_member ADD COLUMN acts_for_authority boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN project_member.acts_for_authority IS
	'The member acts for the project''s responsible authority (163, settings.responsibleAuthority): as an editor or owner, they record the authority''s decision on an application and endorse a published baseline. Set only by an owner of the project; false on a new membership.';

-- water_app changes a membership's role, party and this flag only (member_update keeps it to owners).
REVOKE UPDATE ON project_member FROM water_app;
GRANT UPDATE (role, party, acts_for_authority) ON project_member TO water_app;

CREATE FUNCTION project_member_authority() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF TG_OP = 'INSERT' THEN
			-- An invite, a sign-up or a new project: never marked on the way in.
			NEW.acts_for_authority := false;
		ELSIF NEW.acts_for_authority IS DISTINCT FROM OLD.acts_for_authority AND NOT app_has_role(NEW.project_id, 'owner') THEN
			RAISE EXCEPTION 'only an owner of the project marks who acts for the responsible authority' USING ERRCODE = 'insufficient_privilege';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER project_member_authority BEFORE INSERT OR UPDATE ON project_member
	FOR EACH ROW EXECUTE FUNCTION project_member_authority();

-- Whether the current user acts for the project's authority with the right
-- to record its decisions: editor or above, and marked by an owner.
CREATE FUNCTION app_acts_for_authority(p_project uuid) RETURNS boolean
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		RETURN app_has_role(p_project, 'editor') AND coalesce((
			SELECT acts_for_authority FROM project_member WHERE project_id = p_project AND user_id = app_current_user_id()
		), false);
	END
	$$;
REVOKE ALL ON FUNCTION app_acts_for_authority(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_acts_for_authority(uuid) TO water_app;

-- scenario_guard, from 138: recording a decision needs app_acts_for_authority,
-- an authority, the decision letter's date and the reasons flag; the new
-- columns are set once, with the outcome.
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
			NEW.decision_authority := NULL;
			NEW.decision_date := NULL;
			NEW.decision_reference := '';
			NEW.reasons_received := NULL;
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
			-- 163: a decision is the responsible authority's, recorded by a member acting for it:
			-- every application's, and any outcome on a team scenario (one an editor only marks
			-- decided, with no outcome, records nothing and needs no authority, as before).
			IF deciding AND (OLD.origin = 'applicant' OR NEW.outcome IS NOT NULL) THEN
				IF NOT app_acts_for_authority(NEW.project_id) THEN
					RAISE EXCEPTION 'only a member acting for the responsible authority records its decision' USING ERRCODE = 'insufficient_privilege';
				END IF;
				IF NEW.outcome IS NULL THEN
					RAISE EXCEPTION 'a decision needs an outcome' USING ERRCODE = 'check_violation';
				END IF;
				IF NEW.decision_authority IS NULL OR NEW.decision_date IS NULL OR NEW.reasons_received IS NULL THEN
					RAISE EXCEPTION 'a decision needs the authority, the date of its decision and whether written reasons were received' USING ERRCODE = 'check_violation';
				END IF;
			END IF;
			IF OLD.origin = 'applicant' THEN
				IF deciding THEN
					IF uid IS NOT DISTINCT FROM OLD.owner_user_id OR NOT app_has_role(NEW.project_id, 'editor') THEN
						RAISE EXCEPTION 'only an assessor (an editor who didn''t make it) decides an application' USING ERRCODE = 'insufficient_privilege';
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
			   OR NEW.decided_at IS DISTINCT FROM OLD.decided_at OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
			   OR NEW.decision_authority IS DISTINCT FROM OLD.decision_authority OR NEW.decision_date IS DISTINCT FROM OLD.decision_date
			   OR NEW.decision_reference IS DISTINCT FROM OLD.decision_reference OR NEW.reasons_received IS DISTINCT FROM OLD.reasons_received THEN
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

-- ---------------------------------------------------------------------------
-- 3. Baseline endorsement.
-- ---------------------------------------------------------------------------
ALTER TABLE run_publication
	ADD COLUMN endorsed_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
	ADD COLUMN endorsed_at timestamptz,
	ADD COLUMN endorsement_note text NOT NULL DEFAULT '' CHECK (char_length(endorsement_note) <= 2000),
	ADD CONSTRAINT run_publication_endorsement CHECK (endorsed_at IS NOT NULL OR (endorsed_by IS NULL AND endorsement_note = ''));
CREATE INDEX run_publication_endorsed_by_idx ON run_publication (endorsed_by);
COMMENT ON COLUMN run_publication.endorsed_at IS
	'When a member acting for the responsible authority endorsed this published baseline (163, POST …/publication/:pubId/endorse); with endorsed_by (NULL once that account is gone) and endorsement_note. Set once, never changed; evidence reports on its run print it.';

GRANT UPDATE (endorsed_by, endorsed_at, endorsement_note) ON run_publication TO water_app;

-- Stamps an endorsement: only by app_acts_for_authority, once.
CREATE FUNCTION run_publication_endorse() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF OLD.endorsed_at IS NULL AND NEW.endorsed_at IS NOT NULL THEN
			IF NOT app_acts_for_authority(NEW.project_id) THEN
				RAISE EXCEPTION 'only a member acting for the responsible authority endorses a baseline' USING ERRCODE = 'insufficient_privilege';
			END IF;
			NEW.endorsed_at := now();
			NEW.endorsed_by := app_current_user_id();
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER run_publication_endorse BEFORE UPDATE OF endorsed_at ON run_publication
	FOR EACH ROW EXECUTE FUNCTION run_publication_endorse();

-- run_publication_final, from 067: a superseded publication may still be
-- endorsed once (an application can rest on it); an endorsement, on any
-- publication, never changes, except that the endorser's account going
-- clears endorsed_by.
CREATE OR REPLACE FUNCTION run_publication_final() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF OLD.endorsed_at IS NOT NULL AND (
			NEW.endorsed_at IS DISTINCT FROM OLD.endorsed_at OR NEW.endorsement_note IS DISTINCT FROM OLD.endorsement_note
			OR (NEW.endorsed_by IS DISTINCT FROM OLD.endorsed_by
				AND (NEW.endorsed_by IS NOT NULL OR EXISTS (SELECT 1 FROM app_user u WHERE u.id = OLD.endorsed_by)))
		) THEN
			RAISE EXCEPTION 'an endorsement is recorded once and never changes' USING ERRCODE = 'check_violation';
		END IF;
		IF OLD.superseded_at IS NOT NULL AND (
			to_jsonb(NEW) - 'published_by' - 'updated_by' - 'endorsed_by' - 'endorsed_at' - 'endorsement_note'
				IS DISTINCT FROM to_jsonb(OLD) - 'published_by' - 'updated_by' - 'endorsed_by' - 'endorsed_at' - 'endorsement_note'
			OR (NEW.published_by IS DISTINCT FROM OLD.published_by
				AND (NEW.published_by IS NOT NULL OR EXISTS (SELECT 1 FROM app_user u WHERE u.id = OLD.published_by)))
			OR (NEW.updated_by IS DISTINCT FROM OLD.updated_by
				AND (NEW.updated_by IS NOT NULL OR EXISTS (SELECT 1 FROM app_user u WHERE u.id = OLD.updated_by)))
		) THEN
			RAISE EXCEPTION 'a superseded publication is history and never changes' USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END
	$$;

-- ---------------------------------------------------------------------------
-- 4. The conflict guard: no editor in an applicant's party.
-- ---------------------------------------------------------------------------

-- A user's effective role in a project (app_project_role for any user, not
-- only the current one). Internal: not granted to water_app, since it would
-- tell anyone anybody's role.
CREATE FUNCTION app_member_role(p_project uuid, p_user uuid) RETURNS project_role
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		RETURN (
			SELECT max(r) FROM (
				SELECT role AS r FROM project_member WHERE project_id = p_project AND user_id = p_user
				UNION ALL
				SELECT CASE tm.role::text
						WHEN 'admin' THEN 'owner'::project_role
						WHEN 'member' THEN 'editor'::project_role
						WHEN 'viewer' THEN 'viewer'::project_role
					END
				FROM project p JOIN team_member tm ON tm.team_id = p.team_id
				WHERE p.id = p_project AND tm.user_id = p_user
			) roles
		);
	END
	$$;
REVOKE ALL ON FUNCTION app_member_role(uuid, uuid) FROM PUBLIC;

-- Refuses p_user holding editor or above in p_project while in an applying
-- party there, owning an application there, or being shared one.
CREATE FUNCTION app_assert_no_role_conflict(p_project uuid, p_user uuid) RETURNS void
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF p_user IS NULL OR coalesce(app_member_role(p_project, p_user) < 'editor'::project_role, true) THEN
			RETURN;
		END IF;
		IF EXISTS (SELECT 1 FROM project_member WHERE project_id = p_project AND user_id = p_user AND party IS NOT NULL)
		   OR EXISTS (SELECT 1 FROM scenario WHERE project_id = p_project AND owner_user_id = p_user AND origin = 'applicant')
		   OR EXISTS (SELECT 1 FROM scenario_member WHERE project_id = p_project AND user_id = p_user) THEN
			RAISE EXCEPTION 'someone who edits a project can''t also be in an applying party, own an application or be shared one there'
				USING ERRCODE = 'check_violation', CONSTRAINT = 'role_conflict';
		END IF;
	END
	$$;
REVOKE ALL ON FUNCTION app_assert_no_role_conflict(uuid, uuid) FROM PUBLIC;

CREATE FUNCTION project_member_role_conflict() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		PERFORM app_assert_no_role_conflict(NEW.project_id, NEW.user_id);
		RETURN NULL;
	END
	$$;
CREATE TRIGGER project_member_role_conflict AFTER INSERT OR UPDATE OF role, party ON project_member
	FOR EACH ROW EXECUTE FUNCTION project_member_role_conflict();

CREATE FUNCTION scenario_role_conflict() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NEW.origin = 'applicant' THEN
			PERFORM app_assert_no_role_conflict(NEW.project_id, NEW.owner_user_id);
		END IF;
		RETURN NULL;
	END
	$$;
CREATE TRIGGER scenario_role_conflict AFTER INSERT ON scenario
	FOR EACH ROW EXECUTE FUNCTION scenario_role_conflict();

CREATE FUNCTION scenario_member_role_conflict() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		PERFORM app_assert_no_role_conflict(NEW.project_id, NEW.user_id);
		RETURN NULL;
	END
	$$;
CREATE TRIGGER scenario_member_role_conflict AFTER INSERT OR UPDATE ON scenario_member
	FOR EACH ROW EXECUTE FUNCTION scenario_member_role_conflict();

-- A team role reaches every project of the team.
CREATE FUNCTION team_member_role_conflict() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		p uuid;
	BEGIN
		FOR p IN SELECT id FROM project WHERE team_id = NEW.team_id LOOP
			PERFORM app_assert_no_role_conflict(p, NEW.user_id);
		END LOOP;
		RETURN NULL;
	END
	$$;
CREATE TRIGGER team_member_role_conflict AFTER INSERT OR UPDATE OF role ON team_member
	FOR EACH ROW EXECUTE FUNCTION team_member_role_conflict();

-- A project moving into a team gives the team's members their roles there.
CREATE FUNCTION project_team_role_conflict() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		u uuid;
	BEGIN
		FOR u IN SELECT user_id FROM team_member WHERE team_id = NEW.team_id LOOP
			PERFORM app_assert_no_role_conflict(NEW.id, u);
		END LOOP;
		RETURN NULL;
	END
	$$;
CREATE TRIGGER project_team_role_conflict AFTER UPDATE OF team_id ON project
	FOR EACH ROW WHEN (NEW.team_id IS NOT NULL AND NEW.team_id IS DISTINCT FROM OLD.team_id)
	EXECUTE FUNCTION project_team_role_conflict();

REVOKE ALL ON FUNCTION project_member_authority(), run_publication_endorse(), project_member_role_conflict(), scenario_role_conflict(),
	scenario_member_role_conflict(), team_member_role_conflict(), project_team_role_conflict() FROM PUBLIC;
