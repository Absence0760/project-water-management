-- 227_licence_terms — a licence issued records its granted terms (issue #523
-- G3; the licensing assessor's review, § Outcome words (D14); docs/roadmap/
-- step-3-licensing.md § 11 D14; docs/data-model.md § Applications).
--
-- An authority often issues less than was applied for, or adds a release
-- condition (NWA s28(1)). Until now a decision recorded only the outcome word,
-- so a licence_issued application counted among the other applications on the
-- baseline at its *applied* ops: the next applicant was assessed against water
-- never granted. Now:
--
--  1. Granted terms. scenario.granted_ops (the "as licensed" revision of the
--     application's ops: the same op catalogue, checked by the API against
--     the base run as the application's own ops are, an application's under
--     its applicant's mask), granted_ops_sha256 (RFC 8785 canonical JSON, as
--     ops_sha256), granted_op_names (as op_names: an application keeps only
--     its own nodes' names) and granted_conditions (the licence's conditions
--     in words, ≤ 4000). Set exactly when the outcome is licence_issued, once,
--     with the decision, and never changed (scenario_guard). Issued with no
--     change, the guard writes the applied ops out as the granted ones, so
--     "granted as applied for" is a recorded fact (granted_ops_sha256 =
--     ops_sha256), never a missing value.
--  2. Existing licence_issued decisions (before 227) are given their applied
--     ops as granted terms, which is what they counted as until now, with the
--     conditions "Not recorded (before 227): counted as applied for.", as 163
--     marked its decisions' authority.
--  3. Where an issued licence counts. app_scenario_licence(scenario) says, as
--     its caller reads it, whether a decided scenario's licence is in force and
--     on which terms; 228 adds the appeal events that change that. An
--     assessment's member (assessment_member_guard) copies those terms in
--     place of the applied ops; the evidence report's other applications and
--     its combined row (backend evidence/report.ts) read the same function.
--
-- Changes (each from its latest definition):
--   scenario_guard          from 188: the granted terms are set with a licence
--                           issued (or written out as applied), refused with any
--                           other outcome, and join the "never changes" list.
--   assessment_member_guard from 145: copies the licence's terms when it is in force.

ALTER TABLE scenario
	ADD COLUMN granted_ops jsonb
		CHECK (granted_ops IS NULL OR (jsonb_typeof(granted_ops) = 'array' AND jsonb_array_length(granted_ops) <= 500 AND octet_length(granted_ops::text) <= 1048576)),
	ADD COLUMN granted_ops_sha256 text CHECK (granted_ops_sha256 IS NULL OR granted_ops_sha256 ~ '^[0-9a-f]{64}$'),
	ADD COLUMN granted_op_names jsonb
		CHECK (granted_op_names IS NULL OR (jsonb_typeof(granted_op_names) = 'array' AND jsonb_array_length(granted_op_names) <= 2000 AND octet_length(granted_op_names::text) <= 1048576)),
	ADD COLUMN granted_conditions text NOT NULL DEFAULT '' CHECK (char_length(granted_conditions) <= 4000);

-- The guard refuses any change to a decided scenario's decision: off while the old licences get their terms.
ALTER TABLE scenario DISABLE TRIGGER scenario_guard;
UPDATE scenario SET granted_ops = ops, granted_ops_sha256 = ops_sha256, granted_op_names = op_names,
	granted_conditions = 'Not recorded (before 227): counted as applied for.'
	WHERE status = 'decided' AND outcome = 'licence_issued';
ALTER TABLE scenario ENABLE TRIGGER scenario_guard;

ALTER TABLE scenario
	ADD CONSTRAINT scenario_granted_terms CHECK (
		(outcome IS NOT DISTINCT FROM 'licence_issued') = (granted_ops IS NOT NULL)
		AND (granted_ops IS NULL) = (granted_ops_sha256 IS NULL)
		AND (granted_ops IS NULL) = (granted_op_names IS NULL)
		AND (granted_ops IS NOT NULL OR granted_conditions = '')
	);

COMMENT ON COLUMN scenario.granted_ops IS
	'The licence''s granted terms as ops (227): the "as licensed" revision of the application''s ops, set exactly when the outcome is licence_issued, once, with the decision; the applied ops written out when it was issued as applied for. Where the licence counts in cumulative impact, these count, not ops (app_scenario_licence; an appeal event varied replaces them, 228).';
COMMENT ON COLUMN scenario.granted_ops_sha256 IS 'SHA-256 of granted_ops as RFC 8785 canonical JSON (227), as ops_sha256; equal to ops_sha256 when issued as applied for. A run of the licensed terms records it as its opsSha256.';
COMMENT ON COLUMN scenario.granted_op_names IS 'Display names for granted_ops (227), as op_names: an application keeps only its own nodes'' names.';
COMMENT ON COLUMN scenario.granted_conditions IS 'The licence''s conditions in words, as the authority''s licence gives them (227); '''' = none recorded. "Not recorded (before 227): …" on a licence issued before 227.';

-- scenario_guard, from 188 (163 + from_scenario): the granted terms (above).
CREATE OR REPLACE FUNCTION scenario_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		run_project uuid;
		run_scenario boolean;
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
			NEW.granted_ops := NULL;
			NEW.granted_ops_sha256 := NULL;
			NEW.granted_op_names := NULL;
			NEW.granted_conditions := '';
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
			-- 227: a licence issued records its granted terms; none given, it is granted as applied for, written out.
			IF deciding THEN
				IF NEW.outcome IS NOT DISTINCT FROM 'licence_issued' THEN
					IF NEW.granted_ops IS NULL THEN
						IF NEW.granted_ops_sha256 IS NOT NULL OR NEW.granted_op_names IS NOT NULL THEN
							RAISE EXCEPTION 'granted terms need their ops' USING ERRCODE = 'check_violation';
						END IF;
						NEW.granted_ops := OLD.ops;
						NEW.granted_ops_sha256 := OLD.ops_sha256;
						NEW.granted_op_names := OLD.op_names;
					END IF;
				ELSIF NEW.granted_ops IS NOT NULL OR NEW.granted_ops_sha256 IS NOT NULL OR NEW.granted_op_names IS NOT NULL OR NEW.granted_conditions <> '' THEN
					RAISE EXCEPTION 'granted terms go with a licence issued' USING ERRCODE = 'check_violation';
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
			   OR NEW.decision_reference IS DISTINCT FROM OLD.decision_reference OR NEW.reasons_received IS DISTINCT FROM OLD.reasons_received
			   OR NEW.granted_ops IS DISTINCT FROM OLD.granted_ops OR NEW.granted_ops_sha256 IS DISTINCT FROM OLD.granted_ops_sha256
			   OR NEW.granted_op_names IS DISTINCT FROM OLD.granted_op_names OR NEW.granted_conditions IS DISTINCT FROM OLD.granted_conditions THEN
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
			SELECT project_id, from_scenario INTO run_project, run_scenario FROM model_run WHERE id = NEW.base_run_id;
			IF run_project IS DISTINCT FROM NEW.project_id THEN
				RAISE EXCEPTION 'run % belongs to a different project', NEW.base_run_id USING ERRCODE = 'foreign_key_violation';
			END IF;
			IF run_scenario THEN
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

-- Whether a decided scenario's licence is in force, and on which terms, as
-- the caller reads the scenario: NULL until it is decided with an outcome;
-- else { inForce, from: 'decision', eventId: null, appealPending: false,
-- terms: { ops, opsSha256, opNames, conditions, asApplied } | null }. A
-- licence issued is in force on its granted terms; any other outcome isn't.
-- 228 adds the appeal events (from: 'event'). The one rule every caller reads.
CREATE FUNCTION app_scenario_licence(p_scenario uuid) RETURNS jsonb
	LANGUAGE sql STABLE SET search_path = public
	AS $$
		SELECT CASE WHEN s.outcome IS NULL THEN NULL ELSE jsonb_build_object(
			'inForce', s.outcome = 'licence_issued',
			'from', 'decision',
			'eventId', NULL,
			'appealPending', false,
			'terms', CASE WHEN s.outcome = 'licence_issued' THEN jsonb_build_object(
				'ops', s.granted_ops, 'opsSha256', s.granted_ops_sha256, 'opNames', s.granted_op_names,
				'conditions', s.granted_conditions, 'asApplied', s.granted_ops_sha256 = s.ops_sha256) END
		) END
		FROM scenario s WHERE s.id = p_scenario AND s.status = 'decided'
	$$;
REVOKE ALL ON FUNCTION app_scenario_licence(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_scenario_licence(uuid) TO water_app;

-- assessment_member_guard, from 145: a member whose licence is in force is
-- assessed on the licence's terms (227), not on the ops applied for.
CREATE OR REPLACE FUNCTION assessment_member_guard() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	DECLARE
		a_project uuid;
		a_base uuid;
		a_status text;
		s scenario%ROWTYPE;
		licence jsonb;
	BEGIN
		SELECT project_id, base_run_id, status INTO a_project, a_base, a_status FROM assessment WHERE id = NEW.assessment_id;
		IF a_project IS DISTINCT FROM NEW.project_id THEN
			RAISE EXCEPTION 'assessment % belongs to a different project', NEW.assessment_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		IF a_status <> 'pending' THEN
			RAISE EXCEPTION 'a completed assessment takes no new members' USING ERRCODE = 'check_violation';
		END IF;
		SELECT * INTO s FROM scenario WHERE id = NEW.scenario_id;
		IF s.id IS NULL OR s.project_id IS DISTINCT FROM NEW.project_id THEN
			RAISE EXCEPTION 'scenario % not found', NEW.scenario_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		IF s.base_run_id IS DISTINCT FROM a_base THEN
			RAISE EXCEPTION 'scenario % is based on another run', NEW.scenario_id USING ERRCODE = 'check_violation';
		END IF;
		IF s.origin = 'applicant' AND s.status NOT IN ('submitted', 'decided') THEN
			RAISE EXCEPTION 'an application is assessed once it is submitted' USING ERRCODE = 'check_violation';
		END IF;
		licence := app_scenario_licence(s.id);
		NEW.name := s.name;
		NEW.origin := s.origin;
		IF coalesce((licence->>'inForce')::boolean, false) THEN
			NEW.ops := licence->'terms'->'ops';
			NEW.ops_sha256 := licence->'terms'->>'opsSha256';
		ELSE
			NEW.ops := s.ops;
			NEW.ops_sha256 := s.ops_sha256;
		END IF;
		NEW.owned_node_ids := s.owned_node_ids;
		NEW.status := 'pending';
		NEW.problems := '[]';
		NEW.summary := NULL;
		NEW.start_date := NULL;
		NEW.end_date := NULL;
		NEW.finished_at := NULL;
		RETURN NEW;
	END
	$$;
