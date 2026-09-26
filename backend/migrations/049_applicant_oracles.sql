-- 049_applicant_oracles — close what an applicant (the contributor role,
-- 044/045, WP-3.3) could learn about people and names they can't see
-- (docs/security.md § Applicants, docs/scenarios.md § Applications,
-- docs/followups.md § Applicants "Oracles").
--
--  * Sharing. 045 let an applicant share their application with any
--    contributor-or-above member *by email*, so the answer to "share with
--    x@y" said whether x@y was a member. Now the project owner curates:
--    project_member.party groups an applying party (the applicant, their
--    consultant, their client), and an applicant shares only with the other
--    members of their own party, picked from a list
--    (app_share_candidates). A member without a party shares with nobody.
--    An owner who has been promoted (viewer and up) reads the member list
--    anyway and shares with any contributor-or-above member, as before.
--    Moving someone out of a party ends the shares it allowed.
--  * Application names. 024's scenario_name_idx made names unique across
--    the whole project, so naming a draft after someone else's hidden
--    application (or a team scenario the applicant can't read) said that
--    one existed. A team scenario's name is now unique among team
--    scenarios, an application's among its owner's own applications.
--
-- The third oracle, renaming one's own farm to a hidden neighbour's name,
-- is closed in the engine (applyScenario's maskedNames, WP-3.3): an
-- application's ops meet every node its applicant can't see under the
-- anonymous name they see, so no hidden name can collide or be quoted.

-- ---------------------------------------------------------------------------
-- The party column.
-- ---------------------------------------------------------------------------
ALTER TABLE project_member
	ADD COLUMN party text CHECK (party IS NULL OR (party = btrim(party) AND length(party) BETWEEN 1 AND 80));
COMMENT ON COLUMN project_member.party IS
	'An applying party (049, WP-3.3): the owner groups an applicant with their consultant or client; an applicant shares applications only within their party. Compared ignoring case.';

-- Whether an application owned by p_owner may be shared with p_member: a
-- contributor-or-above member who isn't the owner and, while the owner is
-- an applicant, is in the owner's party. The one definition of the rule:
-- the insert check, the prune and the candidate list all call it.
CREATE FUNCTION app_share_allowed(p_project uuid, p_owner uuid, p_member uuid) RETURNS boolean
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		o record;
		m record;
	BEGIN
		IF p_owner IS NULL OR p_member IS NULL OR p_owner = p_member THEN
			RETURN false;
		END IF;
		SELECT role, party INTO m FROM project_member WHERE project_id = p_project AND user_id = p_member;
		IF NOT FOUND OR m.role < 'contributor'::project_role THEN
			RETURN false;
		END IF;
		SELECT role, party INTO o FROM project_member WHERE project_id = p_project AND user_id = p_owner;
		IF NOT FOUND OR o.role < 'contributor'::project_role THEN
			RETURN false;
		END IF;
		IF o.role >= 'viewer'::project_role THEN
			RETURN true;
		END IF;
		RETURN o.party IS NOT NULL AND m.party IS NOT NULL AND lower(o.party) = lower(m.party);
	END
	$$;

-- Who the current user may share their applications with: the list an
-- applicant picks from. Names only, never emails; nothing for a non-member.
CREATE FUNCTION app_share_candidates(p_project uuid) RETURNS TABLE (candidate_id uuid, candidate_name text)
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT m.user_id, u.display_name
		FROM project_member m JOIN app_user u ON u.id = m.user_id
		WHERE m.project_id = p_project AND app_share_allowed(p_project, app_current_user_id(), m.user_id)
		ORDER BY u.display_name, m.user_id
	$$;

REVOKE ALL ON FUNCTION app_share_allowed(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_share_candidates(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_share_allowed(uuid, uuid, uuid) TO water_app;
GRANT EXECUTE ON FUNCTION app_share_candidates(uuid) TO water_app;

-- ---------------------------------------------------------------------------
-- scenario_member_check, from its latest definition (045_contributor_scope):
-- the member must be one app_share_allowed allows (which includes 045's
-- "a contributor or above").
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION scenario_member_check() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		s record;
	BEGIN
		SELECT project_id, origin, owner_user_id INTO s FROM scenario WHERE id = NEW.scenario_id;
		IF s.project_id IS DISTINCT FROM NEW.project_id THEN
			RAISE EXCEPTION 'scenario % belongs to a different project', NEW.scenario_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		IF s.origin <> 'applicant' THEN
			RAISE EXCEPTION 'only an application is shared this way; a team scenario is read by every viewer' USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.user_id = s.owner_user_id THEN
			RAISE EXCEPTION 'the owner already reads their application' USING ERRCODE = 'check_violation';
		END IF;
		IF NOT app_share_allowed(NEW.project_id, s.owner_user_id, NEW.user_id) THEN
			RAISE EXCEPTION 'user % is not someone this application can be shared with', NEW.user_id USING ERRCODE = 'check_violation';
		END IF;
		IF TG_OP = 'INSERT' THEN
			NEW.added_by := app_current_user_id();
			NEW.added_at := now();
		END IF;
		RETURN NEW;
	END
	$$;

-- A member's party or role changed: every share of an application that the
-- rule no longer allows goes (the owner's curation is the authority, not a
-- share made under an earlier grouping). Past RLS: the owner making the
-- change isn't the application's owner.
CREATE FUNCTION project_member_prune_shares() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		DELETE FROM scenario_member sm
		USING scenario s
		WHERE s.id = sm.scenario_id AND sm.project_id = NEW.project_id
			AND (sm.user_id = NEW.user_id OR s.owner_user_id = NEW.user_id)
			AND NOT app_share_allowed(sm.project_id, s.owner_user_id, sm.user_id);
		RETURN NULL;
	END
	$$;
CREATE TRIGGER project_member_prune_shares AFTER UPDATE OF party, role ON project_member
	FOR EACH ROW WHEN (OLD.party IS DISTINCT FROM NEW.party OR OLD.role IS DISTINCT FROM NEW.role)
	EXECUTE FUNCTION project_member_prune_shares();

-- ---------------------------------------------------------------------------
-- Scenario names, replacing 024's scenario_name_idx.
-- ---------------------------------------------------------------------------
DROP INDEX scenario_name_idx;
CREATE UNIQUE INDEX scenario_team_name_idx ON scenario (project_id, lower(btrim(name))) WHERE origin = 'team';
CREATE UNIQUE INDEX scenario_application_name_idx ON scenario (project_id, owner_user_id, lower(btrim(name))) WHERE origin = 'applicant';
-- scenario_name_idx also covered the project foreign key (a project's delete
-- cascades through it); a partial index can't serve that scan, so a plain one.
CREATE INDEX scenario_project_idx ON scenario (project_id);
