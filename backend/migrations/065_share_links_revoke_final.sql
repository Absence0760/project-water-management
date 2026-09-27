-- 065_share_links_revoke_final — a revoked share link stays revoked
-- (docs/security.md § Share links).
--
-- 025 lets water_app update share_link's revoked_at and revoked_by (owners
-- only, by RLS) so that DELETE /projects/:id/share-links/:linkId can withdraw
-- a link. Nothing stopped the same grant from undoing it: an owner's
-- transaction could set both back to NULL and the link, whose token is still
-- in whoever-was-sent-it's hands, answered again, with the record of who
-- withdrew it gone. The API never does that, but "revoked" is the one promise
-- a link's owner relies on, so the schema keeps it: once revoked_at is set,
-- neither it nor revoked_by changes, except that revoked_by is cleared when
-- that account is deleted (the ON DELETE SET NULL on the foreign key, which
-- runs as an UPDATE and so passes through here).
-- Guarded by share/share.security.db.test.ts.

CREATE FUNCTION share_link_revoke_final() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF OLD.revoked_at IS NOT NULL AND (
			NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
			OR (NEW.revoked_by IS NOT NULL AND NEW.revoked_by IS DISTINCT FROM OLD.revoked_by)
		) THEN
			RAISE EXCEPTION 'a share link is revoked once and never restored' USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER share_link_revoke_final BEFORE UPDATE ON share_link
	FOR EACH ROW EXECUTE FUNCTION share_link_revoke_final();
