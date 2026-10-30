-- 288_signoff_pack_lock — a pack's sign-off waits for an issue in flight
-- (docs/evidence-pack.md § Signing, docs/data-model.md § Evidence packs).
--
-- signoff_pack_draft (112) let a sign-off in only while its pack is a draft,
-- but read the pack without a lock. The issue route locks the pack row and
-- sets it issued; the editor's sign-off route locks the row first, so the
-- two queue, but the applicant's appointed specialist (167_signers) reads no
-- pack row and takes no lock. A specialist's sign-off sent while an editor's
-- issue was in flight saw the draft as committed, went in without waiting,
-- and committed after the issue: an issued pack gained a signer after issue,
-- whom issue never checked and whose registration check was never bound,
-- and verify listed them. (The foreign key's KEY SHARE lock doesn't conflict
-- with the status update.)
--
-- The trigger now reads the pack row FOR SHARE, which conflicts with the
-- issue's update: a sign-off sent during an issue waits for it, and once it
-- commits finds the pack issued and is refused; an issue sent during a
-- sign-off waits for the sign-off, then sees it. Same name, SECURITY DEFINER
-- and search_path; CREATE OR REPLACE keeps 112's REVOKE and the trigger.
--
-- No table, policy or grant changes; no personal data.

-- Latest definition: 112_evidence_pack.sql. Only the lock is new.
CREATE OR REPLACE FUNCTION signoff_pack_draft() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NEW.pack_id IS NOT NULL THEN
			-- FOR SHARE: wait for an issue (or a withdrawal, or a delete) in flight, and read the row it left.
			PERFORM 1 FROM evidence_pack WHERE id = NEW.pack_id AND status = 'draft' FOR SHARE;
			IF NOT FOUND THEN
				RAISE EXCEPTION 'evidence pack % is not a draft, so it can''t be signed', NEW.pack_id USING ERRCODE = 'check_violation';
			END IF;
		END IF;
		RETURN NEW;
	END
	$$;
COMMENT ON FUNCTION signoff_pack_draft() IS
	'A pack is signed while it is a draft (112), its row read FOR SHARE so a sign-off waits for an issue, withdrawal or delete in flight and is refused once the pack is no longer a draft (288).';
