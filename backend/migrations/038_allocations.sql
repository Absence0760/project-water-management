-- 038_allocations — registered and licensed water-use volumes per farm or
-- water user, next to modelled use (roadmap WP-3.10 first slice, issue #45
-- "WARMS volumes"; docs/allocations.md, docs/data-model.md § Allocations).
--
-- The app never decides whether a use is lawful. It stores what the
-- authorisation documents say (a WARMS registration, a licence, a general
-- authorisation, a verified existing lawful use) and shows modelled use beside
-- it.
--
-- In this file:
--  * allocation_source: the file a batch of allocations was imported from,
--    with its name and SHA-256: provenance for every imported row. Deleting
--    it deletes its rows (undo an import). A row typed into the app has no
--    source (source_id NULL).
--  * allocation: one registered volume per year, for one water source, with
--    its authorisation, purpose, optional storage and validity dates, matched
--    to a farm or water-user node (or not yet: node_id NULL). No names here.
--  * allocation_holder: the registered user's name, kept apart so RLS can
--    hide it (decision D3, recommendation (b), pending legal advice): editors
--    and owners read it, and a farmer reads it only for an allocation on a
--    farm linked to them (their own registration). A viewer reads volumes but
--    no names.
--  * Farmers read the allocations on their linked farms only (the catalogue
--    guard's farmer-aware policy, app_farm_nodes); editors write.
--  * Same-project: composite foreign keys (source and holder) and
--    assert_same_project on node_id; covering indexes on every foreign key.
--  * No ID-number or phone columns anywhere: the import refuses files that
--    carry them (POPIA minimisation, docs/security.md).

-- ---------------------------------------------------------------------------
-- allocation_source
-- ---------------------------------------------------------------------------
CREATE TABLE allocation_source (
	id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id  uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- warms_extract: a CMA/DWS WARMS extract; csv: the app's template (or any
	-- other table with the same headers).
	kind        text NOT NULL CHECK (kind IN ('warms_extract', 'csv')),
	file_name   text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
	-- SHA-256 hex of the file's text as UTF-8. One import per file per project.
	sha256      text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
	-- The document or extract reference ("WARMS extract 2026-08, CMA letter …").
	reference   text NOT NULL DEFAULT '' CHECK (char_length(reference) <= 500),
	imported_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
	imported_at timestamptz NOT NULL DEFAULT now(),
	-- For the composite foreign key from allocation (same project).
	UNIQUE (id, project_id)
);
-- Also covers the project_id foreign key; the same file can't be imported twice.
CREATE UNIQUE INDEX allocation_source_sha_idx ON allocation_source (project_id, sha256);
CREATE INDEX allocation_source_imported_by_idx ON allocation_source (imported_by);

COMMENT ON TABLE allocation_source IS
	'The file a batch of allocations was imported from, with its SHA-256 (038, WP-3.10). Deleting it deletes its allocations; hand-entered rows have none.';

-- ---------------------------------------------------------------------------
-- allocation
-- ---------------------------------------------------------------------------
CREATE TABLE allocation (
	id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id       uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- The import it came from; NULL = typed into the app.
	source_id        uuid,
	-- The farm or water user this volume belongs to; NULL = not matched yet.
	node_id          uuid REFERENCES node(id) ON DELETE SET NULL,
	registration_no  text NOT NULL DEFAULT '' CHECK (char_length(registration_no) <= 100),
	property_ref     text NOT NULL DEFAULT '' CHECK (char_length(property_ref) <= 200),
	-- registration (WARMS, GN R1352), licence (s40), general_authorisation
	-- (s39), existing_lawful_use (s32/s35 verified).
	authorisation    text NOT NULL
		CHECK (authorisation IN ('registration', 'licence', 'general_authorisation', 'existing_lawful_use')),
	-- The purpose / sector the volume is registered for.
	purpose          text NOT NULL DEFAULT 'irrigation'
		CHECK (purpose IN ('irrigation', 'domestic', 'livestock', 'industry', 'mining', 'municipal', 'other')),
	water_source     text NOT NULL CHECK (water_source IN ('surface', 'groundwater')),
	volume_m3_year   double precision NOT NULL CHECK (volume_m3_year >= 0 AND volume_m3_year < 1e12),
	-- Registered storage (s21b), m³; NULL = none registered.
	storage_m3       double precision CHECK (storage_m3 IS NULL OR (storage_m3 >= 0 AND storage_m3 < 1e12)),
	valid_from       date,
	valid_to         date,
	reference        text NOT NULL DEFAULT '' CHECK (char_length(reference) <= 500),
	created_at       timestamptz NOT NULL DEFAULT now(),
	updated_at       timestamptz NOT NULL DEFAULT now(),
	CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_from <= valid_to),
	FOREIGN KEY (source_id, project_id) REFERENCES allocation_source (id, project_id) ON DELETE CASCADE,
	UNIQUE (id, project_id)
);
-- Covers the composite source foreign key (leading source_id) and the project one.
CREATE INDEX allocation_source_id_idx ON allocation (source_id, project_id);
CREATE INDEX allocation_project_idx ON allocation (project_id);
CREATE INDEX allocation_node_idx ON allocation (node_id);

COMMENT ON TABLE allocation IS
	'A registered or licensed volume per year for one water source, matched to a farm or water-user node (038, WP-3.10). Names live in allocation_holder.';
COMMENT ON COLUMN allocation.authorisation IS 'registration (WARMS), licence, general_authorisation or existing_lawful_use. Not a finding of lawfulness.';
COMMENT ON COLUMN allocation.volume_m3_year IS 'Registered volume, m³ per year. Compared with modelled use per water year (engine compareAllocations).';

CREATE TRIGGER allocation_same_project BEFORE INSERT OR UPDATE ON allocation
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('node_id');

-- Only a farm or a water-user node takes water. SECURITY DEFINER so the check
-- sees the node past RLS (the caller is an editor, who sees it anyway).
CREATE FUNCTION allocation_node_check() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		NEW.updated_at := now();
		IF NEW.node_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM node WHERE id = NEW.node_id AND kind IN ('farm', 'user')) THEN
			RAISE EXCEPTION 'node % is not a farm or water user', NEW.node_id USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER allocation_node_check BEFORE INSERT OR UPDATE ON allocation
	FOR EACH ROW EXECUTE FUNCTION allocation_node_check();

-- A node that becomes a gauge loses its allocations' match (they stay, unmatched).
CREATE FUNCTION node_unmatch_allocations() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		UPDATE allocation SET node_id = NULL WHERE node_id = NEW.id;
		RETURN NULL;
	END
	$$;
CREATE TRIGGER node_unmatch_allocations AFTER UPDATE OF kind ON node
	FOR EACH ROW WHEN (NEW.kind = 'gauge' AND OLD.kind IS DISTINCT FROM NEW.kind)
	EXECUTE FUNCTION node_unmatch_allocations();

-- ---------------------------------------------------------------------------
-- allocation_holder: the registered user's name (D3)
-- ---------------------------------------------------------------------------
CREATE TABLE allocation_holder (
	allocation_id uuid PRIMARY KEY,
	project_id    uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	user_display  text NOT NULL CHECK (char_length(btrim(user_display)) BETWEEN 1 AND 200),
	FOREIGN KEY (allocation_id, project_id) REFERENCES allocation (id, project_id) ON DELETE CASCADE
);
-- Covers the composite foreign key (the primary key has allocation_id alone).
CREATE INDEX allocation_holder_allocation_idx ON allocation_holder (allocation_id, project_id);
CREATE INDEX allocation_holder_project_idx ON allocation_holder (project_id);

COMMENT ON TABLE allocation_holder IS
	'The registered user''s name for an allocation (038, WP-3.10, decision D3 (b) pending legal advice): editors and owners, and the linked farmer for their own farm; never viewers.';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE allocation_source ENABLE ROW LEVEL SECURITY;
CREATE POLICY allocation_source_select ON allocation_source FOR SELECT USING (app_has_role(project_id, 'viewer'));
CREATE POLICY allocation_source_insert ON allocation_source FOR INSERT WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY allocation_source_update ON allocation_source FOR UPDATE
	USING (app_has_role(project_id, 'editor')) WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY allocation_source_delete ON allocation_source FOR DELETE USING (app_has_role(project_id, 'editor'));

ALTER TABLE allocation ENABLE ROW LEVEL SECURITY;
CREATE POLICY allocation_select ON allocation FOR SELECT USING (app_has_role(project_id, 'viewer'));
-- A farmer: the allocations on their own linked farms only.
CREATE POLICY allocation_select_farmer ON allocation FOR SELECT USING (node_id IN (SELECT app_farm_nodes(project_id)));
CREATE POLICY allocation_insert ON allocation FOR INSERT WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY allocation_update ON allocation FOR UPDATE
	USING (app_has_role(project_id, 'editor')) WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY allocation_delete ON allocation FOR DELETE USING (app_has_role(project_id, 'editor'));

ALTER TABLE allocation_holder ENABLE ROW LEVEL SECURITY;
-- Editors and owners; a farmer for an allocation on their own farm (allocation's
-- own policies apply inside the subquery). Viewers: no row.
CREATE POLICY allocation_holder_select ON allocation_holder FOR SELECT
	USING (
		app_has_role(project_id, 'editor')
		OR EXISTS (
			SELECT 1 FROM allocation a
			WHERE a.id = allocation_holder.allocation_id AND a.node_id IN (SELECT app_farm_nodes(a.project_id))
		)
	);
CREATE POLICY allocation_holder_insert ON allocation_holder FOR INSERT WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY allocation_holder_update ON allocation_holder FOR UPDATE
	USING (app_has_role(project_id, 'editor')) WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY allocation_holder_delete ON allocation_holder FOR DELETE USING (app_has_role(project_id, 'editor'));

GRANT SELECT, INSERT, UPDATE, DELETE ON allocation_source, allocation, allocation_holder TO water_app;
