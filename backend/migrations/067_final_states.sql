-- 067_final_states — a one-way event stays done (docs/security.md § API keys).
--
-- water_app may UPDATE a few columns that record a one-way event, so the API
-- can make that event happen. Nothing stopped the same grant from undoing
-- it, which 065 fixed for share_link. db/final-columns.security.db.test.ts
-- sweeps information_schema.column_privileges for every such column and
-- found three more:
--
--   1. api_key.revoked_at / revoked_by (039): an owner's transaction could
--      set both back to NULL, and a revoked key, still in the logger it was
--      pasted into, pushed data again with the record of who revoked it
--      gone. Now, as share_link: once revoked_at is set neither changes,
--      except that revoked_by goes to NULL when that account is deleted.
--
--   2. run_publication (022): an editor's transaction could rewrite a
--      superseded publication's notice, note or restriction (the history
--      farmers and share-link viewers read) or, having superseded the
--      current one, bring an old one back as current. A superseded
--      publication is now frozen, except that its published_by / updated_by
--      go to NULL when that account is deleted.
--
--   3. app_user.sessions_revoked_at (004): the sign-out-everywhere and
--      password watermark. Moving it back (or to NULL) revived every session
--      it had ended, a stolen cookie included. It now only moves forward: an
--      update to an earlier time keeps the later one (no error: two servers'
--      clocks may disagree by a few milliseconds, and the later sign-out is
--      the one that counts).
--
-- "Cleared by the foreign key" is told apart from "cleared by water_app" by
-- the account being gone: the ON DELETE SET NULL runs after the app_user row
-- is deleted, so a live account's id can't be cleared (as 066 does for
-- alert_rule.created_by). The same tightening for share_link.revoked_by,
-- whose 065 guard let any update clear it.

CREATE FUNCTION api_key_revoke_final() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF OLD.revoked_at IS NOT NULL AND (
			NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
			OR (NEW.revoked_by IS DISTINCT FROM OLD.revoked_by
				AND (NEW.revoked_by IS NOT NULL OR EXISTS (SELECT 1 FROM app_user u WHERE u.id = OLD.revoked_by)))
		) THEN
			RAISE EXCEPTION 'an API key is revoked once and never restored' USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER api_key_revoke_final BEFORE UPDATE ON api_key
	FOR EACH ROW EXECUTE FUNCTION api_key_revoke_final();

-- From its only definition (065), with revoked_by cleared only for a deleted account.
CREATE OR REPLACE FUNCTION share_link_revoke_final() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF OLD.revoked_at IS NOT NULL AND (
			NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
			OR (NEW.revoked_by IS DISTINCT FROM OLD.revoked_by
				AND (NEW.revoked_by IS NOT NULL OR EXISTS (SELECT 1 FROM app_user u WHERE u.id = OLD.revoked_by)))
		) THEN
			RAISE EXCEPTION 'a share link is revoked once and never restored' USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END
	$$;

CREATE FUNCTION run_publication_final() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF OLD.superseded_at IS NOT NULL AND (
			to_jsonb(NEW) - 'published_by' - 'updated_by' IS DISTINCT FROM to_jsonb(OLD) - 'published_by' - 'updated_by'
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
CREATE TRIGGER run_publication_final BEFORE UPDATE ON run_publication
	FOR EACH ROW EXECUTE FUNCTION run_publication_final();

CREATE FUNCTION app_user_sessions_watermark() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		-- greatest() ignores NULLs: NULL never replaces a watermark.
		NEW.sessions_revoked_at := greatest(OLD.sessions_revoked_at, NEW.sessions_revoked_at);
		RETURN NEW;
	END
	$$;
CREATE TRIGGER app_user_sessions_watermark BEFORE UPDATE OF sessions_revoked_at ON app_user
	FOR EACH ROW EXECUTE FUNCTION app_user_sessions_watermark();
