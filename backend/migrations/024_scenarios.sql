-- 024_scenarios — scenarios within a project: a named, ordered list of
-- overrides on a base run, run and compared without copying the project
-- (roadmap WP-3.2, issue #18; docs/scenarios.md, docs/data-model.md
-- § Scenarios). 022 is the publication (WP-2.3), 023 the server-side PDF
-- reports (#26).
--
-- A scenario applies to a **run snapshot**: its base run's stored inputs
-- (021_series_blob, loadRunInput), never the live model, so editing the model
-- afterwards can't change it. Its ops are engine ScenarioOp values
-- (packages/engine/src/scenario), applied by backend/src/scenarios/execute.ts
-- executeScenarioRun, which saves an ordinary model_run with scenario_id set.
--
-- In this file:
--  * `scenario`, with RLS viewer read / editor write and grants to water_app.
--    Farmers read nothing (fail closed, as for model_run: a scenario's ops and
--    its base run name every farm). WP-3.3 adds the applicant's own policies.
--  * `model_run.scenario_id`: which scenario produced a run (NULL for a run of
--    the live model). Set on insert only (no UPDATE grant); SET NULL when the
--    scenario is deleted, and the run's own snapshot (inputs.scenario) still
--    says which ops made it.
--  * Same-project triggers on both foreign keys, and covering indexes.
--  * A frozen scenario: once submitted, its ops, base and owned nodes can't
--    change, and it can't be deleted until withdrawn (scenario_guard). The API
--    answers 409 first.
--  * A citation: model_run_cited is also true for a scenario's base run
--    (022_publication added the first clause), so trimRuns and the run DELETE
--    route keep it (RUN_KEPT_SQL, unchanged).
--  * The publication-history cap (022's run_publication_cap) skips a
--    publication whose run a scenario is based on, so the base keeps its
--    "published" provenance.
--  * The pin ceiling stops counting cited runs (the plan's WP-3.1 follow-up).
--  * run_series.node_id no longer references the live `node` table: a
--    scenario run has nodes the live model doesn't (node.add), and a base run
--    may name nodes deleted from it since. The check moves to the run's own
--    snapshot (run_series_nodes_in_run).

-- ---------------------------------------------------------------------------
-- scenario
-- ---------------------------------------------------------------------------
CREATE TABLE scenario (
	id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id     uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	name           text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
	description    text NOT NULL DEFAULT '' CHECK (char_length(description) <= 4000),
	-- The run the ops apply to. NO ACTION, not RESTRICT (the plan's word): it
	-- is checked at the end of the statement, so deleting the whole project
	-- (which cascades to model_run and scenario) still works, as for
	-- run_nomination (010). Any other delete of a cited run fails.
	base_run_id    uuid NOT NULL REFERENCES model_run(id),
	-- engine ScenarioOp[] (validated by the API with validateScenarioOps; ids
	-- tightened to UUIDs). At most 500 ops and 1 MiB of JSON text.
	ops            jsonb NOT NULL DEFAULT '[]'::jsonb
		CHECK (jsonb_typeof(ops) = 'array' AND jsonb_array_length(ops) <= 500 AND octet_length(ops::text) <= 1048576),
	-- SHA-256 hex of the ops as RFC 8785 canonical JSON (engine canonicalJson),
	-- written by the API with the ops; the run snapshot carries the same hash.
	ops_sha256     text NOT NULL CHECK (ops_sha256 ~ '^[0-9a-f]{64}$'),
	-- Whose proposal this is: the nodes that belong to the proposer (their
	-- farms). An op on one is a proposal; anything else a baseline assumption
	-- (engine classifyOp). WP-3.3 derives it for applicants from their links.
	owned_node_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(owned_node_ids) <= 500),
	-- Set from the session by scenario_guard; never changes.
	owner_user_id  uuid NOT NULL REFERENCES app_user(id),
	status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'withdrawn', 'decided')),
	created_at     timestamptz NOT NULL DEFAULT now(),
	updated_at     timestamptz NOT NULL DEFAULT now()
);
-- Names are unique per project, ignoring case. Also covers the project_id
-- foreign key (catalogue.db.test.ts).
CREATE UNIQUE INDEX scenario_name_idx ON scenario (project_id, lower(btrim(name)));
CREATE INDEX scenario_base_run_idx ON scenario (base_run_id);
CREATE INDEX scenario_owner_idx ON scenario (owner_user_id);

COMMENT ON TABLE scenario IS
	'A named, ordered list of overrides (engine ScenarioOp) on a base run, run and compared without copying the project (024_scenarios, WP-3.2). Its base run is cited, so kept (model_run_cited).';
COMMENT ON COLUMN scenario.owned_node_ids IS 'The proposer''s own nodes: ops on them are proposals, the rest baseline assumptions (engine classifyOp).';
COMMENT ON COLUMN scenario.status IS 'draft → submitted → withdrawn | decided; withdrawn → draft. Ops, base and owned nodes change only while draft (scenario_guard).';

-- Stamp the owner and times, check the base run, freeze a submitted scenario.
-- SECURITY DEFINER: it reads model_run past RLS to check the base is a run of
-- the same project (and so doesn't depend on what the caller can see).
CREATE FUNCTION scenario_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		run_project uuid;
		run_scenario uuid;
	BEGIN
		IF TG_OP = 'DELETE' THEN
			IF OLD.status IN ('submitted', 'decided') THEN
				RAISE EXCEPTION 'a % scenario can''t be deleted', OLD.status USING ERRCODE = 'check_violation';
			END IF;
			RETURN OLD;
		END IF;
		IF TG_OP = 'INSERT' THEN
			NEW.owner_user_id := app_current_user_id();
			IF NEW.owner_user_id IS NULL THEN
				RAISE EXCEPTION 'a scenario needs a signed-in user' USING ERRCODE = 'insufficient_privilege';
			END IF;
			IF NEW.status <> 'draft' THEN
				RAISE EXCEPTION 'a new scenario is a draft' USING ERRCODE = 'check_violation';
			END IF;
			NEW.created_at := now();
		ELSE
			IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
			   OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
				RAISE EXCEPTION 'a scenario''s project, owner and creation time never change' USING ERRCODE = 'check_violation';
			END IF;
			IF OLD.status <> 'draft' AND (NEW.ops IS DISTINCT FROM OLD.ops OR NEW.ops_sha256 IS DISTINCT FROM OLD.ops_sha256
			   OR NEW.base_run_id IS DISTINCT FROM OLD.base_run_id OR NEW.owned_node_ids IS DISTINCT FROM OLD.owned_node_ids) THEN
				RAISE EXCEPTION 'a % scenario is frozen', OLD.status USING ERRCODE = 'check_violation';
			END IF;
			IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
				(OLD.status = 'draft' AND NEW.status = 'submitted')
				OR (OLD.status = 'submitted' AND NEW.status IN ('withdrawn', 'decided'))
				OR (OLD.status = 'withdrawn' AND NEW.status = 'draft')
			) THEN
				RAISE EXCEPTION 'a scenario can''t go from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
			END IF;
		END IF;
		NEW.updated_at := now();
		IF TG_OP = 'INSERT' OR NEW.base_run_id IS DISTINCT FROM OLD.base_run_id THEN
			SELECT project_id, scenario_id INTO run_project, run_scenario FROM model_run WHERE id = NEW.base_run_id;
			IF run_project IS DISTINCT FROM NEW.project_id THEN
				RAISE EXCEPTION 'run % belongs to a different project', NEW.base_run_id USING ERRCODE = 'foreign_key_violation';
			END IF;
			-- A base is a run of the model itself, so compare lists every op the
			-- scenario makes against it (a scenario run's own ops would be hidden).
			IF run_scenario IS NOT NULL THEN
				RAISE EXCEPTION 'run % is a scenario run; base a scenario on a run of the model', NEW.base_run_id USING ERRCODE = 'check_violation';
			END IF;
		END IF;
		RETURN NEW;
	END
	$$;

-- ---------------------------------------------------------------------------
-- model_run.scenario_id
-- ---------------------------------------------------------------------------
ALTER TABLE model_run ADD COLUMN scenario_id uuid REFERENCES scenario(id) ON DELETE SET NULL;
COMMENT ON COLUMN model_run.scenario_id IS
	'The scenario that produced this run (024_scenarios); NULL for a run of the live model, or once the scenario is deleted (the run''s inputs.scenario still records its ops). Set on insert only.';
-- Covers the foreign key; only scenario runs have one.
CREATE INDEX model_run_scenario_idx ON model_run (scenario_id) WHERE scenario_id IS NOT NULL;

CREATE TRIGGER scenario_guard BEFORE INSERT OR UPDATE OR DELETE ON scenario
	FOR EACH ROW EXECUTE FUNCTION scenario_guard();

-- A run's scenario is one of its own project's.
CREATE FUNCTION model_run_scenario_same_project() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NEW.scenario_id IS NOT NULL
		   AND (SELECT project_id FROM scenario WHERE id = NEW.scenario_id) IS DISTINCT FROM NEW.project_id THEN
			RAISE EXCEPTION 'scenario % belongs to a different project', NEW.scenario_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		RETURN NEW;
	END
	$$;
-- INSERT only: water_app has no UPDATE on the column (the grants on model_run
-- are notes and pinned), and ON DELETE SET NULL only clears it.
CREATE TRIGGER model_run_scenario_same_project BEFORE INSERT ON model_run
	FOR EACH ROW EXECUTE FUNCTION model_run_scenario_same_project();

-- ---------------------------------------------------------------------------
-- RLS and grants. Read: a viewer. Write: an editor. Farmers: nothing (no
-- policy names them, so the viewer floor refuses them).
-- ---------------------------------------------------------------------------
ALTER TABLE scenario ENABLE ROW LEVEL SECURITY;
CREATE POLICY scenario_select ON scenario FOR SELECT USING (app_has_role(project_id, 'viewer'));
CREATE POLICY scenario_insert ON scenario FOR INSERT WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY scenario_update ON scenario FOR UPDATE
	USING (app_has_role(project_id, 'editor')) WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY scenario_delete ON scenario FOR DELETE USING (app_has_role(project_id, 'editor'));

GRANT SELECT, INSERT, UPDATE, DELETE ON scenario TO water_app;

-- ---------------------------------------------------------------------------
-- A scenario cites its base run (021_series_blob's hook). Latest body:
-- 022_publication's publication clause, kept as it was. Same signature,
-- SECURITY DEFINER and search_path. A later citing table ORs its own EXISTS
-- onto this body.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION model_run_cited(p_run uuid) RETURNS boolean
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$ SELECT EXISTS (SELECT 1 FROM run_publication p WHERE p.run_id = p_run)
		OR EXISTS (SELECT 1 FROM scenario s WHERE s.base_run_id = p_run) $$;

COMMENT ON FUNCTION model_run_cited(uuid) IS
	'True for a run a publication (022_publication) or a scenario (024_scenarios) cites; evidence packs and assessments add their own EXISTS clause. Part of RUN_KEPT_SQL in backend/src/runs/execute.ts.';

-- ---------------------------------------------------------------------------
-- The publication-history cap, from its latest body (022_publication), now
-- also sparing a publication whose run a scenario is based on. The run is
-- kept by the scenario either way; this keeps the record that it was
-- published (and when, under which notice), which a scenario's base banner
-- and WP-3.3's "an applicant's base must be a published run" rest on. So a
-- project keeps its newest 12 publications plus those of scenario bases.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION run_publication_cap() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		DELETE FROM run_publication WHERE id IN (
			SELECT id FROM run_publication
			WHERE project_id = NEW.project_id
			ORDER BY published_at DESC, id DESC
			OFFSET 12
		) AND superseded_at IS NOT NULL
		  AND NOT EXISTS (SELECT 1 FROM scenario s WHERE s.base_run_id = run_publication.run_id);
		RETURN NULL;
	END
	$$;

-- ---------------------------------------------------------------------------
-- The pin ceiling counts only pins that keep something: a cited run is kept
-- anyway, so pinning it costs nothing and it doesn't count against the 10
-- (PINNED_RUNS_PER_PROJECT_MAX). Latest body: 015_run_pinned.sql.
-- A run pinned while cited keeps its pin when it stops being cited, so a
-- project can then hold more than 10 counted pins; the next pin is refused
-- until it is back under.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION model_run_pin_limit() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NEW.pinned AND NOT OLD.pinned AND NOT model_run_cited(NEW.id) THEN
			-- One pin at a time per project, so the count below can't race.
			PERFORM pg_advisory_xact_lock(hashtextextended('model_run_pin:' || NEW.project_id::text, 0));
			IF (SELECT count(*) FROM model_run WHERE project_id = NEW.project_id AND pinned AND NOT model_run_cited(id)) >= 10 THEN
				RAISE EXCEPTION 'the project has reached its pinned-run limit' USING ERRCODE = 'check_violation';
			END IF;
		END IF;
		RETURN NEW;
	END
	$$;

-- ---------------------------------------------------------------------------
-- run_series: a node is one of the run's own nodes, not a live one.
--
-- 001 made run_series.node_id a foreign key to node (ON DELETE CASCADE) and
-- checked it was a node of the same project. That breaks two things runs now
-- promise: a scenario run stores series for nodes the live model never had
-- (node.add), and deleting a node from the live model silently deleted its
-- series from every earlier run, so a kept or cited run lost part of its
-- results. A run's series now name nodes of the run's own model snapshot
-- (model_run.inputs.model.nodes), checked once per statement.
-- ---------------------------------------------------------------------------
ALTER TABLE run_series DROP CONSTRAINT run_series_node_id_fkey;
DROP TRIGGER run_series_same_project ON run_series;
-- Nothing looks series up by node alone (every query leads with run_id, the
-- unique index), and there is no foreign key left to cover.
DROP INDEX run_series_node_idx;

CREATE FUNCTION run_series_nodes_in_run() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		bad record;
	BEGIN
		-- Each run's node ids once per statement (a run's snapshot is read once,
		-- not once per series row).
		WITH ids AS MATERIALIZED (
			SELECT r.id AS run_id, n->>'id' AS node_id
			FROM model_run r
			CROSS JOIN LATERAL jsonb_array_elements(r.inputs->'model'->'nodes') n
			WHERE r.id IN (SELECT run_id FROM changed WHERE node_id IS NOT NULL)
		)
		SELECT s.run_id, s.node_id INTO bad
		FROM changed s
		WHERE NOT EXISTS (SELECT 1 FROM model_run r WHERE r.id = s.run_id AND r.project_id = s.project_id)
		   OR (s.node_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ids WHERE ids.run_id = s.run_id AND ids.node_id = s.node_id::text))
		LIMIT 1;
		IF FOUND THEN
			RAISE EXCEPTION 'node % is not a node of run %', bad.node_id, bad.run_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		RETURN NULL;
	END
	$$;
-- One event per trigger (a transition table allows no more).
CREATE TRIGGER run_series_nodes_in_run_insert AFTER INSERT ON run_series
	REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION run_series_nodes_in_run();
CREATE TRIGGER run_series_nodes_in_run_update AFTER UPDATE ON run_series
	REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION run_series_nodes_in_run();
