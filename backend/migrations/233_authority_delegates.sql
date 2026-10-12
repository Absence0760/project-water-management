-- 233_authority_delegates — the responsible authority controls who acts for
-- it (issue #523 G5; the licensing assessor's review, D1: "the host controls
-- who acts for us"; docs/security.md § Authorization, docs/data-model.md
-- § Who acts for the responsible authority, docs/evidence-pack.md § The
-- responsible authority).
--
-- Until now the project's owner (the host: a WUA, a consultancy) ticked
-- project_member.acts_for_authority (163), so the host decided who recorded
-- the authority's decisions and endorsed its baseline. Now:
--
--  1. authority_delegate, one row per person per project. A row is
--     *proposed* (confirmed_at NULL) or *confirmed*. Only a confirmed row
--     counts: app_acts_for_authority (163, redefined here) and
--     app_authority_members read nothing else, so a proposal grants nothing.
--  2. Who does what (authority_delegate_guard; RLS says the same):
--       - propose: an owner of the project, or a member already acting for
--         the authority. An authority member's proposal is confirmed at once
--         (they are the authority).
--       - confirm: only a member already acting for the authority, or the
--         operator as the schema owner (authority_confirm_by_operator, on the
--         authority's letter; docs/deployment.md runbook). With no confirmed
--         delegate in a project, only the operator can confirm the first:
--         the host can't bootstrap the authority by itself.
--       - withdraw a proposal: the owner (or the authority, or the proposed
--         person). The owner can't remove a confirmed delegate.
--       - remove a confirmed delegate: a member acting for the authority
--         (any of them, themselves included), or the delegate.
--     The person must hold editor or above in the project, directly or
--     through its team (app_member_role, 163), when proposed and when
--     confirmed: a team editor can act for the authority, which the
--     project_member flag couldn't express.
--  3. A delegate who loses editor (removed, demoted, left the team, the
--     project moved team) lapses: the row goes (authority_delegate_prune), so
--     coming back needs the authority again.
--  4. Every change is in the project's History (authority_delegate_audit, in
--     the database, so the operator's SQL is logged too): authority.proposed,
--     authority.confirmed, authority.withdrawn, authority.declined (the
--     authority refused a proposal), authority.removed, authority.lapsed and
--     authority.grandfathered.
--  5. Grandfathering. Every flag an owner set before 233, on a member who
--     still holds editor or above, is carried over as confirmed
--     (confirmed_via 'grandfathered'), so no decision or endorsement in
--     progress stops; each gets an authority.grandfathered event on the
--     project, its actor the owner who last ticked the flag (from the
--     member.authority event), so the History says who set it. A flag on
--     someone below editor granted nothing and isn't carried over. The
--     authority can remove any of them.
--  6. Expand/contract: project_member.acts_for_authority stays, read by
--     nothing new; water_app may no longer set it (the old API's PATCH
--     during a deploy gets a 500 for that field alone). A later migration
--     drops it.
--
-- Changes (each from its latest definition):
--   app_acts_for_authority  from 163: reads authority_delegate (confirmed)
--                           and app_member_role, not project_member's flag.

CREATE TABLE authority_delegate (
	project_id        uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	user_id           uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
	-- Who proposed it: an owner or an authority member; NULL for the operator, or once that account is gone.
	proposed_by       uuid REFERENCES app_user(id) ON DELETE SET NULL,
	proposed_at       timestamptz NOT NULL DEFAULT now(),
	-- NULL while proposed.
	confirmed_at      timestamptz,
	-- The authority member who confirmed it; NULL for the operator and the grandfathered, or once that account is gone.
	confirmed_by      uuid REFERENCES app_user(id) ON DELETE SET NULL,
	confirmed_via     text CHECK (confirmed_via IN ('member', 'operator', 'grandfathered')),
	-- The operator's reference (the authority's letter); '' otherwise.
	confirmation_note text NOT NULL DEFAULT '' CHECK (char_length(confirmation_note) <= 200),
	PRIMARY KEY (project_id, user_id),
	CONSTRAINT authority_delegate_confirmed CHECK ((confirmed_at IS NULL) = (confirmed_via IS NULL) AND (confirmed_at IS NOT NULL OR confirmed_by IS NULL))
);
CREATE INDEX authority_delegate_user_idx ON authority_delegate (user_id);
CREATE INDEX authority_delegate_proposed_by_idx ON authority_delegate (proposed_by);
CREATE INDEX authority_delegate_confirmed_by_idx ON authority_delegate (confirmed_by);
COMMENT ON TABLE authority_delegate IS
	'Who acts for the project''s responsible authority (233, issue #523 G5): proposed by an owner or an authority member, confirmed only by a member already acting for it or by the operator (authority_confirm_by_operator). Only a confirmed row held by an editor or above counts (app_acts_for_authority, app_authority_members).';
COMMENT ON COLUMN project_member.acts_for_authority IS
	'Superseded by authority_delegate (233): read by nothing, set by nobody; its pre-233 values were carried over as confirmed delegates (grandfathered). Dropped by a later migration.';

ALTER TABLE authority_delegate ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Who counts.
-- ---------------------------------------------------------------------------

-- Whether p_user acts for p_project's authority: a confirmed delegate holding
-- editor or above there. Internal (the default privileges grant water_app
-- EXECUTE, 028; it answers only what app_authority_members lists anyway).
CREATE FUNCTION app_authority_member(p_project uuid, p_user uuid) RETURNS boolean
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		RETURN p_user IS NOT NULL
			AND EXISTS (SELECT 1 FROM authority_delegate d WHERE d.project_id = p_project AND d.user_id = p_user AND d.confirmed_at IS NOT NULL)
			AND coalesce(app_member_role(p_project, p_user) >= 'editor'::project_role, false);
	END
	$$;

-- app_acts_for_authority, from 163: the current user is a confirmed delegate
-- holding editor or above. The one test every authority action uses
-- (scenario_guard, run_publication_endorse, app_record_registration_check,
-- and the API's projects/authoritySettings.ts requireActsForAuthority).
CREATE OR REPLACE FUNCTION app_acts_for_authority(p_project uuid) RETURNS boolean
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		RETURN app_authority_member(p_project, app_current_user_id());
	END
	$$;

-- The project's confirmed delegates who hold editor or above, for anyone who
-- reads the project (viewer and above); nothing for anyone else. The members
-- list, the pack's send dialog and the delegates list read this.
CREATE FUNCTION app_authority_members(p_project uuid) RETURNS TABLE (user_id uuid)
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NOT app_has_role(p_project, 'viewer') THEN
			RETURN;
		END IF;
		RETURN QUERY SELECT d.user_id FROM authority_delegate d
			WHERE d.project_id = p_project AND d.confirmed_at IS NOT NULL
			  AND coalesce(app_member_role(p_project, d.user_id) >= 'editor'::project_role, false);
	END
	$$;

-- Whether p_user may be proposed in p_project: editor or above there,
-- directly or through its team. Answers only an owner or an authority member
-- (the people who propose); false for anyone else.
CREATE FUNCTION app_authority_candidate(p_project uuid, p_user uuid) RETURNS boolean
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NOT (app_has_role(p_project, 'owner') OR app_acts_for_authority(p_project)) THEN
			RETURN false;
		END IF;
		RETURN coalesce(app_member_role(p_project, p_user) >= 'editor'::project_role, false);
	END
	$$;

-- The people who may be proposed (editors and owners, directly or through
-- the team, not yet proposed), for an owner or an authority member; nothing
-- for anyone else. The name only: a team member's address isn't the
-- project's to show.
CREATE FUNCTION app_authority_candidates(p_project uuid) RETURNS TABLE (user_id uuid, display_name text, role project_role, via text)
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NOT (app_has_role(p_project, 'owner') OR app_acts_for_authority(p_project)) THEN
			RETURN;
		END IF;
		RETURN QUERY
			SELECT u.id, u.display_name, app_member_role(p_project, u.id),
				CASE WHEN EXISTS (SELECT 1 FROM project_member m WHERE m.project_id = p_project AND m.user_id = u.id AND m.role >= 'editor') THEN 'direct' ELSE 'team' END
			FROM app_user u
			WHERE u.id IN (
				SELECT m.user_id FROM project_member m WHERE m.project_id = p_project
				UNION SELECT tm.user_id FROM project p JOIN team_member tm ON tm.team_id = p.team_id WHERE p.id = p_project
			)
			  AND coalesce(app_member_role(p_project, u.id) >= 'editor'::project_role, false)
			  AND NOT EXISTS (SELECT 1 FROM authority_delegate d WHERE d.project_id = p_project AND d.user_id = u.id)
			ORDER BY u.display_name, u.id;
	END
	$$;

-- ---------------------------------------------------------------------------
-- Who changes it. The rules bind the app (water_app); the schema owner (the
-- operator, this migration, authority_delegate_prune) is trusted.
-- ---------------------------------------------------------------------------
CREATE FUNCTION authority_delegate_guard() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
	BEGIN
		IF TG_OP = 'DELETE' THEN
			IF current_user = 'water_app' AND NOT (
				app_acts_for_authority(OLD.project_id)
				OR OLD.user_id = uid
				OR (OLD.confirmed_at IS NULL AND app_has_role(OLD.project_id, 'owner'))
			) THEN
				RAISE EXCEPTION 'only a member acting for the responsible authority removes someone who acts for it; an owner may withdraw a proposal'
					USING ERRCODE = 'insufficient_privilege';
			END IF;
			RETURN OLD;
		END IF;
		IF TG_OP = 'UPDATE' THEN
			-- An account going: its foreign key clears proposed_by or confirmed_by, nothing else.
			IF (to_jsonb(NEW) - 'proposed_by' - 'confirmed_by') = (to_jsonb(OLD) - 'proposed_by' - 'confirmed_by')
				AND (NEW.proposed_by IS NOT DISTINCT FROM OLD.proposed_by
					OR (NEW.proposed_by IS NULL AND NOT EXISTS (SELECT 1 FROM app_user u WHERE u.id = OLD.proposed_by)))
				AND (NEW.confirmed_by IS NOT DISTINCT FROM OLD.confirmed_by
					OR (NEW.confirmed_by IS NULL AND NOT EXISTS (SELECT 1 FROM app_user u WHERE u.id = OLD.confirmed_by)))
			THEN
				RETURN NEW;
			END IF;
			IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
			   OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by OR NEW.proposed_at IS DISTINCT FROM OLD.proposed_at THEN
				RAISE EXCEPTION 'a proposal''s project, person, proposer and time never change' USING ERRCODE = 'check_violation';
			END IF;
			IF OLD.confirmed_at IS NOT NULL THEN
				RAISE EXCEPTION 'already confirmed: a confirmation never changes (remove and propose again)' USING ERRCODE = 'check_violation';
			END IF;
			IF NEW.confirmed_at IS NULL THEN
				RAISE EXCEPTION 'a proposal changes only by being confirmed' USING ERRCODE = 'check_violation';
			END IF;
		END IF;
		-- The person needs editor or above, directly or through the team, whoever adds or confirms them.
		IF NOT coalesce(app_member_role(NEW.project_id, NEW.user_id) >= 'editor'::project_role, false) THEN
			RAISE EXCEPTION 'only an editor or owner of the project (directly or through its team) can act for the responsible authority'
				USING ERRCODE = 'check_violation', CONSTRAINT = 'authority_delegate_editor';
		END IF;
		IF current_user <> 'water_app' THEN
			-- The schema owner: the operator's confirmation or this migration's carry-over, as written.
			IF NEW.confirmed_at IS NOT NULL AND NEW.confirmed_via IS NULL THEN
				NEW.confirmed_via := 'operator';
			END IF;
			RETURN NEW;
		END IF;
		IF uid IS NULL THEN
			RAISE EXCEPTION 'who acts for the responsible authority changes only by a signed-in member' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF TG_OP = 'INSERT' THEN
			IF NOT (app_has_role(NEW.project_id, 'owner') OR app_acts_for_authority(NEW.project_id)) THEN
				RAISE EXCEPTION 'only an owner of the project, or a member acting for the responsible authority, proposes who acts for it'
					USING ERRCODE = 'insufficient_privilege';
			END IF;
			NEW.proposed_by := uid;
			NEW.proposed_at := now();
			NEW.confirmation_note := '';
			IF app_acts_for_authority(NEW.project_id) THEN
				-- The authority adding its own delegate: confirmed as it is made.
				NEW.confirmed_at := now();
				NEW.confirmed_by := uid;
				NEW.confirmed_via := 'member';
			ELSE
				NEW.confirmed_at := NULL;
				NEW.confirmed_by := NULL;
				NEW.confirmed_via := NULL;
			END IF;
			RETURN NEW;
		END IF;
		-- UPDATE: the confirmation.
		IF NOT app_acts_for_authority(NEW.project_id) THEN
			RAISE EXCEPTION 'only a member already acting for the responsible authority confirms who acts for it (or the operator, on the authority''s letter)'
				USING ERRCODE = 'insufficient_privilege';
		END IF;
		NEW.confirmed_at := now();
		NEW.confirmed_by := uid;
		NEW.confirmed_via := 'member';
		NEW.confirmation_note := OLD.confirmation_note;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER authority_delegate_guard BEFORE INSERT OR UPDATE OR DELETE ON authority_delegate
	FOR EACH ROW EXECUTE FUNCTION authority_delegate_guard();

-- Read by anyone who reads the project (as the members list was), and by the person themselves.
CREATE POLICY authority_delegate_select ON authority_delegate FOR SELECT
	USING (app_has_role(project_id, 'viewer') OR user_id = app_current_user_id());
CREATE POLICY authority_delegate_insert ON authority_delegate FOR INSERT
	WITH CHECK (app_has_role(project_id, 'owner') OR app_acts_for_authority(project_id));
CREATE POLICY authority_delegate_update ON authority_delegate FOR UPDATE
	USING (app_acts_for_authority(project_id)) WITH CHECK (app_acts_for_authority(project_id));
CREATE POLICY authority_delegate_delete ON authority_delegate FOR DELETE
	USING (app_acts_for_authority(project_id) OR user_id = app_current_user_id() OR (confirmed_at IS NULL AND app_has_role(project_id, 'owner')));

-- The guard rewrites everything but project_id and user_id on an insert, and allows an update of confirmed_at only.
GRANT SELECT, INSERT, DELETE ON authority_delegate TO water_app;
GRANT UPDATE (confirmed_at) ON authority_delegate TO water_app;

-- The 163 flag is no longer the app's to set (expand/contract: dropped later).
REVOKE UPDATE (acts_for_authority) ON project_member FROM water_app;

-- ---------------------------------------------------------------------------
-- The History: every change, written where it happens.
-- ---------------------------------------------------------------------------
CREATE FUNCTION authority_delegate_audit() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		r authority_delegate;
		uid uuid := app_current_user_id();
		v_name text;
		v_kind text;
		v_actor uuid := uid;
		v_label text;
		v_subject jsonb;
	BEGIN
		IF TG_OP = 'DELETE' THEN
			r := OLD;
		ELSE
			r := NEW;
		END IF;
		-- A project or an account being deleted takes its rows with it: that deletion is its own record.
		IF NOT EXISTS (SELECT 1 FROM project WHERE id = r.project_id) THEN
			RETURN NULL;
		END IF;
		SELECT display_name INTO v_name FROM app_user WHERE id = r.user_id;
		IF NOT FOUND THEN
			RETURN NULL;
		END IF;
		IF TG_OP = 'INSERT' THEN
			v_kind := CASE WHEN NEW.confirmed_via = 'grandfathered' THEN 'authority.grandfathered'
				WHEN NEW.confirmed_at IS NOT NULL THEN 'authority.confirmed' ELSE 'authority.proposed' END;
			IF NEW.confirmed_via = 'grandfathered' THEN
				-- Its actor: the owner who ticked the flag before 233.
				v_actor := NEW.proposed_by;
			END IF;
		ELSIF TG_OP = 'UPDATE' THEN
			IF NOT (OLD.confirmed_at IS NULL AND NEW.confirmed_at IS NOT NULL) THEN
				RETURN NULL; -- an account going clears a column: nothing to say
			END IF;
			v_kind := 'authority.confirmed';
		ELSE
			v_kind := CASE
				WHEN NOT coalesce(app_member_role(OLD.project_id, OLD.user_id) >= 'editor'::project_role, false) THEN 'authority.lapsed'
				WHEN OLD.confirmed_at IS NOT NULL THEN 'authority.removed'
				WHEN uid IS DISTINCT FROM OLD.proposed_by AND uid IS DISTINCT FROM OLD.user_id AND app_acts_for_authority(OLD.project_id) THEN 'authority.declined'
				ELSE 'authority.withdrawn'
			END;
		END IF;
		v_subject := jsonb_build_object('userId', r.user_id, 'displayName', v_name);
		IF TG_OP <> 'DELETE' AND r.confirmed_via IS NOT NULL THEN
			v_subject := v_subject || jsonb_build_object('via', r.confirmed_via);
			IF r.confirmation_note <> '' THEN
				v_subject := v_subject || jsonb_build_object('reference', r.confirmation_note);
			END IF;
		END IF;
		IF TG_OP = 'DELETE' THEN
			v_subject := v_subject || jsonb_build_object('wasConfirmed', OLD.confirmed_at IS NOT NULL);
		END IF;
		SELECT left(display_name, 200) INTO v_label FROM app_user WHERE id = v_actor;
		INSERT INTO audit_event (project_id, actor_user_id, actor_label, kind, subject)
			VALUES (r.project_id, v_actor,
				coalesce(v_label, CASE WHEN v_actor IS NOT NULL THEN '' WHEN r.confirmed_via = 'operator' THEN 'Operator'
					WHEN r.confirmed_via = 'grandfathered' THEN 'An owner, before 233' ELSE '' END),
				v_kind, v_subject);
		RETURN NULL;
	END
	$$;
CREATE TRIGGER authority_delegate_audit AFTER INSERT OR UPDATE OR DELETE ON authority_delegate
	FOR EACH ROW EXECUTE FUNCTION authority_delegate_audit();

-- ---------------------------------------------------------------------------
-- Lapse: a delegate who no longer holds editor or above goes.
-- ---------------------------------------------------------------------------
-- Invoker's rights: called only from the SECURITY DEFINER triggers below, so it runs as the schema owner.
CREATE FUNCTION authority_delegate_prune(p_project uuid, p_user uuid) RETURNS void
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		DELETE FROM authority_delegate d
			WHERE d.project_id = p_project AND (p_user IS NULL OR d.user_id = p_user)
			  AND NOT coalesce(app_member_role(d.project_id, d.user_id) >= 'editor'::project_role, false);
	END
	$$;
-- Internal: only the triggers below call it.
REVOKE ALL ON FUNCTION authority_delegate_prune(uuid, uuid) FROM PUBLIC, water_app;

CREATE FUNCTION project_member_authority_lapse() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		PERFORM authority_delegate_prune(OLD.project_id, OLD.user_id);
		RETURN NULL;
	END
	$$;
CREATE TRIGGER project_member_authority_lapse AFTER DELETE OR UPDATE OF role ON project_member
	FOR EACH ROW EXECUTE FUNCTION project_member_authority_lapse();

CREATE FUNCTION team_member_authority_lapse() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		p uuid;
	BEGIN
		FOR p IN SELECT id FROM project WHERE team_id = OLD.team_id LOOP
			PERFORM authority_delegate_prune(p, OLD.user_id);
		END LOOP;
		RETURN NULL;
	END
	$$;
CREATE TRIGGER team_member_authority_lapse AFTER DELETE OR UPDATE OF role ON team_member
	FOR EACH ROW EXECUTE FUNCTION team_member_authority_lapse();

CREATE FUNCTION project_team_authority_lapse() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		PERFORM authority_delegate_prune(NEW.id, NULL);
		RETURN NULL;
	END
	$$;
CREATE TRIGGER project_team_authority_lapse AFTER UPDATE OF team_id ON project
	FOR EACH ROW WHEN (NEW.team_id IS DISTINCT FROM OLD.team_id)
	EXECUTE FUNCTION project_team_authority_lapse();

REVOKE ALL ON FUNCTION authority_delegate_guard(), authority_delegate_audit(), project_member_authority_lapse(),
	team_member_authority_lapse(), project_team_authority_lapse() FROM PUBLIC, water_app;

-- ---------------------------------------------------------------------------
-- The operator's confirmation (docs/deployment.md runbook "A responsible
-- authority confirms who acts for it"): as the schema owner, on the
-- authority's written request (its letter's reference in p_reference).
-- Confirms a proposal, or adds the person confirmed. The bootstrap: with no
-- confirmed delegate in a project, this is the only way to confirm the
-- first. Invoker's rights and closed to water_app: the app can't call it,
-- and if it could, the guard would hold it to the app's rules.
-- ---------------------------------------------------------------------------
CREATE FUNCTION authority_confirm_by_operator(p_project uuid, p_user uuid, p_reference text) RETURNS void
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF p_reference IS NULL OR btrim(p_reference) = '' OR char_length(p_reference) > 200 THEN
			RAISE EXCEPTION 'give the authority''s letter or request reference (1–200 characters)' USING ERRCODE = 'check_violation';
		END IF;
		INSERT INTO authority_delegate (project_id, user_id, proposed_by, confirmed_at, confirmed_by, confirmed_via, confirmation_note)
			VALUES (p_project, p_user, NULL, now(), NULL, 'operator', btrim(p_reference))
			ON CONFLICT (project_id, user_id) DO UPDATE
				SET confirmed_at = now(), confirmed_by = NULL, confirmed_via = 'operator', confirmation_note = btrim(p_reference)
				WHERE authority_delegate.confirmed_at IS NULL;
	END
	$$;
REVOKE ALL ON FUNCTION authority_confirm_by_operator(uuid, uuid, text) FROM PUBLIC, water_app;

-- ---------------------------------------------------------------------------
-- 5. Carry the 163 flags over, confirmed, each with its History event.
-- ---------------------------------------------------------------------------
INSERT INTO authority_delegate (project_id, user_id, proposed_by, proposed_at, confirmed_at, confirmed_by, confirmed_via, confirmation_note)
SELECT m.project_id, m.user_id, marked.actor_user_id, coalesce(marked.created_at, m.added_at), now(), NULL, 'grandfathered',
	'Marked by an owner before 233'
FROM project_member m
LEFT JOIN LATERAL (
	SELECT e.actor_user_id, e.created_at FROM audit_event e
	WHERE e.project_id = m.project_id AND e.kind = 'member.authority'
	  AND e.subject->>'userId' = m.user_id::text AND e.subject->>'actsForAuthority' = 'true'
	ORDER BY e.id DESC LIMIT 1
) marked ON true
WHERE m.acts_for_authority
  AND coalesce(app_member_role(m.project_id, m.user_id) >= 'editor'::project_role, false);
