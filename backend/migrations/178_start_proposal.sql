-- 178_start_proposal — starting a model from the map (issue #326 C3 and the
-- B-delineate stretch, sub-catchments at every dam and abstraction point;
-- docs/design/start-from-map.md, docs/maps.md § Start from the map,
-- docs/data-model.md § Catchment map). Numbered 178 by assignment: 176 was reserved
-- for delineation (unused) and 177 is #326 C2's (assisted drawing), so the gap is deliberate.
--
-- In this file:
--  * start_proposal: what the server proposed for one project's empty
--    model from its map (the units at its dams and abstraction points, their
--    sub-catchments' areas and outlines, who drains into whom, the rest of
--    the catchment, the outlet), as one jsonb snapshot `plan` with the
--    dataset and method it came from; and what the editor decided, as
--    another, `decision` (each value ticked or not, the nodes and parcels
--    made, the model revision). The server computes the plan
--    (backend/src/delineation/start.ts); it reaches the model only through
--    apply, one ticked value at a time. A new proposal supersedes the
--    project's open one, so at most one is open.
--  * RLS: viewers read a project's proposals; editors propose and decide.
--    An applied proposal stays on record (the model's provenance) until its
--    project goes; superseded and discarded ones beyond the newest 50 are
--    pruned by the route that adds one (editors may delete). A decision is
--    final (the trigger below).
--  * No node column, so no farmer policy: farmers never read proposals.

CREATE TABLE start_proposal (
	id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id       uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	status           text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'applied', 'discarded', 'superseded')),
	-- The proposal as the editor saw it (start.ts StartPlan): bounded, since a project has at most 50 points and every polygon passed checkGeometry.
	plan             jsonb NOT NULL CHECK (jsonb_typeof(plan) = 'object' AND pg_column_size(plan) < 4000000),
	-- Whether the plan came from the elevation model (false: the points only, nothing delineated).
	from_dem         boolean NOT NULL,
	-- The DEM: its label and fingerprint (NULL without one), and the method.
	dataset          text CHECK (dataset IS NULL OR char_length(dataset) BETWEEN 1 AND 200),
	dataset_fingerprint text CHECK (dataset_fingerprint IS NULL OR dataset_fingerprint ~ '^[0-9a-f]{16}$'),
	method           text NOT NULL CHECK (char_length(method) BETWEEN 1 AND 1000),
	method_version   text NOT NULL CHECK (char_length(method_version) BETWEEN 1 AND 50),
	-- What apply did with it (start.ts StartDecision): the ticks, the nodes and parcels made, the revision. NULL until applied.
	decision         jsonb CHECK (decision IS NULL OR (jsonb_typeof(decision) = 'object' AND pg_column_size(decision) < 1000000)),
	created_by       uuid REFERENCES app_user(id) ON DELETE SET NULL,
	created_at       timestamptz NOT NULL DEFAULT now(),
	decided_by       uuid REFERENCES app_user(id) ON DELETE SET NULL,
	decided_at       timestamptz,
	CHECK (from_dem = (dataset IS NOT NULL) AND from_dem = (dataset_fingerprint IS NOT NULL)),
	CHECK ((status IN ('proposed', 'superseded')) = (decided_at IS NULL)),
	CHECK ((status = 'applied') = (decision IS NOT NULL))
);
-- The project's latest proposals (also covers the project_id foreign key).
CREATE INDEX start_proposal_project_idx ON start_proposal (project_id, created_at DESC);
-- At most one open proposal per project: a new one supersedes it (start.ts).
CREATE UNIQUE INDEX start_proposal_one_open_idx ON start_proposal (project_id) WHERE status = 'proposed';
CREATE INDEX start_proposal_created_by_idx ON start_proposal (created_by);
CREATE INDEX start_proposal_decided_by_idx ON start_proposal (decided_by);

COMMENT ON TABLE start_proposal IS
	'A model proposed from a project''s map (units at its dams and abstraction points, their sub-catchments, the order), with its dataset and method, and the editor''s decision value by value (178, issue #326 C3). It reaches the model only through apply.';

-- A decision is final (the one-way-event columns, final-columns.security.db.test.ts):
-- once applied or discarded, the status, decision, decided_at and decided_by never
-- change, except decided_by cleared by its foreign key when that account is
-- deleted. The plan never changes. A superseded proposal stays superseded.
CREATE FUNCTION start_proposal_final() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF NEW.plan IS DISTINCT FROM OLD.plan THEN
			RAISE EXCEPTION 'a start proposal''s plan stays as proposed' USING ERRCODE = 'check_violation';
		END IF;
		IF OLD.decided_at IS NOT NULL AND (
			NEW.status IS DISTINCT FROM OLD.status
			OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
			OR NEW.decision IS DISTINCT FROM OLD.decision
			OR (NEW.decided_by IS DISTINCT FROM OLD.decided_by
				AND (NEW.decided_by IS NOT NULL OR EXISTS (SELECT 1 FROM app_user u WHERE u.id = OLD.decided_by)))
		) THEN
			RAISE EXCEPTION 'a start proposal is decided once, and the decision stays' USING ERRCODE = 'check_violation';
		END IF;
		IF OLD.status = 'superseded' AND NEW.status IS DISTINCT FROM 'superseded' THEN
			RAISE EXCEPTION 'a superseded start proposal stays superseded' USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER start_proposal_final BEFORE UPDATE ON start_proposal
	FOR EACH ROW EXECUTE FUNCTION start_proposal_final();

ALTER TABLE start_proposal ENABLE ROW LEVEL SECURITY;
CREATE POLICY start_proposal_select ON start_proposal FOR SELECT USING (app_has_role(project_id, 'viewer'));
CREATE POLICY start_proposal_insert ON start_proposal FOR INSERT WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY start_proposal_update ON start_proposal FOR UPDATE
	USING (app_has_role(project_id, 'editor')) WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY start_proposal_delete ON start_proposal FOR DELETE USING (app_has_role(project_id, 'editor'));

GRANT SELECT, INSERT, UPDATE, DELETE ON start_proposal TO water_app;
