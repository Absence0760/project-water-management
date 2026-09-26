-- 034_farmer_invites — invite a farmer who has no verified account yet,
-- linked to their farms (roadmap WP-2.2, issue #27; docs/data-model.md
-- § Email tokens and invites, § Farmers).
--
-- WP-2.1 (020_farm_scope) could only add an existing, verified account as a
-- farmer. A farmer invite is an ordinary project invite (004_email) with the
-- role `farmer`, plus the farms it will link:
--
--  * invite_node: which farm nodes an invite links once accepted. RLS mirrors
--    `invite`: project owners only (a farmer, a viewer or the invitee sees
--    nothing). A deleted farm drops out of every invite that named it (the
--    foreign key cascades); a farm turned into a gauge or water user drops
--    out too (node_unlink_farmers, redefined below from 020). The invite
--    itself survives, so an invite can lose farms but never gain one.
--  * invite.locale: the language of the invite email (en; af follows WP-2.5,
--    English is sent until then). water_app's grants and RLS on invite cover
--    the new column.
--  * app_accept_invites, redefined from its latest definition (030_history):
--    after the project memberships it links the farms of every accepted
--    farmer invite, then records farmer.linked with cause 'invite', before
--    the invites are deleted. Still verified addresses only, still
--    idempotent (ON CONFLICT DO NOTHING). A link is written only where the
--    membership really is `farmer`: someone already an editor on the project
--    keeps that role (the insert does nothing) and gets no link, which
--    farm_link_check would refuse anyway.

ALTER TABLE invite
	ADD COLUMN locale text NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'af'));

COMMENT ON COLUMN invite.locale IS
	'Language of the invite email: en (default) or af (Afrikaans follows WP-2.5; English is sent until then). 034.';

-- ---------------------------------------------------------------------------
-- invite_node
-- ---------------------------------------------------------------------------
CREATE TABLE invite_node (
	invite_id  uuid NOT NULL REFERENCES invite(id) ON DELETE CASCADE,
	project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	node_id    uuid NOT NULL REFERENCES node(id) ON DELETE CASCADE,
	PRIMARY KEY (invite_id, node_id)
);
-- The primary key's leading column covers invite_id.
CREATE INDEX invite_node_node_idx ON invite_node (node_id);
CREATE INDEX invite_node_project_idx ON invite_node (project_id);

COMMENT ON TABLE invite_node IS
	'The farm nodes a pending farmer invite links once accepted (034, WP-2.2). Owners only, like invite.';

CREATE TRIGGER invite_node_same_project BEFORE INSERT OR UPDATE ON invite_node
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('node_id');

-- Only a farm node, and only on a farmer invite of the same project.
-- SECURITY DEFINER so the check sees the invite and the node past RLS (the
-- caller is an owner, who sees both anyway).
CREATE FUNCTION invite_node_check() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NOT EXISTS (SELECT 1 FROM node WHERE id = NEW.node_id AND kind = 'farm') THEN
			RAISE EXCEPTION 'node % is not a farm', NEW.node_id USING ERRCODE = 'check_violation';
		END IF;
		IF NOT EXISTS (
			SELECT 1 FROM invite
			WHERE id = NEW.invite_id AND project_id = NEW.project_id AND project_role = 'farmer'
		) THEN
			RAISE EXCEPTION 'invite % is not a farmer invite on this project', NEW.invite_id USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER invite_node_check BEFORE INSERT OR UPDATE ON invite_node
	FOR EACH ROW EXECUTE FUNCTION invite_node_check();

ALTER TABLE invite_node ENABLE ROW LEVEL SECURITY;
CREATE POLICY invite_node_select ON invite_node FOR SELECT USING (app_has_role(project_id, 'owner'));
CREATE POLICY invite_node_insert ON invite_node FOR INSERT WITH CHECK (app_has_role(project_id, 'owner'));
CREATE POLICY invite_node_update ON invite_node FOR UPDATE
	USING (app_has_role(project_id, 'owner')) WITH CHECK (app_has_role(project_id, 'owner'));
CREATE POLICY invite_node_delete ON invite_node FOR DELETE USING (app_has_role(project_id, 'owner'));

GRANT SELECT, INSERT, UPDATE, DELETE ON invite_node TO water_app;

-- ---------------------------------------------------------------------------
-- A farm that stops being a farm: unlink its farmers (020's body) and take it
-- out of pending farmer invites, as a deleted farm is.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION node_unlink_farmers() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		DELETE FROM farm_link WHERE node_id = NEW.id;
		DELETE FROM invite_node WHERE node_id = NEW.id;
		RETURN NULL;
	END
	$$;

-- ---------------------------------------------------------------------------
-- Accepting invites also links a farmer's farms. The body is 030's, with the
-- farm_link insert (and its farmer.linked events) between the memberships
-- and the delete. The links are a separate statement: a data-modifying CTE
-- can't see the project_member rows inserted beside it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_accept_invites(p_user uuid) RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_email citext;
		v_name text;
		n_project integer;
		n_team integer;
	BEGIN
		SELECT email, display_name INTO v_email, v_name FROM app_user WHERE id = p_user AND email_verified_at IS NOT NULL;
		IF v_email IS NULL THEN
			RETURN 0;
		END IF;
		WITH joined AS (
			INSERT INTO project_member (project_id, user_id, role)
				SELECT project_id, p_user, project_role FROM invite
				WHERE email = v_email AND project_id IS NOT NULL AND expires_at > now()
				ON CONFLICT (project_id, user_id) DO NOTHING
				RETURNING project_id, role
		), logged AS (
			INSERT INTO audit_event (project_id, actor_user_id, actor_label, kind, subject)
				SELECT j.project_id, p_user, left(coalesce(v_name, ''), 200), 'member.added',
					jsonb_build_object('userId', p_user, 'displayName', v_name, 'role', j.role::text, 'via', 'invite')
				FROM joined j
			RETURNING 1
		)
		SELECT count(*) INTO n_project FROM joined;
		WITH linked AS (
			INSERT INTO farm_link (project_id, node_id, user_id, added_by)
				SELECT i.project_id, n.node_id, p_user, i.invited_by
				FROM invite i
				JOIN invite_node n ON n.invite_id = i.id
				JOIN node nd ON nd.id = n.node_id AND nd.kind = 'farm'
				JOIN project_member m ON m.project_id = i.project_id AND m.user_id = p_user AND m.role = 'farmer'
				WHERE i.email = v_email AND i.project_role = 'farmer' AND i.expires_at > now()
				ON CONFLICT DO NOTHING
				RETURNING project_id, node_id
		)
		INSERT INTO audit_event (project_id, actor_user_id, actor_label, kind, subject)
			SELECT l.project_id, p_user, left(coalesce(v_name, ''), 200), 'farmer.linked',
				jsonb_build_object('userId', p_user, 'displayName', v_name, 'nodeId', l.node_id, 'nodeName', nd.name, 'cause', 'invite')
			FROM linked l JOIN node nd ON nd.id = l.node_id;
		INSERT INTO team_member (team_id, user_id, role)
			SELECT team_id, p_user, team_role FROM invite
			WHERE email = v_email AND team_id IS NOT NULL AND expires_at > now()
			ON CONFLICT (team_id, user_id) DO NOTHING;
		GET DIAGNOSTICS n_team = ROW_COUNT;
		DELETE FROM invite WHERE email = v_email AND expires_at > now();
		RETURN n_project + n_team;
	END
	$$;
