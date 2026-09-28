-- 020_farm_scope — farm links and farm-scoped read access for farmers
-- (roadmap WP-2.1, issue #24; design docs/design/farmer-view.md §10;
-- docs/data-model.md § Farmers).
--
-- A user with the `farmer` role (019) is linked to one or more farm nodes and
-- may read those farms and nothing about any other farm, enforced here so it
-- holds even when an API route forgets to filter.
--
-- Access is added only as extra *permissive SELECT* policies, which Postgres
-- ORs with the existing viewer policies; no existing policy changes, and a
-- farmer can't write anywhere (every write policy is editor or owner). What a
-- farmer may read:
--   project         the row itself
--   project_member  their own row only, never the member list (it holds
--                   neighbours' emails)
--   node            their linked farms, plus gauges (public infrastructure).
--                   No other farm, not even its name; no other water user
--   crop_area       rows on their linked farms
--   crop            only crops planted on their linked farms (the catchment's
--                   full crop list would tell them what a neighbour grows)
--   transfer        rules with either end on a linked farm; the other end is
--                   an id they can't resolve
--   land_cover      patches on their linked farms
--   farm_link       their own links
-- and nothing else. In particular no time_series (observed and logger flows
-- are flow volumes, which reveal neighbours' use in a small catchment,
-- design §10.3), no model_run (its inputs and summary hold every farm) and no
-- run_series: a farmer reads run results only through a publication, which
-- WP-2.3 adds with its own policies.
--
-- Also here: the anonymised counts a farmer may see instead (D1 option b,
-- app_farm_context) and the holder count behind the aggregate rule (D2,
-- app_other_farm_holders).

-- ---------------------------------------------------------------------------
-- Links
-- ---------------------------------------------------------------------------
CREATE TABLE farm_link (
	project_id uuid NOT NULL,
	node_id    uuid NOT NULL REFERENCES node(id) ON DELETE CASCADE,
	user_id    uuid NOT NULL,
	added_by   uuid REFERENCES app_user(id) ON DELETE SET NULL,
	added_at   timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (node_id, user_id),
	-- A link needs a membership, and goes with it: removing the member (or
	-- them leaving, or the project going) removes their links.
	FOREIGN KEY (project_id, user_id) REFERENCES project_member (project_id, user_id) ON DELETE CASCADE
);
CREATE INDEX farm_link_member_idx ON farm_link (project_id, user_id);
CREATE INDEX farm_link_user_idx ON farm_link (user_id);
CREATE INDEX farm_link_added_by_idx ON farm_link (added_by);

COMMENT ON TABLE farm_link IS
	'Which farm nodes a farmer member may read (019/020, WP-2.1). Many-to-many: a farmer may have several farms, a farm several farmers.';

CREATE TRIGGER farm_link_same_project BEFORE INSERT OR UPDATE ON farm_link
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('node_id');

-- Only a farm node, and only for a member whose role is farmer (a viewer and
-- above already sees every farm, so a link would mean nothing).
CREATE FUNCTION farm_link_check() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NOT EXISTS (SELECT 1 FROM node WHERE id = NEW.node_id AND kind = 'farm') THEN
			RAISE EXCEPTION 'node % is not a farm', NEW.node_id USING ERRCODE = 'check_violation';
		END IF;
		IF NOT EXISTS (
			SELECT 1 FROM project_member
			WHERE project_id = NEW.project_id AND user_id = NEW.user_id AND role = 'farmer'
		) THEN
			RAISE EXCEPTION 'user % is not a farmer on this project', NEW.user_id USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER farm_link_check BEFORE INSERT OR UPDATE ON farm_link
	FOR EACH ROW EXECUTE FUNCTION farm_link_check();

-- A farm the model turns into a gauge or another water user stops being a
-- farm: its farmers are unlinked, as if it were deleted. (Saving the model
-- upserts nodes by id, so a plain save keeps every link.) SECURITY DEFINER
-- because an editor saves the model and only owners may delete links.
CREATE FUNCTION node_unlink_farmers() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		DELETE FROM farm_link WHERE node_id = NEW.id;
		RETURN NULL;
	END
	$$;
CREATE TRIGGER node_unlink_farmers AFTER UPDATE OF kind ON node
	FOR EACH ROW WHEN (OLD.kind = 'farm' AND NEW.kind IS DISTINCT FROM 'farm')
	EXECUTE FUNCTION node_unlink_farmers();

-- ---------------------------------------------------------------------------
-- Helpers (SECURITY DEFINER: they read farm_link and node past RLS, and are
-- what the policies below call).
-- ---------------------------------------------------------------------------

-- The current user's linked farm nodes in a project.
CREATE FUNCTION app_farm_nodes(p_project uuid) RETURNS SETOF uuid
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT node_id FROM farm_link WHERE project_id = p_project AND user_id = app_current_user_id()
	$$;

-- Farms upstream and downstream of a node and the catchment's farm count:
-- the only thing a farmer learns about other farms (D1 option b). Counts,
-- never ids or names. Answers only a viewer and above, or a user linked to
-- that node; anyone else gets no row. UNION (not UNION ALL) so a malformed
-- network with a loop still terminates.
CREATE FUNCTION app_farm_context(p_project uuid, p_node uuid)
	RETURNS TABLE (farms_upstream integer, farms_downstream integer, farm_count integer)
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		WITH RECURSIVE up AS (
			SELECT id FROM node WHERE project_id = p_project AND downstream_node_id = p_node
			UNION
			SELECT n.id FROM node n JOIN up ON n.downstream_node_id = up.id WHERE n.project_id = p_project
		), down AS (
			SELECT downstream_node_id AS id FROM node
			WHERE id = p_node AND project_id = p_project AND downstream_node_id IS NOT NULL
			UNION
			SELECT n.downstream_node_id FROM node n JOIN down ON n.id = down.id WHERE n.downstream_node_id IS NOT NULL
		)
		SELECT
			(SELECT count(*) FROM node WHERE kind = 'farm' AND id IN (SELECT id FROM up))::integer,
			(SELECT count(*) FROM node WHERE kind = 'farm' AND id IN (SELECT id FROM down))::integer,
			(SELECT count(*) FROM node WHERE kind = 'farm' AND project_id = p_project)::integer
		WHERE EXISTS (SELECT 1 FROM node WHERE id = p_node AND project_id = p_project)
		  AND (app_has_role(p_project, 'viewer') OR p_node IN (SELECT app_farm_nodes(p_project)))
	$$;

-- How many *other holders* hold the catchment's farms, from the current
-- user's point of view (D2, design §10.3): the farms not linked to them,
-- with farms linked to the same user counted once (by the lowest linked user
-- id) and an unlinked farm counted on its own. A farmer-facing aggregate of
-- farm quantities (totals, the even share) is shown only when this is at
-- least k - 1. NULL for someone who isn't a member.
CREATE FUNCTION app_other_farm_holders(p_project uuid) RETURNS integer
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT CASE WHEN app_has_role(p_project, 'farmer') THEN (
			SELECT count(DISTINCT coalesce(
				(SELECT min(fl.user_id::text) FROM farm_link fl WHERE fl.node_id = n.id),
				'node:' || n.id::text
			))::integer
			FROM node n
			WHERE n.project_id = p_project AND n.kind = 'farm'
			  AND n.id NOT IN (SELECT app_farm_nodes(p_project))
		) END
	$$;

-- ---------------------------------------------------------------------------
-- Policies. farm_link: viewers see every link (the WUA manages them), a
-- farmer their own; only owners change them (as with members).
-- ---------------------------------------------------------------------------
ALTER TABLE farm_link ENABLE ROW LEVEL SECURITY;
CREATE POLICY farm_link_select ON farm_link FOR SELECT
	USING (app_has_role(project_id, 'viewer') OR user_id = app_current_user_id());
CREATE POLICY farm_link_insert ON farm_link FOR INSERT WITH CHECK (app_has_role(project_id, 'owner'));
CREATE POLICY farm_link_update ON farm_link FOR UPDATE
	USING (app_has_role(project_id, 'owner')) WITH CHECK (app_has_role(project_id, 'owner'));
CREATE POLICY farm_link_delete ON farm_link FOR DELETE USING (app_has_role(project_id, 'owner'));

-- Farmer reads, ORed with the existing viewer policies.
CREATE POLICY project_select_farmer ON project FOR SELECT USING (app_has_role(id, 'farmer'));
CREATE POLICY member_select_self ON project_member FOR SELECT USING (user_id = app_current_user_id());
CREATE POLICY node_select_farmer ON node FOR SELECT
	USING (id IN (SELECT app_farm_nodes(project_id)) OR (kind = 'gauge' AND app_has_role(project_id, 'farmer')));
CREATE POLICY crop_area_select_farmer ON crop_area FOR SELECT
	USING (node_id IN (SELECT app_farm_nodes(project_id)));
-- crop_area's own policies apply inside the subquery, so this reaches only
-- crops on the farmer's farms.
CREATE POLICY crop_select_farmer ON crop FOR SELECT
	USING (EXISTS (
		SELECT 1 FROM crop_area ca
		WHERE ca.crop_id = crop.id AND ca.node_id IN (SELECT app_farm_nodes(crop.project_id))
	));
CREATE POLICY transfer_select_farmer ON transfer FOR SELECT
	USING (from_node_id IN (SELECT app_farm_nodes(project_id)) OR to_node_id IN (SELECT app_farm_nodes(project_id)));
CREATE POLICY land_cover_select_farmer ON land_cover FOR SELECT
	USING (node_id IN (SELECT app_farm_nodes(project_id)));

GRANT SELECT, INSERT, UPDATE, DELETE ON farm_link TO water_app;
