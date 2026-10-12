-- 234_question_kept — an "Ask the assessors why" question stays with the
-- assessors when its draft is deleted (issue #523 G7).
--
-- The licensing assessor's review of #523: a masked refusal ("flow shares
-- over 100 %", "no catchment area left") is substantive evidence that the
-- catchment is fully allocated, so the assessors' answer to the applicant's
-- question is kept in the application's record and can feed the authority's
-- written reasons under s42 of the National Water Act. An application with a
-- masked problem can't be submitted in the app, so its applicant may well
-- delete the draft and apply through DWS (e-WULAAS) instead; with 164's
-- ON DELETE CASCADE the question and the answer went with the draft.
--
-- Now the question outlives the draft: scenario_id is set to NULL when the
-- scenario is deleted, and the row keeps what 164 already copied into it
-- (the application's name, the line as the applicant read it, the ops, the
-- rules' kinds, the line in its real words and the answer). It names no
-- account (who asked is the audit trail's), so nothing personal is added; it
-- still goes with the project. The parties read their questions through
-- app_application_questions(scenario), so a detached question is the
-- assessors' alone (editors and up, 164's policy, unchanged).
--
-- The referential action's UPDATE fires 164's guard, which refused every
-- change but the answer (and any change at all once answered): it now also
-- lets scenario_id go to NULL, and nothing else. The same-project trigger
-- skips a NULL reference already (assert_same_project, 198).

ALTER TABLE application_question DROP CONSTRAINT application_question_scenario_id_fkey;
ALTER TABLE application_question ALTER COLUMN scenario_id DROP NOT NULL;
ALTER TABLE application_question
	ADD CONSTRAINT application_question_scenario_id_fkey FOREIGN KEY (scenario_id) REFERENCES scenario(id) ON DELETE SET NULL;

-- application_question_guard, from 164_applicant_visibility (its latest).
CREATE OR REPLACE FUNCTION application_question_guard() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF TG_OP = 'INSERT' THEN
			IF NEW.answer IS NOT NULL OR NEW.answered_at IS NOT NULL THEN
				RAISE EXCEPTION 'a question is asked without an answer' USING ERRCODE = 'check_violation';
			END IF;
			NEW.asked_at := now();
			RETURN NEW;
		END IF;
		-- Its draft deleted (234): the reference goes, everything else stays as it was.
		IF OLD.scenario_id IS NOT NULL AND NEW.scenario_id IS NULL THEN
			IF (NEW.id, NEW.project_id, NEW.asked_at, NEW.scenario_name, NEW.problem, NEW.op_indexes, NEW.ops, NEW.rules, NEW.assessor_text, NEW.answer, NEW.answered_at)
				IS DISTINCT FROM (OLD.id, OLD.project_id, OLD.asked_at, OLD.scenario_name, OLD.problem, OLD.op_indexes, OLD.ops, OLD.rules, OLD.assessor_text, OLD.answer, OLD.answered_at) THEN
				RAISE EXCEPTION 'only the answer of a question changes' USING ERRCODE = 'check_violation';
			END IF;
			RETURN NEW;
		END IF;
		IF OLD.answer IS NOT NULL THEN
			RAISE EXCEPTION 'a question is answered once' USING ERRCODE = 'check_violation';
		END IF;
		IF (NEW.id, NEW.project_id, NEW.scenario_id, NEW.asked_at, NEW.scenario_name, NEW.problem, NEW.op_indexes, NEW.ops, NEW.rules, NEW.assessor_text)
			IS DISTINCT FROM (OLD.id, OLD.project_id, OLD.scenario_id, OLD.asked_at, OLD.scenario_name, OLD.problem, OLD.op_indexes, OLD.ops, OLD.rules, OLD.assessor_text) THEN
			RAISE EXCEPTION 'only the answer of a question changes' USING ERRCODE = 'check_violation';
		END IF;
		NEW.answered_at := CASE WHEN NEW.answer IS NULL THEN NULL ELSE now() END;
		RETURN NEW;
	END
	$$;

COMMENT ON TABLE application_question IS
	'"Ask the assessors why" (164_applicant_visibility, build item 6): an applicant''s question about a check line a hidden rule broke. Editors read and answer once; the parties read through app_application_questions (never assessor_text or ops). Kept when its draft is deleted, scenario_id then NULL (234, for the authority''s s42 written reasons); goes with the project.';
COMMENT ON COLUMN application_question.scenario_id IS
	'The application asked about; NULL once its draft was deleted (234): the question and its answer stay with the assessors.';
