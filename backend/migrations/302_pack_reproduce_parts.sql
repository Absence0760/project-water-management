-- 302_pack_reproduce_parts — the server's re-run of an issued evidence pack
-- runs in parts, each its own job, gathered into the pack's reproduction
-- record (docs/evidence-pack.md § Reproduction, docs/data-model.md § Evidence
-- packs, docs/followups.md "The server re-run's time with the combined row").
--
-- The `pack_reproduce` job (154) re-ran every run of the bundle inside one
-- job's 300 s Lambda. A pack whose § 4 combined row reads a cumulative
-- assessment (bundle-3) re-runs that assessment too, up to 160 firm-yield
-- searches (297): far past one job. Now the `pack_reproduce` job checks the
-- bundle without re-running it (engine planPackBundleReruns) and, when every
-- check passes, fans out: one `pack_reproduce_part` job per part (each run,
-- the headline pair, § 8's pairs, the combined row's assessment, its
-- background, and one firm-yield search per touched dam and run, as 297
-- fans the assessment's out), kept in `pack_reproduce_gathering` and
-- `pack_reproduce_part`. Each part's job, as the same editor, runs its part,
-- stores what it found and, holding a per-gathering lock, records the pack's
-- outcome once every part is back (app_record_pack_reproduction's rules: once
-- per pack and engine, for the bundle the pack records). A bundle that fails
-- a check before any re-run is recorded by the `pack_reproduce` job itself,
-- as before.
--
-- Never hanging: a part whose job stopped without its result (dead, done
-- without it, or purged) fails the gathering, naming the part and why,
-- through the dead job's onDead (app_fail_pack_reproduce, as its user), or
-- the tick's sweep (app_fail_stopped_pack_reproductions) for a death no hook
-- sees (a lease run out with no attempts left, a user no longer an editor).
-- A failed gathering is not an outcome: the pack's page says the re-run
-- couldn't be done, and why, and an editor may re-run it (154's `failed`
-- state), as when the job itself gave up. A worker that timed out is no
-- evidence that the bundle doesn't reproduce, and an outcome stands once per
-- engine.
--
-- Neither table is written by water_app (SELECT only): every row is written
-- by the SECURITY DEFINER functions below, which copy the project from the
-- pack, so no reference crosses projects (cross-project-refs: not writable).
--
-- In this file:
--  * job.kind accepts 'pack_reproduce_part' (latest list: 297_assessment_yield_jobs).
--  * pack_reproduce_gathering, pack_reproduce_part: RLS (whoever reads the
--    pack), SELECT grants, covering indexes. No personal data: check lines.
--  * pack_reproduce_stopped_parts(id): a gathering's stopped parts as lines,
--    in order, or NULL (backend evidence/packReproduceParts.ts
--    stoppedPartsSql). Not callable by water_app.
--  * app_pack_reproduce_fan_out(…): the `pack_reproduce` job's fan-out, from
--    its running job of an issued pack, each part's queued job its own.
--  * app_pack_reproduce_part_done(part, result): a part's result, once,
--    from its own running job.
--  * app_finish_pack_reproduce(gathering, outcome, checks): the outcome,
--    once every part is done, from a running part job of the gathering.
--  * app_fail_pack_reproduce(gathering): failed on its stopped parts, by an
--    editor of the project (a dead part's onDead).
--  * app_fail_stopped_pack_reproductions(): the tick's sweep, the worker only.

-- ---------------------------------------------------------------------------
-- job: the new kind. Latest definition: 297_assessment_yield_jobs.sql.
-- ---------------------------------------------------------------------------
ALTER TABLE job DROP CONSTRAINT job_kind_check;
ALTER TABLE job ADD CONSTRAINT job_kind_check
	CHECK (kind IN ('feed_fetch', 'feed_ingest', 'rerun', 'alert_eval', 'report_render', 'yield', 'sweep', 'outlook', 'auto_calibration',
		'uncertainty', 'pack_render', 'assessment', 'pack_reproduce', 'applicant_pack_render', 'delineate', 'future_yield', 'climate_factors',
		'scenario_run', 'assessment_yield', 'pack_reproduce_part'));

-- ---------------------------------------------------------------------------
-- pack_reproduce_gathering
-- ---------------------------------------------------------------------------
CREATE TABLE pack_reproduce_gathering (
	id             uuid PRIMARY KEY,
	project_id     uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- CASCADE: only a draft is ever deleted, and a draft is never re-run.
	pack_id        uuid NOT NULL REFERENCES evidence_pack(id) ON DELETE CASCADE,
	-- The pack_reproduce job that fanned out; SET NULL when the 30-day purge deletes it.
	job_id         uuid REFERENCES job(id) ON DELETE SET NULL,
	-- The engine the parts re-run with, and the runs' own engines (as pack_reproduction's).
	engine_version text NOT NULL CHECK (length(engine_version) BETWEEN 1 AND 50),
	run_engines    text[] NOT NULL DEFAULT '{}' CHECK (cardinality(run_engines) <= 2),
	bundle_sha256  text NOT NULL CHECK (bundle_sha256 ~ '^[0-9a-f]{64}$'),
	-- The bundle's checks before any re-run, [{ id, ok, detail }]: the parts' are folded into them.
	checks         jsonb NOT NULL CHECK (jsonb_typeof(checks) = 'array' AND octet_length(checks::text) <= 65536),
	-- gathering: parts out. recorded: its outcome is in pack_reproduction. failed: a part stopped (`problems`).
	status         text NOT NULL DEFAULT 'gathering' CHECK (status IN ('gathering', 'recorded', 'failed')),
	problems       jsonb CHECK (problems IS NULL OR (jsonb_typeof(problems) = 'array' AND octet_length(problems::text) <= 65536)),
	created_at     timestamptz NOT NULL DEFAULT now(),
	finished_at    timestamptz,
	CHECK ((status = 'gathering') = (finished_at IS NULL)),
	CHECK ((status = 'failed') = (problems IS NOT NULL))
);
COMMENT ON TABLE pack_reproduce_gathering IS
	'The server''s re-run of an issued evidence pack in parts (302): the bundle''s checks before any re-run, while its pack_reproduce_part jobs run, until the outcome is recorded (pack_reproduction) or a part stopped. Written only by the 302 functions; readable by whoever reads the pack.';

CREATE INDEX pack_reproduce_gathering_pack_idx ON pack_reproduce_gathering (pack_id, created_at);
CREATE INDEX pack_reproduce_gathering_project_idx ON pack_reproduce_gathering (project_id);
CREATE INDEX pack_reproduce_gathering_job_idx ON pack_reproduce_gathering (job_id);
CREATE INDEX pack_reproduce_gathering_pending_idx ON pack_reproduce_gathering (created_at) WHERE status = 'gathering';

-- On insert: the 302 functions update only its status, problems and finish (never the pack), and the 30-day purge its job_id.
CREATE TRIGGER pack_reproduce_gathering_same_project BEFORE INSERT ON pack_reproduce_gathering
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('pack_id');

-- ---------------------------------------------------------------------------
-- pack_reproduce_part
-- ---------------------------------------------------------------------------
CREATE TABLE pack_reproduce_part (
	id            uuid PRIMARY KEY,
	gathering_id  uuid NOT NULL REFERENCES pack_reproduce_gathering(id) ON DELETE CASCADE,
	project_id    uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- Its job; SET NULL when the 30-day purge deletes it (a pending part without one reads as stopped).
	job_id        uuid REFERENCES job(id) ON DELETE SET NULL,
	-- Its place in the plan: the outcome folds the parts in this order.
	position      smallint NOT NULL CHECK (position BETWEEN 0 AND 999),
	-- Which part (engine BundleRerunPart): { kind, … }.
	part          jsonb NOT NULL CHECK (jsonb_typeof(part) = 'object' AND octet_length(part::text) <= 2000),
	-- How a line names it: "the baseline run", "the firm yield of "<dam>" (All together)".
	label         text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 400),
	status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
	-- What it found (engine BundlePartResult): { checks, damYield? }.
	result        jsonb CHECK (result IS NULL OR (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 65536)),
	finished_at   timestamptz,
	CHECK ((status = 'pending') = (finished_at IS NULL)),
	CHECK ((status = 'done') = (result IS NOT NULL))
);
COMMENT ON TABLE pack_reproduce_part IS
	'One part of a pack''s server re-run (302): a run, the headline pair, § 8, the combined row''s assessment or background, or one dam''s firm yield on one run, worked out by its own pack_reproduce_part job. Written only by the 302 functions.';

-- Covering indexes: the unique index leads with gathering_id; one part per job.
CREATE UNIQUE INDEX pack_reproduce_part_place_idx ON pack_reproduce_part (gathering_id, position);
CREATE UNIQUE INDEX pack_reproduce_part_job_idx ON pack_reproduce_part (job_id);
CREATE INDEX pack_reproduce_part_project_idx ON pack_reproduce_part (project_id);

-- Whoever reads the pack reads where its re-run is (as pack_reproduction, 154). No write policy or grant.
ALTER TABLE pack_reproduce_gathering ENABLE ROW LEVEL SECURITY;
CREATE POLICY pack_reproduce_gathering_select ON pack_reproduce_gathering FOR SELECT
	USING (app_has_role(project_id, 'viewer') AND EXISTS (SELECT 1 FROM evidence_pack p WHERE p.id = pack_reproduce_gathering.pack_id));
ALTER TABLE pack_reproduce_part ENABLE ROW LEVEL SECURITY;
CREATE POLICY pack_reproduce_part_select ON pack_reproduce_part FOR SELECT
	USING (app_has_role(project_id, 'viewer') AND EXISTS (SELECT 1 FROM pack_reproduce_gathering g WHERE g.id = pack_reproduce_part.gathering_id));
GRANT SELECT ON pack_reproduce_gathering, pack_reproduce_part TO water_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON pack_reproduce_gathering, pack_reproduce_part FROM water_app;

-- ---------------------------------------------------------------------------
-- A gathering's stopped parts (evidence/packReproduceParts.ts stoppedPartsSql)
-- ---------------------------------------------------------------------------
CREATE FUNCTION pack_reproduce_stopped_parts(p_gathering uuid) RETURNS jsonb
	LANGUAGE sql STABLE SET search_path = public
	AS $$
	SELECT jsonb_agg(s.problem ORDER BY s.position)
	FROM (
		SELECT format('%s didn''t finish (%s)', p.label,
				CASE WHEN j.id IS NULL THEN 'its job was cleared' WHEN j.status = 'dead' THEN COALESCE(j.last_error, 'its job stopped') ELSE 'its job ended without storing it' END) AS problem,
			p.position
		FROM pack_reproduce_part p LEFT JOIN job j ON j.id = p.job_id
		WHERE p.gathering_id = p_gathering AND p.status = 'pending' AND (j.id IS NULL OR j.status IN ('dead', 'done'))
	) s
	$$;
REVOKE ALL ON FUNCTION pack_reproduce_stopped_parts(uuid) FROM PUBLIC, water_app;

-- ---------------------------------------------------------------------------
-- The fan-out, from the pack's running pack_reproduce job
-- ---------------------------------------------------------------------------
-- p_parts: [{ id, jobId, position, part, label }], each job a queued
-- pack_reproduce_part job of the pack's project, queued by the caller, whose
-- payload names this pack, gathering and part.
CREATE FUNCTION app_pack_reproduce_fan_out(p_pack uuid, p_job uuid, p_gathering uuid, p_engine text, p_run_engines text[], p_bundle_sha256 text, p_checks jsonb, p_parts jsonb)
	RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
		v record;
		e jsonb;
		n integer := 0;
	BEGIN
		IF uid IS NULL THEN
			RAISE EXCEPTION 'a pack''s re-run is fanned out by its job' USING ERRCODE = 'insufficient_privilege';
		END IF;
		SELECT p.id, p.project_id, p.issued_at, p.bundle_sha256 INTO v FROM evidence_pack p WHERE p.id = p_pack FOR SHARE;
		IF NOT FOUND OR NOT EXISTS (
			SELECT 1 FROM job j
			WHERE j.id = p_job AND j.project_id = v.project_id AND j.kind = 'pack_reproduce' AND j.status = 'running' AND j.acting_user_id = uid
				AND j.payload->>'packId' = p_pack::text
		) THEN
			RAISE EXCEPTION 'a pack''s re-run is fanned out by its job' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF v.issued_at IS NULL THEN
			RAISE EXCEPTION 'an evidence pack that was never issued is not re-run' USING ERRCODE = 'check_violation';
		END IF;
		IF v.bundle_sha256 IS NULL OR p_bundle_sha256 IS DISTINCT FROM v.bundle_sha256 THEN
			RAISE EXCEPTION 'a pack''s re-run is of the bundle it records' USING ERRCODE = 'check_violation';
		END IF;
		IF jsonb_typeof(p_parts) <> 'array' OR jsonb_array_length(p_parts) NOT BETWEEN 1 AND 1000 THEN
			RAISE EXCEPTION 'a pack''s re-run has 1 to 1000 parts' USING ERRCODE = 'check_violation';
		END IF;
		INSERT INTO pack_reproduce_gathering (id, project_id, pack_id, job_id, engine_version, run_engines, bundle_sha256, checks)
			VALUES (p_gathering, v.project_id, p_pack, p_job, p_engine, coalesce(p_run_engines, '{}'), p_bundle_sha256, p_checks);
		FOR e IN SELECT x FROM jsonb_array_elements(p_parts) AS x LOOP
			IF NOT EXISTS (
				SELECT 1 FROM job j
				WHERE j.id = (e->>'jobId')::uuid AND j.project_id = v.project_id AND j.kind = 'pack_reproduce_part' AND j.status = 'queued'
					AND j.acting_user_id = uid AND j.payload->>'packId' = p_pack::text AND j.payload->>'gatheringId' = p_gathering::text
					AND j.payload->>'partId' = e->>'id'
			) THEN
				RAISE EXCEPTION 'job % is not this part''s job', e->>'jobId' USING ERRCODE = 'foreign_key_violation';
			END IF;
			INSERT INTO pack_reproduce_part (id, gathering_id, project_id, job_id, position, part, label)
				VALUES ((e->>'id')::uuid, p_gathering, v.project_id, (e->>'jobId')::uuid, (e->>'position')::smallint, e->'part', e->>'label');
			n := n + 1;
		END LOOP;
		RETURN n;
	END
	$$;
REVOKE ALL ON FUNCTION app_pack_reproduce_fan_out(uuid, uuid, uuid, text, text[], text, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_pack_reproduce_fan_out(uuid, uuid, uuid, text, text[], text, jsonb, jsonb) TO water_app;

-- ---------------------------------------------------------------------------
-- A part's result, once, from its own running job
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_pack_reproduce_part_done(p_part uuid, p_result jsonb) RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
		v pack_reproduce_part%ROWTYPE;
	BEGIN
		SELECT * INTO v FROM pack_reproduce_part WHERE id = p_part FOR UPDATE;
		IF uid IS NULL OR NOT FOUND OR NOT EXISTS (
			SELECT 1 FROM job j WHERE j.id = v.job_id AND j.status = 'running' AND j.acting_user_id = uid AND j.kind = 'pack_reproduce_part'
		) THEN
			RAISE EXCEPTION 'a part of a pack''s re-run is stored by its own job' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF v.status <> 'pending' THEN
			RETURN false;
		END IF;
		UPDATE pack_reproduce_part SET status = 'done', result = p_result, finished_at = clock_timestamp() WHERE id = p_part;
		RETURN true;
	END
	$$;
REVOKE ALL ON FUNCTION app_pack_reproduce_part_done(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_pack_reproduce_part_done(uuid, jsonb) TO water_app;

-- ---------------------------------------------------------------------------
-- The outcome, once every part is back, from a running part job of the gathering
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_finish_pack_reproduce(p_gathering uuid, p_outcome text, p_checks jsonb) RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
		g pack_reproduce_gathering%ROWTYPE;
		n integer;
	BEGIN
		SELECT * INTO g FROM pack_reproduce_gathering WHERE id = p_gathering FOR UPDATE;
		IF uid IS NULL OR NOT FOUND OR NOT EXISTS (
			SELECT 1 FROM job j
			WHERE j.project_id = g.project_id AND j.kind = 'pack_reproduce_part' AND j.status = 'running' AND j.acting_user_id = uid
				AND j.payload->>'gatheringId' = p_gathering::text
		) THEN
			RAISE EXCEPTION 'a pack''s re-run is recorded by its jobs' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF g.status <> 'gathering' THEN
			RETURN false;
		END IF;
		IF EXISTS (SELECT 1 FROM pack_reproduce_part p WHERE p.gathering_id = p_gathering AND p.status = 'pending') THEN
			RAISE EXCEPTION 'every part of a pack''s re-run needs its result before the outcome' USING ERRCODE = 'check_violation';
		END IF;
		IF p_outcome NOT IN ('reproduced', 'not_reproduced', 'other_engine') THEN
			RAISE EXCEPTION 'a re-run in parts is reproduced, not reproduced, or on another engine' USING ERRCODE = 'check_violation';
		END IF;
		INSERT INTO pack_reproduction (project_id, pack_id, outcome, engine_version, run_engines, bundle_sha256, checks)
			VALUES (g.project_id, g.pack_id, p_outcome, g.engine_version, g.run_engines, g.bundle_sha256, p_checks)
			ON CONFLICT ON CONSTRAINT pack_reproduction_once DO NOTHING;
		GET DIAGNOSTICS n = ROW_COUNT;
		UPDATE pack_reproduce_gathering SET status = 'recorded', finished_at = clock_timestamp() WHERE id = p_gathering;
		RETURN n > 0;
	END
	$$;
REVOKE ALL ON FUNCTION app_finish_pack_reproduce(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_finish_pack_reproduce(uuid, text, jsonb) TO water_app;

-- ---------------------------------------------------------------------------
-- Failed on its stopped parts: by an editor (a dead part's onDead), or the tick
-- ---------------------------------------------------------------------------
-- It records only what the job table already says, so it holds whoever makes it.
CREATE FUNCTION app_fail_pack_reproduce(p_gathering uuid) RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		g pack_reproduce_gathering%ROWTYPE;
		lines jsonb;
	BEGIN
		SELECT * INTO g FROM pack_reproduce_gathering WHERE id = p_gathering FOR UPDATE;
		IF NOT FOUND OR NOT app_has_role(g.project_id, 'editor') THEN
			RAISE EXCEPTION 'a pack''s re-run is failed by an editor of its project' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF g.status <> 'gathering' THEN
			RETURN false;
		END IF;
		lines := pack_reproduce_stopped_parts(p_gathering);
		IF lines IS NULL THEN
			RETURN false;
		END IF;
		UPDATE pack_reproduce_gathering SET status = 'failed', problems = lines, finished_at = clock_timestamp() WHERE id = p_gathering;
		RETURN true;
	END
	$$;
REVOKE ALL ON FUNCTION app_fail_pack_reproduce(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_fail_pack_reproduce(uuid) TO water_app;

CREATE FUNCTION app_fail_stopped_pack_reproductions() RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		n integer;
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker fails pack re-runs on their stopped parts' USING ERRCODE = 'insufficient_privilege';
		END IF;
		-- A gathering a part job is recording waits on its row lock and, finished meanwhile, no longer matches (READ COMMITTED).
		UPDATE pack_reproduce_gathering g SET status = 'failed', problems = pack_reproduce_stopped_parts(g.id), finished_at = clock_timestamp()
		WHERE g.status = 'gathering' AND pack_reproduce_stopped_parts(g.id) IS NOT NULL;
		GET DIAGNOSTICS n = ROW_COUNT;
		RETURN n;
	END
	$$;
COMMENT ON FUNCTION app_fail_stopped_pack_reproductions() IS
	'The job tick''s sweep (302): every pack re-run still gathering with a stopped part (its job dead, done without its result, or purged) becomes failed, naming each. The worker only.';
REVOKE ALL ON FUNCTION app_fail_stopped_pack_reproductions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_fail_stopped_pack_reproductions() TO water_app;
