-- 149_last_owner_lock — two owners of a project (two admins of a team)
-- giving it up at the same moment can no longer leave it with none
-- (docs/security.md § Authorization, "The last owner"; docs/data-model.md §
-- Roles). Forward from 001 (project_member_keep_owner) and 002
-- (team_member_keep_admin); neither has been redefined since.
--
-- The deferred keep-owner and keep-admin triggers counted the remaining
-- owners (admins) without a lock. Two transactions removing one co-owner
-- each, whose checks both ran before either committed, each still saw the
-- other's row (that delete wasn't committed yet), both passed and both
-- committed: no owner. The window is narrow at COMMIT, and wide open on a
-- path that runs SET CONSTRAINTS ALL IMMEDIATE.
--
-- Now each check first takes a per-project (per-team) advisory lock, held
-- to the end of its transaction, the pattern of 010, 015 and 075. A second
-- check on the same project waits there until the first transaction ends,
-- then counts with a fresh snapshot (READ COMMITTED: each statement of a
-- VOLATILE function takes one; a transaction is visible before its locks are
-- released), sees the first's change, and refuses. An advisory lock rather
-- than a lock on the project row, so the checks serialise only with each
-- other: a row lock would also wait on (and could deadlock with) an owner
-- deleting the project, whose cascade waits on the leaver's member row while
-- holding the project row. A project (team) already gone (deleted, or
-- deleted by the transaction we waited for) needs no owner, as before.
--
-- This is the backstop for every path, the operator deleting app_user rows
-- among them. The member routes also lock the owner (admin) rows before
-- their friendly 409 check (projects/routes.ts assertNotLastOwner,
-- teams/routes.ts assertNotLastAdmin), so a race through the API gets that
-- 409 rather than this trigger's generic refusal at commit.
--
-- Caveat: the re-read needs READ COMMITTED. A REPEATABLE READ transaction
-- keeps its first snapshot after the wait and would not see the other's
-- change; nothing removes members at that level (withUser's readOnly
-- transactions only read).
--
-- Same names, arguments, SECURITY DEFINER and search_path, so the triggers
-- (and the grants: none to water_app or PUBLIC, 028) are untouched.

CREATE OR REPLACE FUNCTION project_member_keep_owner() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		pid uuid := OLD.project_id;
	BEGIN
		-- Waits for any other transaction checking this project's owners.
		PERFORM pg_advisory_xact_lock(hashtextextended('project_owner:' || pid::text, 0));
		-- Cascading delete of the whole project is fine.
		IF NOT EXISTS (SELECT 1 FROM project WHERE id = pid) THEN
			RETURN NULL;
		END IF;
		IF NOT EXISTS (SELECT 1 FROM project_member WHERE project_id = pid AND role = 'owner') THEN
			RAISE EXCEPTION 'a project must keep at least one owner' USING ERRCODE = 'check_violation';
		END IF;
		RETURN NULL;
	END
	$$;

CREATE OR REPLACE FUNCTION team_member_keep_admin() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		PERFORM pg_advisory_xact_lock(hashtextextended('team_admin:' || OLD.team_id::text, 0));
		IF NOT EXISTS (SELECT 1 FROM team WHERE id = OLD.team_id) THEN
			RETURN NULL;
		END IF;
		IF NOT EXISTS (SELECT 1 FROM team_member WHERE team_id = OLD.team_id AND role = 'admin') THEN
			RAISE EXCEPTION 'a team must keep at least one admin' USING ERRCODE = 'check_violation';
		END IF;
		RETURN NULL;
	END
	$$;

COMMENT ON FUNCTION project_member_keep_owner() IS
	'Deferred: a project keeps at least one owner. Takes a per-project advisory lock first, so two concurrent removals serialise and the second re-reads (149).';
COMMENT ON FUNCTION team_member_keep_admin() IS
	'Deferred: a team keeps at least one admin. Takes a per-team advisory lock first, so two concurrent removals serialise and the second re-reads (149).';
