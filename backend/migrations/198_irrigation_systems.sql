-- 198_irrigation_systems — a project's irrigation-systems table, a crop's
-- default system and each unit's own system for a crop (engine 1.72.0;
-- docs/model.md §2.3, docs/data-model.md § irrigation_system).
--
-- Before, a crop could carry one efficiency for every unit (061) and each unit
-- one of its own (006). The client's hydrologist (2026-10-03) wants each crop
-- on an irrigation system, which can differ by unit, from a table the project
-- owns: the SABI 2021 systems (Table 4), whose efficiencies the hydrologist
-- may change, plus rows of the project's own.
--
-- In this file:
--  * irrigation_system: per project, a name and an efficiency (0 < e <= 1),
--    `preset` naming the SABI system a row started as (NULL for the project's
--    own). Read by anyone with a role on the project (farmer and up: it holds
--    nothing personal, and a farmer's farm view names its crops' systems),
--    written by editors. A trigger seeds every new project with the six SABI
--    rows, so every way a project is made (the API, an import, a copy, a test)
--    has them.
--  * crop.irrigation_system_id (the crop's default) and
--    crop_area.irrigation_system_id (this unit's own; NULL = the crop's),
--    ON DELETE SET NULL, each with its covering index, held to the same
--    project by assert_same_project (rewritten from 115, its latest
--    definition, with an %irrigation_system_id branch).
--  * The backfill, so every saved model runs as before: each project gets the
--    six SABI rows; each efficiency in use that matches none of them gets a
--    row "Imported, NN %"; a crop with its own efficiency (061) gets the row
--    for it as its default; a planting on a farm whose crop has none gets the
--    row for its unit's efficiency as its own. crop.irrigation_efficiency is
--    dropped. node.irrigation_efficiency stays: the engine's fallback for a
--    planting with no system (an older document), shown read-only as the
--    blend of the unit's plantings in the app.
--  * node_return_flow_within_losses (197) dropped: the return flow is held to
--    1 - the unit's blended efficiency, which depends on its plantings and
--    the A-pan, so the API checks it (model/routes.ts) and a run caps it.

CREATE TABLE irrigation_system (
	id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id  uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
	efficiency  double precision NOT NULL CHECK (efficiency > 0 AND efficiency <= 1),
	preset      text CHECK (preset IN ('drip', 'micro', 'pivot', 'sprinkler', 'movable', 'surface')),
	sort_order  integer NOT NULL DEFAULT 0
);
CREATE INDEX irrigation_system_project_idx ON irrigation_system (project_id);

COMMENT ON TABLE irrigation_system IS
	'A project''s irrigation systems: what a crop (its default) or a unit''s planting of it runs at. Seeded with the SABI 2021 Table 4 systems (preset); the hydrologist may change any efficiency and add rows. Engine >= 1.72.0, docs/model.md 2.3.';
COMMENT ON COLUMN irrigation_system.efficiency IS
	'Application efficiency e (0 < e <= 1): a crop on the system abstracts its requirement / e.';
COMMENT ON COLUMN irrigation_system.preset IS
	'The SABI system (engine IRRIGATION_SYSTEMS id) the row started as, for its range beside it; NULL for a row of the project''s own.';

ALTER TABLE irrigation_system ENABLE ROW LEVEL SECURITY;
CREATE POLICY irrigation_system_select ON irrigation_system FOR SELECT USING (app_has_role(project_id, 'farmer'));
CREATE POLICY irrigation_system_insert ON irrigation_system FOR INSERT WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY irrigation_system_update ON irrigation_system FOR UPDATE USING (app_has_role(project_id, 'editor')) WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY irrigation_system_delete ON irrigation_system FOR DELETE USING (app_has_role(project_id, 'editor'));
GRANT SELECT, INSERT, UPDATE, DELETE ON irrigation_system TO water_app;

-- The SABI 2021 systems (engine IRRIGATION_SYSTEMS), for a new project and the backfill.
CREATE FUNCTION irrigation_system_seed(p_project uuid) RETURNS void
	LANGUAGE sql SECURITY DEFINER SET search_path = public
	AS $$
		INSERT INTO irrigation_system (project_id, name, efficiency, preset, sort_order) VALUES
			(p_project, 'Drip', 0.9, 'drip', 0),
			(p_project, 'Micro-sprinkler', 0.82, 'micro', 1),
			(p_project, 'Centre pivot / linear move', 0.85, 'pivot', 2),
			(p_project, 'Sprinkler (permanent)', 0.8, 'sprinkler', 3),
			(p_project, 'Sprinkler (movable)', 0.75, 'movable', 4),
			(p_project, 'Flood / furrow', 0.7, 'surface', 5);
	$$;

CREATE FUNCTION project_seed_irrigation_systems() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		PERFORM irrigation_system_seed(NEW.id);
		RETURN NEW;
	END
	$$;
CREATE TRIGGER project_irrigation_systems AFTER INSERT ON project
	FOR EACH ROW EXECUTE FUNCTION project_seed_irrigation_systems();

ALTER TABLE crop ADD COLUMN irrigation_system_id uuid REFERENCES irrigation_system(id) ON DELETE SET NULL;
CREATE INDEX crop_irrigation_system_idx ON crop (irrigation_system_id);
COMMENT ON COLUMN crop.irrigation_system_id IS
	'The crop''s default irrigation system (engine >= 1.72.0); a unit''s planting may name another (crop_area.irrigation_system_id).';

ALTER TABLE crop_area ADD COLUMN irrigation_system_id uuid REFERENCES irrigation_system(id) ON DELETE SET NULL;
CREATE INDEX crop_area_irrigation_system_idx ON crop_area (irrigation_system_id);
COMMENT ON COLUMN crop_area.irrigation_system_id IS
	'This unit''s irrigation system for the crop (engine >= 1.72.0); NULL = the crop''s default.';

-- assert_same_project, from 115 (its latest definition), with irrigation_system.
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
			ELSIF col LIKE '%pack_id' THEN
				SELECT project_id INTO ref_project FROM evidence_pack WHERE id = ref_id;
			ELSIF col LIKE '%scenario_id' THEN
				SELECT project_id INTO ref_project FROM scenario WHERE id = ref_id;
			ELSIF col LIKE '%irrigation_system_id' THEN
				SELECT project_id INTO ref_project FROM irrigation_system WHERE id = ref_id;
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

DROP TRIGGER crop_area_same_project ON crop_area;
CREATE TRIGGER crop_area_same_project BEFORE INSERT OR UPDATE ON crop_area
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('node_id', 'crop_id', 'irrigation_system_id');
CREATE TRIGGER crop_same_project BEFORE INSERT OR UPDATE ON crop
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('irrigation_system_id');

-- The backfill. Every project gets the SABI rows.
SELECT irrigation_system_seed(id) FROM project;

-- Each efficiency in use (a crop's own; a farm's, where it plants a crop without one) that no row has gets a row.
INSERT INTO irrigation_system (project_id, name, efficiency, preset, sort_order)
SELECT u.project_id, 'Imported, ' || trim(trailing '.' FROM trim(trailing '0' FROM to_char(u.e * 100, 'FM990.0'))) || ' %', u.e, NULL,
	6 + row_number() OVER (PARTITION BY u.project_id ORDER BY u.e DESC)
FROM (
	SELECT DISTINCT project_id, irrigation_efficiency AS e FROM crop WHERE irrigation_efficiency IS NOT NULL
	UNION
	SELECT DISTINCT ca.project_id, n.irrigation_efficiency
	FROM crop_area ca JOIN node n ON n.id = ca.node_id JOIN crop c ON c.id = ca.crop_id
	WHERE n.kind = 'farm' AND c.irrigation_efficiency IS NULL
) u
WHERE NOT EXISTS (SELECT 1 FROM irrigation_system s WHERE s.project_id = u.project_id AND s.efficiency = u.e);

-- The row for a value: a SABI one first (sort_order), else the project's own.
UPDATE crop c SET irrigation_system_id = (
	SELECT s.id FROM irrigation_system s WHERE s.project_id = c.project_id AND s.efficiency = c.irrigation_efficiency ORDER BY s.sort_order LIMIT 1
) WHERE c.irrigation_efficiency IS NOT NULL;

-- A crop without its own efficiency ran at each farm's: the row for it, per planting.
CREATE TEMP TABLE planting_system_198 AS
SELECT ca.node_id, ca.crop_id, (
	SELECT s.id FROM irrigation_system s WHERE s.project_id = ca.project_id AND s.efficiency = n.irrigation_efficiency ORDER BY s.sort_order LIMIT 1
) AS system_id
FROM crop_area ca JOIN node n ON n.id = ca.node_id JOIN crop c ON c.id = ca.crop_id
WHERE n.kind = 'farm' AND c.irrigation_efficiency IS NULL;

-- One row for all of a crop's plantings: that is the crop's default, and no planting needs its own.
UPDATE crop c SET irrigation_system_id = p.system_id
FROM (SELECT crop_id, (array_agg(system_id))[1] AS system_id FROM planting_system_198 GROUP BY crop_id HAVING count(DISTINCT system_id) = 1) p
WHERE c.id = p.crop_id;

-- Farms that differ: each planting its farm's.
UPDATE crop_area ca SET irrigation_system_id = p.system_id
FROM planting_system_198 p JOIN crop c ON c.id = p.crop_id
WHERE ca.node_id = p.node_id AND ca.crop_id = p.crop_id AND c.irrigation_system_id IS NULL;

DROP TABLE planting_system_198;

ALTER TABLE crop DROP COLUMN irrigation_efficiency;

ALTER TABLE node DROP CONSTRAINT node_return_flow_within_losses;
COMMENT ON COLUMN node.irrigation_efficiency IS
	'The unit''s own efficiency, 0 < e <= 1: since 198 only the fallback for a planting with no irrigation system (an older document); the app shows the blend of its plantings'' systems. Engine >= 0.16.0.';
