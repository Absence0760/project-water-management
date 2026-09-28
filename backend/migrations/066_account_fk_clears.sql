-- 066_account_fk_clears — deleting an account (the operator,
-- on a POPIA request: docs/security.md § Personal information, deployment.md
-- § Runbooks item 7) does what catalogue.db.test.ts APP_USER_ON_DELETE says,
-- found by auth/personal-data.security.db.test.ts, which deletes an account
-- that has touched every table with a key to app_user and then scans every
-- column of the schema for what's left of the person.
--
--   1. scenario_sweep_complete (062) and seasonal_outlook_complete (063),
--      from their only definitions: created_by is ON DELETE SET NULL, and
--      the foreign key's update went through the guard, which refuses any
--      update not by whoever asked (and any update at all once complete). So
--      an account that had ever asked for a sweep or an outlook couldn't be
--      deleted at all. An update that only clears created_by passes
--      untouched, as note_guard does for its keys (048). water_app can't
--      write created_by (its grants are the outcome columns only), so only
--      the foreign key (or the schema owner) makes that update.
--
--   2. alert_rule_check (from its latest definition, 057): on every update
--      it put the old creator back, so the foreign key's SET NULL was undone
--      and the rule kept pointing at a deleted account (a dangling
--      reference: Postgres doesn't re-check a key a BEFORE trigger
--      restored), the same bug 048 fixed in model_run_stamp_notes. It now
--      lets created_by go to NULL when that account no longer exists; water_app
--      holds UPDATE on the column, so the "no longer exists" check is what
--      keeps an editor from clearing a live creator.
--
--   3. app_user_pseudonymise (from its only definition, 048) also drops the
--      person's id from report.email_to, the members a PDF is mailed to (a
--      uuid[] with no foreign key: a report someone else asked for kept the
--      deleted person's id until the row is purged, 8 days).

CREATE OR REPLACE FUNCTION scenario_sweep_complete() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		-- An account going: its foreign key clears who asked, nothing else.
		IF NEW.created_by IS NULL AND OLD.created_by IS NOT NULL
			AND to_jsonb(NEW) - 'created_by' = to_jsonb(OLD) - 'created_by' THEN
			RETURN NEW;
		END IF;
		IF OLD.status <> 'pending' THEN
			RAISE EXCEPTION 'a sweep is completed once and never changed' USING ERRCODE = 'check_violation';
		END IF;
		IF app_current_user_id() IS DISTINCT FROM OLD.created_by THEN
			RAISE EXCEPTION 'only whoever asked for a sweep can complete it' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF NEW.status <> 'complete' THEN
			RAISE EXCEPTION 'a pending sweep can only be completed' USING ERRCODE = 'check_violation';
		END IF;
		IF EXISTS (SELECT 1 FROM scenario_sweep_member m WHERE m.sweep_id = OLD.id AND m.status = 'pending') THEN
			RAISE EXCEPTION 'every member of a sweep needs an outcome before it is complete' USING ERRCODE = 'check_violation';
		END IF;
		NEW.completed_at := clock_timestamp();
		RETURN NEW;
	END
	$$;

CREATE OR REPLACE FUNCTION seasonal_outlook_complete() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		-- An account going: its foreign key clears who asked, nothing else.
		IF NEW.created_by IS NULL AND OLD.created_by IS NOT NULL
			AND to_jsonb(NEW) - 'created_by' = to_jsonb(OLD) - 'created_by' THEN
			RETURN NEW;
		END IF;
		IF OLD.status <> 'pending' THEN
			RAISE EXCEPTION 'an outlook is completed once and never changed' USING ERRCODE = 'check_violation';
		END IF;
		IF app_current_user_id() IS DISTINCT FROM OLD.created_by THEN
			RAISE EXCEPTION 'only whoever asked for an outlook can complete it' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF NEW.status <> 'complete' THEN
			RAISE EXCEPTION 'a pending outlook can only be completed' USING ERRCODE = 'check_violation';
		END IF;
		NEW.completed_at := clock_timestamp();
		RETURN NEW;
	END
	$$;

CREATE OR REPLACE FUNCTION alert_rule_check() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NEW.node_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM node WHERE id = NEW.node_id AND kind = 'farm') THEN
			RAISE EXCEPTION 'node % is not a farm', NEW.node_id USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.feed_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM data_feed WHERE id = NEW.feed_id AND project_id = NEW.project_id) THEN
			RAISE EXCEPTION 'feed % belongs to a different project', NEW.feed_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		NEW.updated_at := now();
		IF TG_OP = 'INSERT' THEN
			NEW.created_by := app_current_user_id();
			NEW.created_at := now();
		ELSE
			-- The creator stays, except that an account going (created_by's ON
			-- DELETE SET NULL, run after its app_user row is gone) clears who.
			NEW.created_by := CASE
				WHEN NEW.created_by IS NULL AND NOT EXISTS (SELECT 1 FROM app_user WHERE id = OLD.created_by) THEN NULL
				ELSE OLD.created_by
			END;
			NEW.created_at := OLD.created_at;
			-- A feed-less data_stale rule (057's conversion) may be given its feed once.
			IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.node_id IS DISTINCT FROM OLD.node_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
				OR (NEW.feed_id IS DISTINCT FROM OLD.feed_id AND OLD.feed_id IS NOT NULL) THEN
				RAISE EXCEPTION 'a rule''s kind, farm and feed never change' USING ERRCODE = 'check_violation';
			END IF;
		END IF;
		RETURN NEW;
	END
	$$;

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
		RETURN OLD;
	END
	$$;
