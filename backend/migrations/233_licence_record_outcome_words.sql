-- 233_licence_record_outcome_words — the project's licence record says the
-- outcome in the authority's words (issue #523 G9 (b); D14 in
-- docs/roadmap/step-3-licensing.md § 11, provisional position, pre-counsel
-- research, 2026-10-01; docs/data-model.md § Licence record).
--
-- 161 recorded project.licence_outcome as granted, refused or withdrawn,
-- before 163 gave an application's decision the Act's and GN R267's words.
-- The record now uses those words, plus the one outcome the authority does
-- not decide:
--
--   licence_issued        (was granted)   s27, s28(1)(d): kept until the
--                                          licence's expiry + 3 years
--   licence_refused       (was refused)   s42
--   application_rejected  (new)           formal requirements, R267 regs
--                                          9(1)(b), 11(2), 12(2)(b)
--   not_considered        (new)           use already authorised, s40(4)
--   application_withdrawn (was withdrawn) the applicant withdrew it; no
--                                          decision, but the record's clock
--                                          starts on the withdrawal's date
--
-- Every outcome but licence_issued closes the record 3 years after its date,
-- as refused and withdrawn did (Prescription Act s11(d), s12(3); PAJA and
-- Water Tribunal appeals).
--
-- Expand, then contract: app_set_licence_outcome still accepts 161's three
-- words and stores the new ones, so a backend released before this migration
-- keeps working until the next one ships (the contract step, dropping them,
-- is in docs/followups.md). Older licence.outcome audit events keep the words
-- they were written with; the timeline reads both.

ALTER TABLE project DROP CONSTRAINT project_licence_outcome_check, DROP CONSTRAINT project_licence_expiry;

-- Runs as the schema owner, so licence_record_guard lets it through.
UPDATE project SET licence_outcome = CASE licence_outcome
		WHEN 'granted' THEN 'licence_issued'
		WHEN 'refused' THEN 'licence_refused'
		WHEN 'withdrawn' THEN 'application_withdrawn'
	END
	WHERE licence_outcome IS NOT NULL;

-- The generated closing date, keyed on the new word (PG 17 recomputes every row).
ALTER TABLE project ALTER COLUMN record_closes_on SET EXPRESSION AS (
	(CASE WHEN licence_outcome = 'licence_issued' THEN licence_expires_on ELSE licence_outcome_on END + interval '3 years')::date
);

ALTER TABLE project
	ADD CONSTRAINT project_licence_outcome_check CHECK (
		licence_outcome IN ('licence_issued', 'licence_refused', 'application_rejected', 'not_considered', 'application_withdrawn')
	),
	ADD CONSTRAINT project_licence_expiry CHECK (
		CASE WHEN licence_outcome = 'licence_issued' THEN licence_expires_on IS NOT NULL AND licence_expires_on >= licence_outcome_on
			ELSE licence_expires_on IS NULL END
	);

COMMENT ON COLUMN project.licence_outcome IS
	'The licence decision this project''s evidence supports (161, words from 233): licence_issued, licence_refused, application_rejected, not_considered or application_withdrawn; NULL = not recorded. Owners set it (app_set_licence_outcome).';
COMMENT ON COLUMN project.record_closes_on IS
	'When the licence record may be deleted (161, 233): the licence''s expiry (licence_issued) or the outcome''s date, + 3 years. Never deleted automatically: the tick tells the owners and the operator.';

-- From 161: the new words, and 161's three mapped to them (expand/contract, above).
CREATE OR REPLACE FUNCTION app_set_licence_outcome(p_project uuid, p_outcome text, p_on date, p_expires date, p_reason text)
	RETURNS void
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_outcome text := CASE p_outcome
			WHEN 'granted' THEN 'licence_issued'
			WHEN 'refused' THEN 'licence_refused'
			WHEN 'withdrawn' THEN 'application_withdrawn'
			ELSE p_outcome
		END;
	BEGIN
		IF NOT app_has_role(p_project, 'owner') THEN
			RAISE EXCEPTION 'only an owner records the licence outcome' USING ERRCODE = 'insufficient_privilege';
		END IF;
		UPDATE project SET
			licence_outcome = v_outcome,
			licence_outcome_on = CASE WHEN v_outcome IS NULL THEN NULL ELSE p_on END,
			licence_expires_on = CASE WHEN v_outcome = 'licence_issued' THEN p_expires END,
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
