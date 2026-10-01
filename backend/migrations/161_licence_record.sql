-- 161_licence_record — "the life of the licence record" becomes dates the app
-- holds, and a team can be marked as keeping public records (provisional
-- positions, pre-counsel research 2026-10-01: evidence that names its maker;
-- docs/security.md § Personal information (POPIA), docs/evidence-pack.md
-- § Retention, docs/data-model.md § Licence record).
--
-- A sign-off keeps the professional's typed name and registration, and an
-- issued pack's manifest prints its makers' names under its hash, after their
-- accounts are deleted: both are kept "for purposes of proof" (POPIA
-- s14(1)(b), s14(6)(b)). Until now the bound on that was a phrase. Here it is
-- a date the project holds:
--
--  1. project.licence_outcome (granted, refused or withdrawn), with the date
--     it was decided (licence_outcome_on), the licence's expiry (required when
--     granted, NWA s28(1)(e)) and the owner's reason. record_closes_on is
--     generated: the expiry (granted) or the decision date (refused,
--     withdrawn) + 3 years (Prescription Act s11(d), s12(3); PAJA and Water
--     Tribunal appeals). record_review_due_on is the 5-yearly review while no
--     outcome is recorded (mirroring NWA s28(1)(f)): set when the project
--     first issues a pack or nominates an evidence run, and rolled forward 5
--     years each time an owner confirms the record is still needed. Nothing is
--     deleted automatically: the tick emails the owners and the operator
--     (licence/record.ts), and the operator deletes on the client's written
--     confirmation (docs/deployment.md § Runbooks).
--  2. These columns change only through app_set_licence_outcome and
--     app_confirm_licence_record (SECURITY DEFINER, owners only) or the
--     tick's app_licence_record_due; licence_record_guard refuses water_app's
--     own UPDATE of them (project_update lets an editor update the row).
--  3. team.public_records: the client is a governmental body whose records
--     are public records under the National Archives and Records Service of
--     South Africa Act 43 of 1996 (s13(2)(a)), set by the operator, as the
--     schema owner, on the client's written confirmation (operator agreement
--     3A.2), and team.records_disposal_confirmed_on, the date the client
--     confirmed it holds its records or has a disposal authority. water_app
--     sets neither (team_public_records_guard). For such a team:
--       - app_user_pseudonymise (from 160) leaves the person's name in the
--         audit log of the team's projects (it still deletes the account);
--       - a project of the team can't be deleted, and the team can't be
--         deleted, until the disposal is confirmed
--         (project_public_records_guard, team_public_records_guard), and a
--         project can't be moved out of the team by the app.
--     Off for every team by default. Build-before trigger: a DWS or CMA team
--     (docs/followups.md).

-- ---------------------------------------------------------------------------
-- 1. The licence record's dates
-- ---------------------------------------------------------------------------
ALTER TABLE project
	ADD COLUMN licence_outcome text CHECK (licence_outcome IN ('granted', 'refused', 'withdrawn')),
	ADD COLUMN licence_outcome_on date,
	ADD COLUMN licence_expires_on date,
	ADD COLUMN licence_outcome_reason text NOT NULL DEFAULT '' CHECK (char_length(licence_outcome_reason) <= 2000),
	ADD COLUMN record_closes_on date GENERATED ALWAYS AS (
		(CASE WHEN licence_outcome = 'granted' THEN licence_expires_on ELSE licence_outcome_on END + interval '3 years')::date
	) STORED,
	ADD COLUMN record_review_due_on date,
	-- The tick's bookkeeping: review reminders sent for the current due date, when the last went, and the closing notice.
	ADD COLUMN record_reminders_sent smallint NOT NULL DEFAULT 0 CHECK (record_reminders_sent BETWEEN 0 AND 3),
	ADD COLUMN record_reminded_at timestamptz,
	ADD COLUMN record_close_notified_at timestamptz,
	ADD CONSTRAINT project_licence_outcome_dated CHECK ((licence_outcome IS NULL) = (licence_outcome_on IS NULL)),
	ADD CONSTRAINT project_licence_expiry CHECK (
		CASE WHEN licence_outcome = 'granted' THEN licence_expires_on IS NOT NULL AND licence_expires_on >= licence_outcome_on
			ELSE licence_expires_on IS NULL END
	);
COMMENT ON COLUMN project.licence_outcome IS
	'The licence decision this project''s evidence supports (161): granted, refused or withdrawn; NULL = not recorded. Owners set it (app_set_licence_outcome).';
COMMENT ON COLUMN project.record_closes_on IS
	'When the licence record may be deleted (161): the licence''s expiry (granted) or the decision date, + 3 years. Never deleted automatically: the tick tells the owners and the operator.';
COMMENT ON COLUMN project.record_review_due_on IS
	'While no outcome is recorded, when the owners must confirm the record is still needed (161): first pack issue or nomination + 5 years, rolled forward 5 years by each confirmation.';

-- The tick's lookups: due reviews, and records whose closing date passed without a notice.
CREATE INDEX project_record_review_idx ON project (record_review_due_on) WHERE licence_outcome IS NULL AND record_review_due_on IS NOT NULL;
CREATE INDEX project_record_closes_idx ON project (record_closes_on) WHERE record_close_notified_at IS NULL AND record_closes_on IS NOT NULL;

-- Backfill: a project that already issued a pack or nominated a run.
UPDATE project p SET record_review_due_on = (f.first_at + interval '5 years')::date
	FROM (
		SELECT project_id, min(at) AS first_at FROM (
			SELECT project_id, issued_at AS at FROM evidence_pack WHERE issued_at IS NOT NULL
			UNION ALL
			SELECT project_id, nominated_at FROM run_nomination
		) x GROUP BY project_id
	) f
	WHERE f.project_id = p.id;

-- 2. Only the definer functions below write them.
CREATE FUNCTION licence_record_guard() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF current_user = 'water_app' AND (
			NEW.licence_outcome IS DISTINCT FROM OLD.licence_outcome
			OR NEW.licence_outcome_on IS DISTINCT FROM OLD.licence_outcome_on
			OR NEW.licence_expires_on IS DISTINCT FROM OLD.licence_expires_on
			OR NEW.licence_outcome_reason IS DISTINCT FROM OLD.licence_outcome_reason
			OR NEW.record_review_due_on IS DISTINCT FROM OLD.record_review_due_on
			OR NEW.record_reminders_sent IS DISTINCT FROM OLD.record_reminders_sent
			OR NEW.record_reminded_at IS DISTINCT FROM OLD.record_reminded_at
			OR NEW.record_close_notified_at IS DISTINCT FROM OLD.record_close_notified_at
		) THEN
			RAISE EXCEPTION 'the licence record changes only through app_set_licence_outcome or app_confirm_licence_record'
				USING ERRCODE = 'insufficient_privilege';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER licence_record_guard BEFORE UPDATE ON project
	FOR EACH ROW EXECUTE FUNCTION licence_record_guard();
-- A new project starts with none (a copy doesn't inherit the source's record).
CREATE FUNCTION licence_record_insert_guard() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF current_user = 'water_app' AND (NEW.licence_outcome IS NOT NULL OR NEW.record_review_due_on IS NOT NULL
			OR NEW.licence_outcome_reason <> '' OR NEW.licence_expires_on IS NOT NULL) THEN
			RAISE EXCEPTION 'a new project has no licence record yet' USING ERRCODE = 'insufficient_privilege';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER licence_record_insert_guard BEFORE INSERT ON project
	FOR EACH ROW EXECUTE FUNCTION licence_record_insert_guard();

-- Record (or clear, p_outcome NULL) the licence outcome: owners only. Clearing
-- it leaves the review date as it was. Recording one stops the reviews.
CREATE FUNCTION app_set_licence_outcome(p_project uuid, p_outcome text, p_on date, p_expires date, p_reason text)
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
			licence_expires_on = CASE WHEN p_outcome = 'granted' THEN p_expires END,
			licence_outcome_reason = coalesce(p_reason, ''),
			-- A changed outcome or date earns a new closing notice.
			record_close_notified_at = NULL,
			record_reminders_sent = 0,
			record_reminded_at = NULL
		WHERE id = p_project;
	END
	$$;

-- The record is still needed: the next review is 5 years from today. Owners only, while no outcome is recorded.
CREATE FUNCTION app_confirm_licence_record(p_project uuid) RETURNS date
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_due date;
	BEGIN
		IF NOT app_has_role(p_project, 'owner') THEN
			RAISE EXCEPTION 'only an owner confirms the licence record' USING ERRCODE = 'insufficient_privilege';
		END IF;
		UPDATE project SET record_review_due_on = (current_date + interval '5 years')::date, record_reminders_sent = 0, record_reminded_at = NULL
			WHERE id = p_project AND licence_outcome IS NULL
			RETURNING record_review_due_on INTO v_due;
		IF v_due IS NULL THEN
			RAISE EXCEPTION 'the outcome is recorded, so there is no review to confirm' USING ERRCODE = 'check_violation';
		END IF;
		RETURN v_due;
	END
	$$;

-- The first pack issued or run nominated starts the 5-yearly review, if
-- nothing has. SECURITY DEFINER: it runs inside an editor's issue or
-- nomination and writes the guarded column.
CREATE FUNCTION licence_record_start() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		UPDATE project SET record_review_due_on = (current_date + interval '5 years')::date
			WHERE id = NEW.project_id AND record_review_due_on IS NULL;
		RETURN NULL;
	END
	$$;
CREATE TRIGGER licence_record_start_pack AFTER UPDATE OF status ON evidence_pack
	FOR EACH ROW WHEN (NEW.status = 'issued' AND OLD.status = 'draft') EXECUTE FUNCTION licence_record_start();
CREATE TRIGGER licence_record_start_nomination AFTER INSERT ON run_nomination
	FOR EACH ROW EXECUTE FUNCTION licence_record_start();

-- The tick (licence/record.ts): up to p_limit projects with a notice due,
-- marked as sent in the same statement (at most once: a send that fails is
-- logged, and a review is asked again a month later). 'review': no outcome
-- and the review date passed; three reminders a month apart, then it stops
-- until an owner acts. 'closes': the closing date passed, once per outcome.
-- Returns the owners to tell (members with owner, and the team's admins).
CREATE FUNCTION app_licence_record_due(p_limit integer)
	RETURNS TABLE (project_id uuid, project_name text, event text, due_on date, owner_ids uuid[])
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	BEGIN
		RETURN QUERY
		WITH review AS (
			SELECT p.id FROM project p
			WHERE p.licence_outcome IS NULL AND p.record_review_due_on <= current_date AND p.record_reminders_sent < 3
			  AND (p.record_reminded_at IS NULL OR p.record_reminded_at <= now() - interval '1 month')
			ORDER BY p.record_review_due_on, p.id LIMIT p_limit FOR UPDATE SKIP LOCKED
		), reviewed AS (
			UPDATE project p SET record_reminders_sent = p.record_reminders_sent + 1, record_reminded_at = now()
			FROM review r WHERE p.id = r.id
			RETURNING p.id, p.name, 'review'::text AS event, p.record_review_due_on AS due_on
		), closing AS (
			SELECT p.id FROM project p
			WHERE p.record_closes_on <= current_date AND p.record_close_notified_at IS NULL
			ORDER BY p.record_closes_on, p.id LIMIT p_limit FOR UPDATE SKIP LOCKED
		), closed AS (
			UPDATE project p SET record_close_notified_at = now()
			FROM closing c WHERE p.id = c.id
			RETURNING p.id, p.name, 'closes'::text AS event, p.record_closes_on AS due_on
		)
		SELECT x.id, x.name, x.event, x.due_on,
			ARRAY(
				SELECT m.user_id FROM project_member m WHERE m.project_id = x.id AND m.role = 'owner'
				UNION
				SELECT tm.user_id FROM project pp JOIN team_member tm ON tm.team_id = pp.team_id AND tm.role = 'admin' WHERE pp.id = x.id
			)
		FROM (SELECT * FROM reviewed UNION ALL SELECT * FROM closed) x;
	END
	$$;

REVOKE ALL ON FUNCTION licence_record_guard(), licence_record_insert_guard(), licence_record_start() FROM PUBLIC, water_app;
REVOKE ALL ON FUNCTION app_set_licence_outcome(uuid, text, date, date, text), app_confirm_licence_record(uuid), app_licence_record_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_set_licence_outcome(uuid, text, date, date, text), app_confirm_licence_record(uuid), app_licence_record_due(integer) TO water_app;

-- ---------------------------------------------------------------------------
-- 3. Public records (NARSSA)
-- ---------------------------------------------------------------------------
ALTER TABLE team
	ADD COLUMN public_records boolean NOT NULL DEFAULT false,
	ADD COLUMN records_disposal_confirmed_on date;
COMMENT ON COLUMN team.public_records IS
	'The client is a governmental body whose project records are public records (NARSSA s13(2)(a); 161). Set by the operator as the schema owner on the client''s written confirmation (operator agreement 3A.2): account deletion keeps the person''s name in its projects'' history, and its projects are deleted only after records_disposal_confirmed_on.';
COMMENT ON COLUMN team.records_disposal_confirmed_on IS
	'When the client confirmed in writing that it holds its records or has a disposal authority (161); set by the operator. Until then a public-records team''s projects, and the team, are kept.';

CREATE FUNCTION team_public_records_guard() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF TG_OP = 'DELETE' THEN
			IF OLD.public_records AND OLD.records_disposal_confirmed_on IS NULL THEN
				RAISE EXCEPTION 'team % keeps public records, so it is kept until the client confirms their disposal', OLD.id
					USING ERRCODE = 'restrict_violation';
			END IF;
			RETURN OLD;
		END IF;
		IF current_user = 'water_app' AND (
			(TG_OP = 'INSERT' AND (NEW.public_records OR NEW.records_disposal_confirmed_on IS NOT NULL))
			OR (TG_OP = 'UPDATE' AND (NEW.public_records IS DISTINCT FROM OLD.public_records
				OR NEW.records_disposal_confirmed_on IS DISTINCT FROM OLD.records_disposal_confirmed_on))
		) THEN
			RAISE EXCEPTION 'only the operator marks a team as keeping public records' USING ERRCODE = 'insufficient_privilege';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER team_public_records_guard BEFORE INSERT OR UPDATE OR DELETE ON team
	FOR EACH ROW EXECUTE FUNCTION team_public_records_guard();

-- Is this project held by a team that keeps public records, with no confirmed disposal? Definer: any deleter, whatever it reads.
CREATE FUNCTION app_project_public_records(p_project uuid) RETURNS boolean
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT EXISTS (
			SELECT 1 FROM project p JOIN team t ON t.id = p.team_id
			WHERE p.id = p_project AND t.public_records AND t.records_disposal_confirmed_on IS NULL
		)
	$$;

CREATE FUNCTION project_public_records_guard() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF TG_OP = 'DELETE' THEN
			IF app_project_public_records(OLD.id) THEN
				RAISE EXCEPTION 'project % is a public record of its team, so it is kept until the client confirms its disposal', OLD.id
					USING ERRCODE = 'restrict_violation';
			END IF;
			RETURN OLD;
		END IF;
		-- Moving it out of the team would drop the flag; the operator can, the app can't.
		IF current_user = 'water_app' AND NEW.team_id IS DISTINCT FROM OLD.team_id AND app_project_public_records(OLD.id) THEN
			RAISE EXCEPTION 'project % is a public record of its team, so it stays in the team', OLD.id USING ERRCODE = 'restrict_violation';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER project_public_records_guard BEFORE DELETE OR UPDATE OF team_id ON project
	FOR EACH ROW EXECUTE FUNCTION project_public_records_guard();

REVOKE ALL ON FUNCTION team_public_records_guard(), project_public_records_guard() FROM PUBLIC, water_app;
REVOKE ALL ON FUNCTION app_project_public_records(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_project_public_records(uuid) TO water_app;

-- app_user_pseudonymise, from 160: the audit log of a public-records team's
-- projects keeps the person's name; everything else is as before.
CREATE OR REPLACE FUNCTION app_user_pseudonymise() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_masked text := app_mask_email(OLD.email::text);
	BEGIN
		-- 161: the events of a public-records team's projects are left as they are (each UPDATE below skips them).
		UPDATE audit_event SET actor_label = 'Deleted user'
			WHERE actor_user_id = OLD.id AND project_id NOT IN (SELECT p.id FROM project p JOIN team t ON t.id = p.team_id WHERE t.public_records);
		UPDATE audit_event SET subject = jsonb_set(subject, '{displayName}', to_jsonb('Deleted user'::text))
			WHERE subject->>'userId' = OLD.id::text AND subject ? 'displayName'
			  AND project_id NOT IN (SELECT p.id FROM project p JOIN team t ON t.id = p.team_id WHERE t.public_records);
		-- note.deleted names the note's author: by id since 048 (authorId), and
		-- through the note itself for the events written before.
		UPDATE audit_event e SET subject = jsonb_set(e.subject, '{author}', to_jsonb('Deleted user'::text))
			WHERE e.kind = 'note.deleted' AND e.subject ? 'author' AND (
				e.subject->>'authorId' = OLD.id::text
				OR EXISTS (SELECT 1 FROM note n WHERE n.id::text = e.subject->>'noteId' AND n.author_id = OLD.id)
			) AND e.project_id NOT IN (SELECT p.id FROM project p JOIN team t ON t.id = p.team_id WHERE t.public_records);
		-- 160: the masked address in invite.sent / invite.revoked / invite.declined.
		IF v_masked <> '•••' THEN
			UPDATE audit_event SET subject = jsonb_set(subject, '{email}', to_jsonb('•••'::text))
				WHERE kind LIKE 'invite.%' AND lower(subject->>'email') = lower(v_masked)
				  AND project_id NOT IN (SELECT p.id FROM project p JOIN team t ON t.id = p.team_id WHERE t.public_records);
		END IF;
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
