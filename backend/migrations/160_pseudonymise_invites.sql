-- 160_pseudonymise_invites — account deletion also blanks the person's
-- partly hidden email address in invitation entries (decision D12, provisional
-- position, pre-counsel research 2026-10-01; docs/security.md § Personal
-- information (POPIA); docs/followups.md "D12 confirmation").
--
-- invite.sent, invite.revoked and invite.declined keep the invitee's address
-- masked as history/record.ts maskEmail does it (`j•••@example.com`, the
-- first character and everything from the last `@`). For a personal domain
-- (`j•••@vanrooyenboerdery.co.za`) that still points at the person after
-- their account is deleted, while every other entry about them reads
-- "Deleted user". The events themselves stay: the history is the project's
-- record of who changed what, kept under POPIA s14(1)(b), which is all the
-- s24(1)(b) deletion right reaches; the pseudonymised entries are still
-- treated as personal information (owners and editors read the history, and
-- it goes with the project).
--
-- In this file:
--  1. app_mask_email(text): maskEmail in SQL, so the trigger and the app mask
--     an address the same way (history/mask-email.db.test.ts pairs them).
--  2. app_user_pseudonymise, from its latest definition (138): also sets
--     subject.email to '•••' on every invite.* event whose masked address is
--     the deleted account's, compared ignoring case (the account's email is
--     citext and an invite keeps the address as typed). The match is by the
--     masked text, since the events carry no user id: another person whose
--     masked address collides (same first letter, same domain) loses theirs
--     too. That loses a little information and discloses nothing. An address
--     the account had before an email change isn't matched.

-- 1. maskEmail (history/record.ts) in SQL.
CREATE FUNCTION app_mask_email(p_email text) RETURNS text
	LANGUAGE sql IMMUTABLE SET search_path = public
	AS $$
		SELECT CASE
			WHEN substring(p_email FROM '@[^@]*$') IS NULL OR substring(p_email FROM '@[^@]*$') = p_email THEN '•••'
			ELSE left(p_email, 1) || '•••' || substring(p_email FROM '@[^@]*$')
		END
	$$;
COMMENT ON FUNCTION app_mask_email(text) IS
	'history/record.ts maskEmail in SQL (160): the first character, •••, and everything from the last @; ••• when there is no @ past the first character.';

-- 2. app_user_pseudonymise, from 138: also the masked address in invitation entries.
CREATE OR REPLACE FUNCTION app_user_pseudonymise() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_masked text := app_mask_email(OLD.email::text);
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
		-- 160: the masked address in invite.sent / invite.revoked / invite.declined.
		IF v_masked <> '•••' THEN
			UPDATE audit_event SET subject = jsonb_set(subject, '{email}', to_jsonb('•••'::text))
				WHERE kind LIKE 'invite.%' AND lower(subject->>'email') = lower(v_masked);
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
