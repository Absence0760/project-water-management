-- 219_allocation_holder_keys — count the holders behind every "5 or more
-- registered users" total from the rows summed into it, with keys no reader
-- can tie to a name, frozen with each run (issue #523 G/N/P, decision D3;
-- docs/security.md § Allocations, docs/allocations.md § Who sees what).
--
-- 162's app_allocation_volumes counts a water source's holders over all of
-- its rows, whatever their dates, but the totals the API sums from it are of
-- the rows in force on a day; and the evidence report's § 5 counted units,
-- not holders. So each row now carries a holder key, the caller counts the
-- holders (and their shares: the dominance rule, engine allocations/holders.ts)
-- of the rows it actually sums, and a run keeps the keys of its own rows as
-- they were when it ran:
--
--  1. allocation_holder_salt: one random salt per project (two
--     gen_random_uuid()s, from the server's strong random source), made when
--     the project is (allocation_holder_salt_new) and for every project here.
--     Owner-only: no grant, no policy; only the definer functions below read
--     it, and it never leaves the database. A key is md5(salt || holder key),
--     so knowing the project and a list of candidate names gives nothing to
--     match the keys against (#523 P: an md5 of the project id and the name
--     could be).
--  2. app_allocation_holder_keys(project): internal (not SECURITY DEFINER, no
--     grant): every row of the project with its holder key, holders counted as
--     162 counts them (the name ignoring case and spaces, else a name another
--     row of the same unit carries, else the unit, else the row).
--  3. app_allocation_volumes(project): 162's, by its latest definition (162),
--     plus `holder` (that key). Its return type changes, so it is dropped and
--     created again, with 162's grants.
--  4. run_allocation_holder: each run's allocation rows' holder keys, written
--     when the run is stored (model_run_allocation_holders, AFTER INSERT) from
--     the rows as they are then; a row with no living key (one a scenario op
--     adds) gets the one key 'gone', so such rows add at most one holder
--     (#523 N: a row deleted after the run took a later holder's key, or its
--     unit's, so one holder's deleted rows on 5 units counted as 5). Existing
--     runs are filled here from the rows living now, the same way.
--     Owner-only, like the salt.
--  5. app_run_allocation_holders(project, run, ids): the keys of the given
--     rows of one run, for a member from viewer up who can read that run
--     (model_run_select's rule, 046), for the evidence report's § 5 gate and
--     the authorised mix (the API never returns them). It replaces the
--     round-3 app_allocation_holders, which handed any viewer every row of
--     the project (#523 P).
--  6. Erasure (POPIA): a key is a pseudonym of the holder's name, and the
--     owner holds the salt. When a name leaves the project (its last
--     allocation_holder row with that name is deleted, by deleting the row,
--     undoing its import or clearing the holder, or renamed),
--     allocation_holder_erased resets every frozen run key of it to 'gone'.

-- ---------------------------------------------------------------------------
-- 1. The salt
-- ---------------------------------------------------------------------------
CREATE TABLE allocation_holder_salt (
	project_id uuid PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
	salt       text NOT NULL DEFAULT (gen_random_uuid()::text || gen_random_uuid()::text)
);
ALTER TABLE allocation_holder_salt ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON allocation_holder_salt FROM PUBLIC, water_app;
COMMENT ON TABLE allocation_holder_salt IS
	'Owner-only (219, #523 P): each project''s salt for the allocation holder keys. Read only by the SECURITY DEFINER functions of 219; never leaves the database.';
INSERT INTO allocation_holder_salt (project_id) SELECT id FROM project ON CONFLICT DO NOTHING;

CREATE FUNCTION allocation_holder_salt_new() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		INSERT INTO allocation_holder_salt (project_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
		RETURN NULL;
	END
	$$;
REVOKE ALL ON FUNCTION allocation_holder_salt_new() FROM PUBLIC, water_app;
CREATE TRIGGER allocation_holder_salt_new AFTER INSERT ON project
	FOR EACH ROW EXECUTE FUNCTION allocation_holder_salt_new();

-- ---------------------------------------------------------------------------
-- 2. Each row's holder key
-- ---------------------------------------------------------------------------
-- A holder's name as 162 compares names: case and runs of spaces ignored; NULL for none.
CREATE FUNCTION allocation_holder_norm(p_name text) RETURNS text
	LANGUAGE sql IMMUTABLE SET search_path = public
	AS $$ SELECT nullif(lower(regexp_replace(btrim(p_name), '\s+', ' ', 'g')), '') $$;
-- Pure and invoker: water_app evaluates it when it writes allocation_holder (the index below).
REVOKE ALL ON FUNCTION allocation_holder_norm(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION allocation_holder_norm(text) TO water_app;
-- The erasure trigger (6) asks per deleted row whether the name is still on another row of the project: indexed, so
-- undoing a large import stays O(n log n) rather than a regex over every holder row per deleted row.
CREATE INDEX allocation_holder_norm_idx ON allocation_holder (project_id, allocation_holder_norm(user_display));

-- One pass over the project's rows (a window, not a subquery per row), so the backfill below is linear.
CREATE FUNCTION app_allocation_holder_keys(p_project uuid)
	RETURNS TABLE (id uuid, node_id uuid, water_source text, holder text)
	LANGUAGE sql STABLE SET search_path = public
	AS $$
		WITH named AS (
			SELECT a.id, a.node_id, a.water_source, allocation_holder_norm(h.user_display) AS name
			FROM allocation a LEFT JOIN allocation_holder h ON h.allocation_id = a.id
			WHERE a.project_id = p_project
		), unit AS (
			-- A name another row of the same unit carries (min, as 162); none for a row on no unit.
			SELECT x.*, CASE WHEN x.node_id IS NULL THEN NULL ELSE min(x.name) OVER (PARTITION BY x.node_id) END AS unit_name
			FROM named x
		)
		SELECT u.id, u.node_id, u.water_source, md5(s.salt || coalesce('h:' || u.name, 'h:' || u.unit_name, 'n:' || u.node_id::text, 'a:' || u.id::text))
		FROM unit u JOIN allocation_holder_salt s ON s.project_id = p_project
	$$;
COMMENT ON FUNCTION app_allocation_holder_keys(uuid) IS
	'Internal (219, #523 G/P): each allocation row of a project with its holder key, md5 of the project''s salt and the holder as 162 counts them. Called only by 219''s definer functions and trigger.';
REVOKE ALL ON FUNCTION app_allocation_holder_keys(uuid) FROM PUBLIC, water_app;

-- ---------------------------------------------------------------------------
-- 3. The volumes behind a viewer's totals, each with its holder
-- ---------------------------------------------------------------------------
-- Latest definition: 162_allocation_viewer_units.sql. Adds `holder`.
DROP FUNCTION app_allocation_volumes(uuid);
CREATE FUNCTION app_allocation_volumes(p_project uuid)
	RETURNS TABLE (water_source text, holders integer, holder text, node_id uuid, volume_m3_year double precision, storage_m3 double precision,
		water_use text, valid_from date, valid_to date)
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	BEGIN
		IF NOT app_has_role(p_project, 'viewer') THEN
			RAISE EXCEPTION 'not a member of this project' USING ERRCODE = 'insufficient_privilege';
		END IF;
		RETURN QUERY
		WITH h AS (
			SELECT * FROM app_allocation_holder_keys(p_project)
		), k AS (
			SELECT h.water_source, count(DISTINCT h.holder)::integer AS holders FROM h GROUP BY h.water_source
		)
		SELECT a.water_source, k.holders, h.holder, a.node_id, a.volume_m3_year, a.storage_m3, a.water_use, a.valid_from, a.valid_to
		FROM allocation a
		JOIN h ON h.id = a.id
		JOIN k ON k.water_source = a.water_source
		WHERE a.project_id = p_project AND k.holders >= 5
		ORDER BY a.water_source, a.id;
	END
	$$;
COMMENT ON FUNCTION app_allocation_volumes(uuid) IS
	'The volumes behind a viewer''s registered-water totals (162, D3; 219): each water source held by at least 5 registered users (FARMER_K), each row with its salted holder key so the API counts the holders (and their shares) of the rows it sums. No name, number or property. The API sums them; it never returns a row.';
REVOKE ALL ON FUNCTION app_allocation_volumes(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_allocation_volumes(uuid) TO water_app;

-- ---------------------------------------------------------------------------
-- 4. Each run's holder keys, frozen when it is stored
-- ---------------------------------------------------------------------------
CREATE TABLE run_allocation_holder (
	run_id        uuid NOT NULL REFERENCES model_run(id) ON DELETE CASCADE,
	allocation_id text NOT NULL,
	holder        text NOT NULL,
	PRIMARY KEY (run_id, allocation_id)
);
ALTER TABLE run_allocation_holder ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON run_allocation_holder FROM PUBLIC, water_app;
COMMENT ON TABLE run_allocation_holder IS
	'Owner-only (219, #523 N): the holder key of each allocation row in a run''s input, as the rows were when it was stored; ''gone'' for a row with no living key. Written by model_run_allocation_holders, read by app_run_allocation_holders.';

-- The keys of a run's rows: the living row's, else the one key 'gone'.
CREATE FUNCTION run_allocation_holder_fill(p_project uuid, p_run uuid, p_inputs jsonb) RETURNS void
	LANGUAGE sql SET search_path = public
	AS $$
		INSERT INTO run_allocation_holder (run_id, allocation_id, holder)
		SELECT p_run, e->>'id', coalesce(k.holder, 'gone')
		FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_inputs->'model'->'allocations') = 'array' THEN p_inputs->'model'->'allocations' ELSE '[]'::jsonb END) e
		LEFT JOIN app_allocation_holder_keys(p_project) k ON k.id::text = e->>'id'
		WHERE e->>'id' IS NOT NULL
		ON CONFLICT DO NOTHING
	$$;
REVOKE ALL ON FUNCTION run_allocation_holder_fill(uuid, uuid, jsonb) FROM PUBLIC, water_app;

CREATE FUNCTION model_run_allocation_holders() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		PERFORM run_allocation_holder_fill(NEW.project_id, NEW.id, NEW.inputs);
		RETURN NULL;
	END
	$$;
REVOKE ALL ON FUNCTION model_run_allocation_holders() FROM PUBLIC, water_app;
CREATE TRIGGER model_run_allocation_holders AFTER INSERT ON model_run
	FOR EACH ROW EXECUTE FUNCTION model_run_allocation_holders();

-- Existing runs, from the rows living now (a run stored before 219 has no other record of them): every project's keys
-- once, then one join, so the cost is the runs' rows, not runs × the project's rows.
CREATE TEMP TABLE keys_219 ON COMMIT DROP AS
	SELECT k.id::text AS id, k.holder FROM project p CROSS JOIN LATERAL app_allocation_holder_keys(p.id) k;
CREATE INDEX ON keys_219 (id);
INSERT INTO run_allocation_holder (run_id, allocation_id, holder)
SELECT r.id, e->>'id', coalesce(k.holder, 'gone')
FROM model_run r
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.inputs->'model'->'allocations') = 'array' THEN r.inputs->'model'->'allocations' ELSE '[]'::jsonb END) e
LEFT JOIN keys_219 k ON k.id = e->>'id'
WHERE e->>'id' IS NOT NULL
ON CONFLICT DO NOTHING;
CREATE INDEX run_allocation_holder_holder_idx ON run_allocation_holder (holder);

-- ---------------------------------------------------------------------------
-- 5. A run's keys, for the evidence report and the authorised mix
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_run_allocation_holders(p_project uuid, p_run uuid, p_ids text[])
	RETURNS TABLE (allocation_id text, holder text)
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	BEGIN
		IF NOT app_has_role(p_project, 'viewer') THEN
			RAISE EXCEPTION 'not a member of this project' USING ERRCODE = 'insufficient_privilege';
		END IF;
		-- Only a run the caller can read: model_run_select's rule (latest: 046), as this definer reads past it.
		IF NOT EXISTS (SELECT 1 FROM model_run r WHERE r.id = p_run AND r.project_id = p_project AND (r.scenario_id IS NULL OR app_scenario_readable(r.scenario_id))) THEN
			RETURN;
		END IF;
		RETURN QUERY
		SELECT h.allocation_id, h.holder
		FROM run_allocation_holder h
		WHERE h.run_id = p_run AND h.allocation_id = ANY(p_ids)
		ORDER BY h.allocation_id;
	END
	$$;
COMMENT ON FUNCTION app_run_allocation_holders(uuid, uuid, text[]) IS
	'The holder keys of the given allocation rows of one run the caller can read (219, #523 G/N/P), as frozen when it was stored: the evidence report''s § 5 gate and the authorised mix count holders by them, the same for every reader. No volume; the API never returns them.';
REVOKE ALL ON FUNCTION app_run_allocation_holders(uuid, uuid, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_run_allocation_holders(uuid, uuid, text[]) TO water_app;

-- ---------------------------------------------------------------------------
-- 6. Erasure: a name that leaves the project leaves the runs' keys too
-- ---------------------------------------------------------------------------
CREATE FUNCTION allocation_holder_erased() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_name text := allocation_holder_norm(OLD.user_display);
		v_salt text;
	BEGIN
		IF v_name IS NULL OR (TG_OP = 'UPDATE' AND allocation_holder_norm(NEW.user_display) IS NOT DISTINCT FROM v_name) THEN
			RETURN NULL;
		END IF;
		-- Another row of the project still carries the name: it hasn't left.
		IF EXISTS (SELECT 1 FROM allocation_holder h WHERE h.project_id = OLD.project_id AND allocation_holder_norm(h.user_display) = v_name) THEN
			RETURN NULL;
		END IF;
		SELECT s.salt INTO v_salt FROM allocation_holder_salt s WHERE s.project_id = OLD.project_id;
		IF v_salt IS NULL THEN
			RETURN NULL; -- the project itself is going
		END IF;
		UPDATE run_allocation_holder h SET holder = 'gone'
			FROM model_run r
			WHERE h.holder = md5(v_salt || 'h:' || v_name) AND r.id = h.run_id AND r.project_id = OLD.project_id;
		RETURN NULL;
	END
	$$;
REVOKE ALL ON FUNCTION allocation_holder_erased() FROM PUBLIC, water_app;
CREATE TRIGGER allocation_holder_erased AFTER DELETE OR UPDATE OF user_display ON allocation_holder
	FOR EACH ROW EXECUTE FUNCTION allocation_holder_erased();
