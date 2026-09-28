-- 001_init — users, projects, membership, and per-project model data.
--
-- Access model (docs/data-model.md § "Access control"):
--   * The backend connects as `water_app` (no BYPASSRLS). Each request runs in
--     a transaction that sets `app.current_user_id`; every project-scoped table
--     has RLS policies keyed on project membership.
--   * Roles: viewer < editor < owner. Viewers read; editors change model data;
--     owners also manage members and delete the project.

CREATE EXTENSION IF NOT EXISTS citext;

-- The app role is created out-of-band (dev: dev/postgres/00-roles.sql; prod:
-- Terraform/ops with a real secret). Guard so migrations still run on a bare
-- database, e.g. CI.
DO $$
BEGIN
	IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'water_app') THEN
		CREATE ROLE water_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
	END IF;
END
$$;

CREATE TYPE project_role AS ENUM ('viewer', 'editor', 'owner');
CREATE TYPE node_kind AS ENUM ('farm', 'gauge');

-- ---------------------------------------------------------------------------
-- Users. Not RLS-protected: the auth routes must look users up by email before
-- anyone is signed in. The backend never returns password_hash.
-- ---------------------------------------------------------------------------
CREATE TABLE app_user (
	id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	email         citext NOT NULL UNIQUE,
	display_name  text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
	password_hash text NOT NULL,
	created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Projects — one per catchment / place (the Excel tool's "one workbook").
-- ---------------------------------------------------------------------------
CREATE TABLE project (
	id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
	description text NOT NULL DEFAULT '',
	-- Model-wide settings (calibration, A-pan, EWR, …). Shape: ProjectSettings
	-- in packages/engine/src/project.ts; validated by the backend.
	settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_by  uuid NOT NULL REFERENCES app_user(id),
	created_at  timestamptz NOT NULL DEFAULT now(),
	updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_member (
	project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
	role       project_role NOT NULL,
	added_at   timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_member_user_idx ON project_member (user_id);

-- ---------------------------------------------------------------------------
-- Network elements (b023 [Network] + [Farm spec]). Topology is a tree that
-- drains to one outflow gauge: each node points at the node it flows into.
-- No bifurcation (a node has at most one downstream), matching the workbook.
-- ---------------------------------------------------------------------------
CREATE TABLE node (
	id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id            uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	name                  text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
	kind                  node_kind NOT NULL,
	downstream_node_id    uuid REFERENCES node(id) ON DELETE SET NULL,
	-- Display / tie-break order; the engine derives calculation order from topology.
	sort_order            integer NOT NULL DEFAULT 0,
	-- Farm spec (ignored for gauges).
	area_km2              double precision NOT NULL DEFAULT 0 CHECK (area_km2 >= 0),
	area_hi_km2           double precision NOT NULL DEFAULT 0 CHECK (area_hi_km2 >= 0),
	area_lo_km2           double precision NOT NULL DEFAULT 0 CHECK (area_lo_km2 >= 0),
	flow_share_manual     double precision CHECK (flow_share_manual BETWEEN 0 AND 1),
	pct_upstream_to_dam   double precision NOT NULL DEFAULT 1 CHECK (pct_upstream_to_dam BETWEEN 0 AND 1),
	pct_runoff_to_dam     double precision NOT NULL DEFAULT 0 CHECK (pct_runoff_to_dam BETWEEN 0 AND 1),
	dam_capacity_m3       double precision NOT NULL DEFAULT 0 CHECK (dam_capacity_m3 >= 0),
	dam_initial_pct       double precision NOT NULL DEFAULT 0 CHECK (dam_initial_pct BETWEEN 0 AND 1),
	dam_min_pct           double precision NOT NULL DEFAULT 0 CHECK (dam_min_pct BETWEEN 0 AND 1),
	divert_capacity_m3_day double precision NOT NULL DEFAULT 0 CHECK (divert_capacity_m3_day >= 0),
	return_flow_pct       double precision NOT NULL DEFAULT 0 CHECK (return_flow_pct BETWEEN 0 AND 1),
	UNIQUE (project_id, name),
	CHECK (downstream_node_id IS DISTINCT FROM id)
);
CREATE INDEX node_project_idx ON node (project_id);

-- Crops and their monthly crop factors (b023 [Crop demand]). Per project, so a
-- catchment can tune factors without touching others.
CREATE TABLE crop (
	id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id  uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
	-- Water-year order, index 1 = October … 12 = September.
	crop_factor double precision[] NOT NULL CHECK (cardinality(crop_factor) = 12),
	UNIQUE (project_id, name)
);
CREATE INDEX crop_project_idx ON crop (project_id);

-- Planted area per farm per crop (b023 [Farm demand]).
CREATE TABLE crop_area (
	project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	node_id    uuid NOT NULL REFERENCES node(id) ON DELETE CASCADE,
	crop_id    uuid NOT NULL REFERENCES crop(id) ON DELETE CASCADE,
	area_m2    double precision NOT NULL CHECK (area_m2 >= 0),
	PRIMARY KEY (node_id, crop_id)
);
CREATE INDEX crop_area_project_idx ON crop_area (project_id);

-- Inter-farm transfers (b023 [Transfers]) as structured rules instead of the
-- hand-written per-catchment formulas. Water is drawn from the source dam's
-- previous-day storage above its minimum level, capped by rate and daily cap.
CREATE TABLE transfer (
	id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id      uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	from_node_id    uuid NOT NULL REFERENCES node(id) ON DELETE CASCADE,
	to_node_id      uuid NOT NULL REFERENCES node(id) ON DELETE CASCADE,
	-- Calendar months (1–12) in which the transfer runs.
	months          smallint[] NOT NULL DEFAULT '{}',
	max_rate_m3s    double precision NOT NULL DEFAULT 0 CHECK (max_rate_m3s >= 0),
	daily_cap_m3    double precision CHECK (daily_cap_m3 >= 0),
	min_storage_pct double precision NOT NULL DEFAULT 0 CHECK (min_storage_pct BETWEEN 0 AND 1),
	enabled         boolean NOT NULL DEFAULT true,
	CHECK (from_node_id <> to_node_id)
);
CREATE INDEX transfer_project_idx ON transfer (project_id);

-- Daily time series (rainfall, observed / modelled flow). One row per series,
-- values as an array starting at start_date — one value per day for decades, instead
-- of one row per day. NULL elements mean "no reading that day".
CREATE TABLE time_series (
	id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	kind       text NOT NULL,
	-- Distinguishes several series of one kind (e.g. two rain gauges).
	name       text NOT NULL DEFAULT '',
	unit       text NOT NULL,
	start_date date NOT NULL,
	"values"   double precision[] NOT NULL,
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (project_id, kind, name)
);

-- Model runs and their outputs. Summaries are small JSON; daily outputs are
-- arrays per (node, series key) so the UI fetches one series at a time.
CREATE TABLE model_run (
	id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id     uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	created_by     uuid NOT NULL REFERENCES app_user(id),
	created_at     timestamptz NOT NULL DEFAULT now(),
	label          text NOT NULL DEFAULT '',
	engine_version text NOT NULL,
	start_date     date NOT NULL,
	end_date       date NOT NULL,
	-- Snapshot of the inputs the run used, so old results stay explainable
	-- after the project is edited.
	inputs         jsonb NOT NULL,
	summary        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX model_run_project_idx ON model_run (project_id, created_at DESC);

CREATE TABLE run_series (
	run_id     uuid NOT NULL REFERENCES model_run(id) ON DELETE CASCADE,
	project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- NULL node = catchment-level series (natural flow, simulated outflow, …).
	node_id    uuid REFERENCES node(id) ON DELETE CASCADE,
	key        text NOT NULL,
	-- { label, unit } for display.
	meta       jsonb NOT NULL DEFAULT '{}'::jsonb,
	"values"   double precision[] NOT NULL,
	UNIQUE NULLS NOT DISTINCT (run_id, node_id, key)
);

-- Covering indexes for every foreign key: cascades and the RLS joins would
-- otherwise scan (guarded by src/db/catalogue.db.test.ts).
CREATE INDEX project_created_by_idx ON project (created_by);
CREATE INDEX node_downstream_idx ON node (downstream_node_id);
CREATE INDEX crop_area_crop_idx ON crop_area (crop_id);
CREATE INDEX transfer_from_idx ON transfer (from_node_id);
CREATE INDEX transfer_to_idx ON transfer (to_node_id);
CREATE INDEX time_series_project_idx ON time_series (project_id);
CREATE INDEX model_run_created_by_idx ON model_run (created_by);
CREATE INDEX run_series_project_idx ON run_series (project_id);
CREATE INDEX run_series_node_idx ON run_series (node_id);

-- ---------------------------------------------------------------------------
-- Row-level security
--
-- RLS is ENABLEd but deliberately not FORCEd: the SECURITY DEFINER helpers
-- below run as the table owner and must bypass the policies (app_has_role
-- reads project_member, whose own policy calls app_has_role). water_app does
-- not own any table, so every policy still applies to it.
-- ---------------------------------------------------------------------------

-- Current user from the per-transaction setting; NULL when unset.
CREATE FUNCTION app_current_user_id() RETURNS uuid
	LANGUAGE sql STABLE SET search_path = public
	AS $$ SELECT nullif(current_setting('app.current_user_id', true), '')::uuid $$;

-- SECURITY DEFINER so policies on project_member can call it without recursing
-- through project_member's own RLS.
CREATE FUNCTION app_has_role(p_project uuid, p_min project_role) RETURNS boolean
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT EXISTS (
			SELECT 1 FROM project_member
			WHERE project_id = p_project
			  AND user_id = app_current_user_id()
			  AND role >= p_min
		)
	$$;

-- The creator becomes the project's first owner, atomically with the insert.
CREATE FUNCTION project_add_creator_as_owner() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		INSERT INTO project_member (project_id, user_id, role) VALUES (NEW.id, NEW.created_by, 'owner');
		RETURN NEW;
	END
	$$;
CREATE TRIGGER project_creator_owner AFTER INSERT ON project
	FOR EACH ROW EXECUTE FUNCTION project_add_creator_as_owner();

-- A project must always keep at least one owner.
CREATE FUNCTION project_member_keep_owner() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		pid uuid := OLD.project_id;
	BEGIN
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
CREATE CONSTRAINT TRIGGER project_member_keep_owner
	AFTER UPDATE OR DELETE ON project_member
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW EXECUTE FUNCTION project_member_keep_owner();

ALTER TABLE project ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_select ON project FOR SELECT USING (app_has_role(id, 'viewer'));
CREATE POLICY project_insert ON project FOR INSERT WITH CHECK (created_by = app_current_user_id());
CREATE POLICY project_update ON project FOR UPDATE USING (app_has_role(id, 'editor')) WITH CHECK (app_has_role(id, 'editor'));
CREATE POLICY project_delete ON project FOR DELETE USING (app_has_role(id, 'owner'));

ALTER TABLE project_member ENABLE ROW LEVEL SECURITY;
CREATE POLICY member_select ON project_member FOR SELECT USING (app_has_role(project_id, 'viewer'));
CREATE POLICY member_insert ON project_member FOR INSERT WITH CHECK (app_has_role(project_id, 'owner'));
CREATE POLICY member_update ON project_member FOR UPDATE USING (app_has_role(project_id, 'owner')) WITH CHECK (app_has_role(project_id, 'owner'));
-- Owners remove anyone; anyone may leave a project themselves.
CREATE POLICY member_delete ON project_member FOR DELETE USING (app_has_role(project_id, 'owner') OR user_id = app_current_user_id());

-- Model-data tables share one shape: read = viewer, write = editor.
DO $$
DECLARE
	t text;
BEGIN
	FOREACH t IN ARRAY ARRAY['node', 'crop', 'crop_area', 'transfer', 'time_series', 'model_run', 'run_series'] LOOP
		EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
		EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (app_has_role(project_id, ''viewer''))', t || '_select', t);
		EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (app_has_role(project_id, ''editor''))', t || '_insert', t);
		EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (app_has_role(project_id, ''editor'')) WITH CHECK (app_has_role(project_id, ''editor''))', t || '_update', t);
		EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (app_has_role(project_id, ''editor''))', t || '_delete', t);
	END LOOP;
END
$$;

-- Child rows must reference nodes/crops in the *same* project, otherwise an
-- editor of project A could attach a crop area to project B's node id.
CREATE FUNCTION assert_same_project() RETURNS trigger
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
CREATE TRIGGER node_same_project BEFORE INSERT OR UPDATE ON node
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('downstream_node_id');
CREATE TRIGGER crop_area_same_project BEFORE INSERT OR UPDATE ON crop_area
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('node_id', 'crop_id');
CREATE TRIGGER transfer_same_project BEFORE INSERT OR UPDATE ON transfer
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('from_node_id', 'to_node_id');
CREATE TRIGGER run_series_same_project BEFORE INSERT OR UPDATE ON run_series
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('node_id');

-- ---------------------------------------------------------------------------
-- Grants for the app role
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO water_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
	app_user, project, project_member, node, crop, crop_area, transfer, time_series, model_run, run_series
	TO water_app;
