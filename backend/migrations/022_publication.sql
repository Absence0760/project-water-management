-- 022_publication — the published baseline and its per-farm projection
-- (roadmap WP-2.3, phase 1; design docs/design/farmer-view.md §2, §4 E10;
-- docs/data-model.md § Publications).
--
-- Each project has at most one *current* publication: a run an editor chose
-- for stakeholders, with the WUA's restriction notice. Publishing stores,
-- once, what farmers may see of it: catchment_view (counts and dates only,
-- readable by every member, farmers included) and one publication_farm row
-- per farm (the FarmProjection of packages/engine/src/views/farmView.ts,
-- readable by viewers and by the farmers linked to that farm).
--
-- A publication keeps its run: run_id has no cascade, a publication cites its
-- run (model_run_cited below, so trimRuns and the DELETE route, through
-- runs/execute.ts RUN_KEPT_SQL, skip it) and DELETE /runs/:runId answers 409. The foreign key is NO ACTION rather than RESTRICT: RESTRICT is
-- checked at once, so deleting a project (which cascades to its runs and its
-- publications in one statement) would fail on whichever came first; NO
-- ACTION checks at the end of the statement, and still refuses a plain
-- DELETE of a published run. History is capped at the newest 12 per project
-- (run_publication_cap below); an older one goes, and its run becomes
-- trimmable again.
--
-- Share links (share_link, app_share_view) are WP-2.3 phase 2 and not here
-- (docs/followups.md).

-- ---------------------------------------------------------------------------
-- assert_same_project, from its latest definition (001_init.sql), with two
-- more reference kinds: %run_id → model_run, %publication_id →
-- run_publication. Everything else resolves against node, as before.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_same_project() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		col text;
		ref_id uuid;
		ref_project uuid;
	BEGIN
		FOREACH col IN ARRAY TG_ARGV LOOP
			ref_id := (to_jsonb(NEW) ->> col)::uuid;
			CONTINUE WHEN ref_id IS NULL;
			IF col LIKE '%crop_id' THEN
				SELECT project_id INTO ref_project FROM crop WHERE id = ref_id;
			ELSIF col LIKE '%run_id' THEN
				SELECT project_id INTO ref_project FROM model_run WHERE id = ref_id;
			ELSIF col LIKE '%publication_id' THEN
				SELECT project_id INTO ref_project FROM run_publication WHERE id = ref_id;
			ELSE
				SELECT project_id INTO ref_project FROM node WHERE id = ref_id;
			END IF;
			IF ref_project IS DISTINCT FROM NEW.project_id THEN
				RAISE EXCEPTION '% % belongs to a different project', col, ref_id USING ERRCODE = 'foreign_key_violation';
			END IF;
		END LOOP;
		RETURN NEW;
	END
	$$;

-- ---------------------------------------------------------------------------
-- Publications
-- ---------------------------------------------------------------------------
CREATE TABLE run_publication (
	id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id       uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	run_id           uuid NOT NULL REFERENCES model_run(id),
	published_by     uuid REFERENCES app_user(id) ON DELETE SET NULL,
	published_at     timestamptz NOT NULL DEFAULT now(),
	-- The modeller's note to the project's staff. The API shows it to viewers
	-- and above only (RLS can't hide one column from farmers; docs/security.md).
	note             text NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
	-- The WUA's restriction notice (design §3 Q2). Only the WUA writes the words.
	restriction_level text NOT NULL DEFAULT 'none' CHECK (restriction_level IN ('none', 'advisory', 'restricted')),
	restriction_pct  numeric(5,2) CHECK (restriction_pct BETWEEN 0 AND 100),
	notice_en        text CHECK (length(notice_en) <= 2000),
	notice_af        text CHECK (length(notice_af) <= 2000),
	-- E10: when the WUA expects to publish next.
	next_expected_on date,
	-- CatchmentView (packages/engine/src/views/farmProjection.ts) plus run meta:
	-- counts and dates only, never a flow volume or a total of farm quantities.
	catchment_view   jsonb NOT NULL DEFAULT '{}'::jsonb,
	superseded_at    timestamptz,
	-- Who last changed the notice, the note or the next date (PATCH), and when.
	updated_at       timestamptz,
	updated_by       uuid REFERENCES app_user(id) ON DELETE SET NULL,
	-- "No restriction" carries no percentage.
	CHECK (restriction_level <> 'none' OR restriction_pct IS NULL)
);
COMMENT ON TABLE run_publication IS
	'A run published to the project''s stakeholders with the WUA''s notice (022, WP-2.3). One current (superseded_at IS NULL) per project; history capped at 12.';

-- One current publication per project.
CREATE UNIQUE INDEX run_publication_current_idx ON run_publication (project_id) WHERE superseded_at IS NULL;
CREATE INDEX run_publication_project_idx ON run_publication (project_id, published_at DESC);
CREATE INDEX run_publication_run_idx ON run_publication (run_id);
CREATE INDEX run_publication_published_by_idx ON run_publication (published_by);
CREATE INDEX run_publication_updated_by_idx ON run_publication (updated_by);

CREATE TRIGGER run_publication_same_project BEFORE INSERT OR UPDATE ON run_publication
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('run_id');

-- The per-farm projection, written once when the run is published and never
-- changed: it is what that farm's farmers were shown. Rows go with their
-- publication, or with their node.
CREATE TABLE publication_farm (
	publication_id uuid NOT NULL REFERENCES run_publication(id) ON DELETE CASCADE,
	project_id     uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	node_id        uuid NOT NULL REFERENCES node(id) ON DELETE CASCADE,
	-- FarmProjection (packages/engine/src/views/farmView.ts).
	view           jsonb NOT NULL,
	PRIMARY KEY (publication_id, node_id)
);
COMMENT ON TABLE publication_farm IS
	'One farm''s FarmProjection in a publication (022, WP-2.3). Append-only: what the farm''s farmers were shown.';
CREATE INDEX publication_farm_node_idx ON publication_farm (node_id);
CREATE INDEX publication_farm_project_idx ON publication_farm (project_id);

CREATE TRIGGER publication_farm_same_project BEFORE INSERT OR UPDATE ON publication_farm
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('node_id', 'publication_id');

-- Keep the newest 12 publications per project. SECURITY DEFINER because the
-- editor who publishes may not delete publications (owner only): the cap is
-- the schema's rule, not the caller's choice. The current one is never
-- trimmed (it is the newest). Same value as PUBLICATION_HISTORY_MAX in
-- backend/src/publish/publish.ts.
CREATE FUNCTION run_publication_cap() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		DELETE FROM run_publication WHERE id IN (
			SELECT id FROM run_publication
			WHERE project_id = NEW.project_id
			ORDER BY published_at DESC, id DESC
			OFFSET 12
		) AND superseded_at IS NOT NULL;
		RETURN NULL;
	END
	$$;
CREATE TRIGGER run_publication_cap AFTER INSERT ON run_publication
	FOR EACH ROW EXECUTE FUNCTION run_publication_cap();

-- A publication cites its run (021_series_blob.sql's one place for citations):
-- the latest body is 021's `SELECT false`, so this is its first clause.
CREATE OR REPLACE FUNCTION model_run_cited(p_run uuid) RETURNS boolean
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$ SELECT EXISTS (SELECT 1 FROM run_publication p WHERE p.run_id = p_run) $$;

COMMENT ON FUNCTION model_run_cited(uuid) IS
	'True for a run a publication (022_publication), scenario, evidence pack or assessment cites (021_series_blob; one EXISTS clause per citing table, added by that table''s migration). Part of RUN_KEPT_SQL in backend/src/runs/execute.ts.';

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
ALTER TABLE run_publication ENABLE ROW LEVEL SECURITY;
-- Every member, farmers included (farmer is the lowest rank).
CREATE POLICY run_publication_select ON run_publication FOR SELECT USING (app_has_role(project_id, 'farmer'));
-- An editor publishes, as themselves.
CREATE POLICY run_publication_insert ON run_publication FOR INSERT
	WITH CHECK (app_has_role(project_id, 'editor') AND published_by = app_current_user_id());
CREATE POLICY run_publication_update ON run_publication FOR UPDATE
	USING (app_has_role(project_id, 'editor')) WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY run_publication_delete ON run_publication FOR DELETE USING (app_has_role(project_id, 'owner'));

ALTER TABLE publication_farm ENABLE ROW LEVEL SECURITY;
-- Viewers and above see every farm; a farmer only the farms linked to them.
CREATE POLICY publication_farm_select ON publication_farm FOR SELECT
	USING (app_has_role(project_id, 'viewer') OR node_id IN (SELECT app_farm_nodes(project_id)));
CREATE POLICY publication_farm_insert ON publication_farm FOR INSERT WITH CHECK (app_has_role(project_id, 'editor'));

-- A farmer reads their own farms' daily series of the *current* publication's
-- run, and only the farm allowlist (design §10.3; FARMER_SERIES_KEYS in
-- packages/engine/src/views/farmProjection.ts): no flow series, no
-- catchment series, nothing of an earlier publication. ORed with the viewer
-- policy (001). run_publication's own policy applies inside the subquery.
CREATE POLICY run_series_select_farmer ON run_series FOR SELECT
	USING (
		node_id IN (SELECT app_farm_nodes(project_id))
		AND key IN ('demand', 'supplied', 'deficit', 'dam_storage', 'spill', 'transfer')
		AND run_id IN (SELECT p.run_id FROM run_publication p WHERE p.project_id = run_series.project_id AND p.superseded_at IS NULL)
	);

-- "Who can see my farm" (design §10.2): everyone who can read this farm's
-- figures, by display name and effective role, never an email. The farmers
-- linked to the farm, and every viewer-and-above member, direct or through
-- the project's team (mapped as app_project_role maps them). A farmer can't
-- read the member list through RLS (020), so this is SECURITY DEFINER, and
-- it answers only a viewer and above, or a user linked to that farm; anyone
-- else gets no row.
CREATE FUNCTION app_farm_access(p_project uuid, p_node uuid)
	RETURNS TABLE (display_name text, role text, is_you boolean)
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		WITH people AS (
			SELECT fl.user_id, 'farmer'::text AS role, 0 AS rk
			FROM farm_link fl WHERE fl.project_id = p_project AND fl.node_id = p_node
			UNION ALL
			SELECT m.user_id, m.role::text,
				CASE m.role::text WHEN 'viewer' THEN 1 WHEN 'editor' THEN 2 WHEN 'owner' THEN 3 END
			FROM project_member m WHERE m.project_id = p_project AND m.role::text IN ('viewer', 'editor', 'owner')
			UNION ALL
			SELECT tm.user_id,
				CASE tm.role::text WHEN 'admin' THEN 'owner' WHEN 'member' THEN 'editor' WHEN 'viewer' THEN 'viewer' END,
				CASE tm.role::text WHEN 'admin' THEN 3 WHEN 'member' THEN 2 WHEN 'viewer' THEN 1 END
			FROM project p JOIN team_member tm ON tm.team_id = p.team_id
			WHERE p.id = p_project
		), best AS (
			SELECT DISTINCT ON (user_id) user_id, role, rk FROM people WHERE role IS NOT NULL ORDER BY user_id, rk DESC
		)
		SELECT u.display_name::text, b.role, b.user_id = app_current_user_id()
		FROM best b JOIN app_user u ON u.id = b.user_id
		WHERE EXISTS (SELECT 1 FROM node WHERE id = p_node AND project_id = p_project AND kind = 'farm')
		  AND (app_has_role(p_project, 'viewer') OR p_node IN (SELECT app_farm_nodes(p_project)))
		ORDER BY b.rk, u.display_name
	$$;

-- ---------------------------------------------------------------------------
-- Grants. A publication's run, project, projection and publisher never
-- change: water_app may update only the notice, the note, the next date, the
-- supersession and the update stamp. publication_farm is append-only.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, DELETE ON run_publication TO water_app;
GRANT UPDATE (note, restriction_level, restriction_pct, notice_en, notice_af, next_expected_on, superseded_at, updated_at, updated_by)
	ON run_publication TO water_app;
GRANT SELECT, INSERT ON publication_farm TO water_app;
