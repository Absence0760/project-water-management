-- 303_contract_licence_words_acts_for — two contract steps whose expand
-- halves have been in production since backend@0.4.0 and web@0.3.0
-- (2026-10-13; production runs backend@0.13.1 and web@0.10.0 as this lands):
--
--  1. 233_licence_record_outcome_words (issue #523 G9 (b)): app_set_licence_outcome
--     no longer takes 161's granted, refused and withdrawn. Every backend since
--     233 sends the authority's words (D14) or NULL, and the column's CHECK
--     (233) already refuses the old ones, so a stray old word now fails the
--     CHECK (23514) instead of being mapped. Older licence.outcome audit
--     events keep the words they were written with; the timeline reads them.
--  2. 229_authority_delegates (issue #523 G5): project_member.acts_for_authority
--     and 163's project_member_authority trigger and function go. Nothing has
--     read the flag since 229 (app_acts_for_authority reads authority_delegate),
--     water_app lost its UPDATE grant on it in 229, and 229's grandfathered
--     delegates live in authority_delegate (the read-only check
--     authority-grandfathered found none in production on 2026-10-13, so
--     deployment.md runbook step 18 had nothing to review). Dropping the column
--     drops its column grants with it; water_app's UPDATE grant on
--     project_member stays role, party, specialist.
--
-- Changes (each from its latest definition):
--   app_set_licence_outcome  from 233: no mapping of 161's words.
--   project_member_authority (163, trigger and function): dropped.
--   project_member.acts_for_authority (163; comment from 229): dropped.

-- From 233, without the mapping of 161's words.
CREATE OR REPLACE FUNCTION app_set_licence_outcome(p_project uuid, p_outcome text, p_on date, p_expires date, p_reason text)
	RETURNS void
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NOT app_has_role(p_project, 'owner') THEN
			RAISE EXCEPTION 'only an owner records the licence outcome' USING ERRCODE = 'insufficient_privilege';
		END IF;
		UPDATE project SET
			licence_outcome = p_outcome,
			licence_outcome_on = CASE WHEN p_outcome IS NULL THEN NULL ELSE p_on END,
			licence_expires_on = CASE WHEN p_outcome = 'licence_issued' THEN p_expires END,
			licence_outcome_reason = coalesce(p_reason, ''),
			-- A changed outcome or date earns a new closing notice.
			record_close_notified_at = NULL,
			record_reminders_sent = 0,
			record_reminded_at = NULL
		WHERE id = p_project;
	END
	$$;
-- CREATE OR REPLACE keeps 161's grants (EXECUTE to water_app only); restated so this file stands alone.
REVOKE ALL ON FUNCTION app_set_licence_outcome(uuid, text, date, date, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_set_licence_outcome(uuid, text, date, date, text) TO water_app;

-- 163's flag and the trigger that guarded it.
DROP TRIGGER project_member_authority ON project_member;
DROP FUNCTION project_member_authority();
ALTER TABLE project_member DROP COLUMN acts_for_authority;
