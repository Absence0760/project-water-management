-- 048_account_deletion — what the database keeps of a person once their
-- account is gone or their invite has lapsed (roadmap WP-2.16; decision D12;
-- docs/security.md § Personal information (POPIA)).
--
-- Expand-only:
--
--   1. app_user_pseudonymise: deleting an app_user row pseudonymises the
--      project audit log instead of deleting it (D12). The foreign key
--      already sets audit_event.actor_user_id to NULL; the name was left in
--      actor_label and in the subject of the events about that person
--      (member.added / member.role / member.removed / farmer.linked /
--      farmer.unlinked carry { userId, displayName }; note.deleted names the
--      note's author). Before the row goes, every event they acted in says
--      "Deleted user", and every event about them names "Deleted user" too. The event itself, its kind, time and
--      project stay: it is the project's audit trail (the regulator's), and
--      the userId left in a subject is a random id that no longer resolves.
--      SECURITY DEFINER, because audit_event is append-only for water_app
--      (030_history.sql) and there is no app path that deletes an account
--      (the operator does it, as the schema owner, on a POPIA request; the
--      trigger fires for every role). Invite addresses in events are already
--      masked (invite.sent / invite.revoked).
--
--   2. note_guard (from its only definition, 037_notes.sql): the account's
--      foreign keys set note.author_id and note.deleted_by to NULL, and that
--      update went through the guard, which refuses any change to a deleted
--      note. So an account that had written, or soft-deleted, a note that
--      is now deleted couldn't be deleted at all. An update that only clears
--      those two references (the foreign keys' SET NULL; water_app can't
--      write author_id, and the update policy hides a deleted note from it)
--      passes untouched; every other update is checked as before.
--
--   3. model_run_stamp_notes (from its only definition, 007_run_notes.sql):
--      on an update that leaves the note alone it put the old stamp back,
--      including notes_updated_by, so the foreign key's SET NULL was undone
--      and the run kept pointing at a deleted account (a dangling reference:
--      Postgres doesn't re-check a key a BEFORE trigger restored). It now
--      keeps the stamp unless the reference was cleared. water_app can't
--      write notes_updated_by (its model_run grant is notes and pinned), so
--      only the foreign key clears it.
--
--   4. app_purge_invites: an invite that lapsed without being accepted holds
--      an address of someone who never signed up, and (for a farmer invite)
--      the farms it would have linked (invite_node, cascade). Owners see an
--      expired invite for a while so they can send it again; after
--      p_age past its expiry it is deleted. Called by the job tick
--      (jobs/runner.ts, invites/invites.ts purgeInvites, 90 days), like
--      app_purge_jobs and app_purge_reports. Returns how many went.

CREATE FUNCTION app_user_pseudonymise() RETURNS trigger
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
		RETURN OLD;
	END
	$$;
CREATE TRIGGER app_user_pseudonymise BEFORE DELETE ON app_user
	FOR EACH ROW EXECUTE FUNCTION app_user_pseudonymise();

-- The events about a person, found without a scan of the whole log.
CREATE INDEX audit_event_subject_user_idx ON audit_event ((subject->>'userId')) WHERE subject ? 'userId';

CREATE OR REPLACE FUNCTION note_guard() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		-- An account going: its foreign keys clear the author and the deleter, nothing else.
		IF (NEW.author_id IS NULL OR NEW.deleted_by IS NULL)
			AND (NEW.author_id IS NOT DISTINCT FROM OLD.author_id OR NEW.author_id IS NULL)
			AND (NEW.deleted_by IS NOT DISTINCT FROM OLD.deleted_by OR NEW.deleted_by IS NULL)
			AND (NEW.author_id, NEW.deleted_by) IS DISTINCT FROM (OLD.author_id, OLD.deleted_by)
			AND (NEW.body, NEW.edited_at, NEW.deleted_at, NEW.node_id, NEW.run_id, NEW.setting_key, NEW.visibility, NEW.project_id, NEW.created_at)
				IS NOT DISTINCT FROM (OLD.body, OLD.edited_at, OLD.deleted_at, OLD.node_id, OLD.run_id, OLD.setting_key, OLD.visibility, OLD.project_id, OLD.created_at)
		THEN
			RETURN NEW;
		END IF;
		IF NEW.body IS DISTINCT FROM OLD.body THEN
			IF OLD.author_id IS DISTINCT FROM app_current_user_id() THEN
				RAISE EXCEPTION 'only the author may edit a note' USING ERRCODE = 'insufficient_privilege';
			END IF;
			NEW.edited_at := now();
		ELSE
			NEW.edited_at := OLD.edited_at;
		END IF;
		IF OLD.deleted_at IS NOT NULL THEN
			RAISE EXCEPTION 'note % is deleted', OLD.id USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.deleted_at IS NOT NULL THEN
			NEW.deleted_at := now();
			NEW.deleted_by := app_current_user_id();
		ELSE
			NEW.deleted_by := NULL;
		END IF;
		RETURN NEW;
	END
	$$;

CREATE OR REPLACE FUNCTION model_run_stamp_notes() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF NEW.notes IS DISTINCT FROM OLD.notes THEN
			NEW.notes_updated_at := now();
			NEW.notes_updated_by := app_current_user_id();
		ELSE
			-- The stamp only ever describes the note: an update that leaves the
			-- note alone keeps it as it was, except that an account going
			-- (notes_updated_by's ON DELETE SET NULL) clears who.
			NEW.notes_updated_at := OLD.notes_updated_at;
			NEW.notes_updated_by := CASE WHEN NEW.notes_updated_by IS NULL THEN NULL ELSE OLD.notes_updated_by END;
		END IF;
		RETURN NEW;
	END
	$$;

CREATE FUNCTION app_purge_invites(p_age interval) RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		n integer;
	BEGIN
		IF p_age IS NULL OR p_age < interval '1 day' THEN
			RAISE EXCEPTION 'purge only invites expired at least a day' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		DELETE FROM invite WHERE expires_at < now() - p_age;
		GET DIAGNOSTICS n = ROW_COUNT;
		RETURN n;
	END
	$$;

CREATE INDEX invite_expires_idx ON invite (expires_at);

REVOKE ALL ON FUNCTION app_user_pseudonymise(), app_purge_invites(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_purge_invites(interval) TO water_app;
