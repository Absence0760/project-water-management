-- 154_pack_reproduce — the server re-runs an issued evidence pack's runs from
-- its stored reproduction bundle (issue #71, followups.md § Evidence report
-- "Re-run both runs on the server after issue"; docs/evidence-pack.md §
-- Reproduction, docs/data-model.md § Evidence packs).
--
-- Issuing a pack (POST …/packs/:packId/issue) checks its bundle's files,
-- hashes and manifest in the issue's transaction but doesn't re-run the runs
-- (as long as the runs: too long for a request). Now the issue also queues a
-- `pack_reproduce` job, as the issuer, one pending per pack. The job reads
-- the bundle back from the packs bucket, checks it is the bytes recorded
-- (bundle_sha256), runs the engine's checkPackBundle with the re-run (what
-- `pnpm reproduce:pack` does) and records the outcome, the engine it re-ran
-- with and every check. The pack's page shows it; verify doesn't: it is the
-- app's own claim, not something the pack's hash covers.
--
--   1. job.kind accepts 'pack_reproduce' (latest list: 145_assessment).
--   2. pack_reproduction: one row per pack and engine version (the first
--      outcome recorded for an engine stands). Readable by whoever reads the
--      pack (evidence_pack's own RLS, through the policy's subquery). No
--      write grant: water_app only reads it.
--   3. app_record_pack_reproduction(…): the one way a row is written.
--      SECURITY DEFINER; it records only
--        - for a pack that was issued (issued_at set),
--        - from a running pack_reproduce job of that pack, in its project,
--          whose acting user is the caller (so only the job handler's
--          transaction, never a route's),
--        - for the bundle the pack records: the outcome names the pack's
--          bundle_sha256, or `no_bundle` when it has none,
--      and once per engine version: a second outcome for the same engine
--      changes nothing and returns false.

-- ---------------------------------------------------------------------------
-- 1. job: the new kind. From 145_assessment's list.
-- ---------------------------------------------------------------------------
ALTER TABLE job DROP CONSTRAINT job_kind_check;
ALTER TABLE job ADD CONSTRAINT job_kind_check
	CHECK (kind IN ('feed_fetch', 'feed_ingest', 'rerun', 'alert_eval', 'report_render', 'yield', 'sweep', 'outlook', 'auto_calibration',
		'uncertainty', 'pack_render', 'assessment', 'pack_reproduce'));

-- ---------------------------------------------------------------------------
-- 2. pack_reproduction
-- ---------------------------------------------------------------------------
CREATE TABLE pack_reproduction (
	id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id     uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- CASCADE: only a draft is ever deleted, and a draft is never re-run (the function refuses it).
	pack_id        uuid NOT NULL REFERENCES evidence_pack(id) ON DELETE CASCADE,
	-- reproduced: every check passed and each run re-ran to its stored results digest.
	-- not_reproduced: a check failed (a file, the manifest, the inputs, the stored results, or a re-run).
	-- other_engine: only the re-runs differ, and the runs were made with another engine version than this one.
	-- no_bundle: the pack was issued without a bundle, so there was nothing to re-run.
	outcome        text NOT NULL CHECK (outcome IN ('reproduced', 'not_reproduced', 'other_engine', 'no_bundle')),
	-- The engine that re-ran the runs (the worker's ENGINE_VERSION), and the runs' own engines.
	engine_version text NOT NULL CHECK (length(engine_version) BETWEEN 1 AND 50),
	run_engines    text[] NOT NULL DEFAULT '{}' CHECK (cardinality(run_engines) <= 2),
	-- The bundle checked: the pack's bundle_sha256 when it was recorded; NULL for no_bundle.
	bundle_sha256  text CHECK (bundle_sha256 ~ '^[0-9a-f]{64}$'),
	-- Each check as the engine's checkPackBundle reports it: [{ id, ok, detail }].
	checks         jsonb NOT NULL CHECK (jsonb_typeof(checks) = 'array' AND octet_length(checks::text) <= 65536),
	checked_at     timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT pack_reproduction_bundle CHECK ((outcome = 'no_bundle') = (bundle_sha256 IS NULL)),
	-- One outcome per pack and engine; also pack_id's covering index.
	CONSTRAINT pack_reproduction_once UNIQUE (pack_id, engine_version)
);
COMMENT ON TABLE pack_reproduction IS
	'The server''s re-run of an issued evidence pack''s runs from its stored reproduction bundle (154_pack_reproduce, issue #71): the outcome, the engine and every check, once per pack and engine version. Written only by app_record_pack_reproduction from the pack''s pack_reproduce job; readable by whoever reads the pack. Not on verify: it is the app''s own claim.';

CREATE INDEX pack_reproduction_project_idx ON pack_reproduction (project_id);

CREATE TRIGGER pack_reproduction_same_project BEFORE INSERT OR UPDATE ON pack_reproduction
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('pack_id');

ALTER TABLE pack_reproduction ENABLE ROW LEVEL SECURITY;
-- Reading only: whoever reads the pack (evidence_pack_select applies inside the subquery). No write policy.
CREATE POLICY pack_reproduction_select ON pack_reproduction FOR SELECT
	USING (app_has_role(project_id, 'viewer') AND EXISTS (SELECT 1 FROM evidence_pack p WHERE p.id = pack_reproduction.pack_id));
GRANT SELECT ON pack_reproduction TO water_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON pack_reproduction FROM water_app;

-- ---------------------------------------------------------------------------
-- 3. Recording the outcome, once per engine, from the pack's job only.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_record_pack_reproduction(p_pack uuid, p_outcome text, p_engine text, p_run_engines text[], p_bundle_sha256 text, p_checks jsonb)
	RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
		v record;
		n integer;
	BEGIN
		IF uid IS NULL THEN
			RAISE EXCEPTION 'a pack''s reproduction is recorded by its job' USING ERRCODE = 'insufficient_privilege';
		END IF;
		SELECT p.id, p.project_id, p.issued_at, p.bundle_sha256 INTO v FROM evidence_pack p WHERE p.id = p_pack FOR SHARE;
		-- The caller's own running reproduce job of this pack, in its project: nothing else writes these rows.
		IF NOT FOUND OR NOT EXISTS (
			SELECT 1 FROM job j
			WHERE j.project_id = v.project_id AND j.kind = 'pack_reproduce' AND j.status = 'running' AND j.acting_user_id = uid
				AND j.payload->>'packId' = p_pack::text
		) THEN
			RAISE EXCEPTION 'a pack''s reproduction is recorded by its job' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF v.issued_at IS NULL THEN
			RAISE EXCEPTION 'an evidence pack that was never issued is not re-run' USING ERRCODE = 'check_violation';
		END IF;
		-- The bundle the pack records, and no other; no_bundle only for a pack without one.
		IF (p_outcome = 'no_bundle') <> (v.bundle_sha256 IS NULL) OR p_bundle_sha256 IS DISTINCT FROM v.bundle_sha256 THEN
			RAISE EXCEPTION 'a pack''s reproduction is of the bundle it records' USING ERRCODE = 'check_violation';
		END IF;
		INSERT INTO pack_reproduction (project_id, pack_id, outcome, engine_version, run_engines, bundle_sha256, checks)
			VALUES (v.project_id, p_pack, p_outcome, p_engine, coalesce(p_run_engines, '{}'), p_bundle_sha256, p_checks)
			ON CONFLICT ON CONSTRAINT pack_reproduction_once DO NOTHING;
		GET DIAGNOSTICS n = ROW_COUNT;
		RETURN n > 0;
	END
	$$;
COMMENT ON FUNCTION app_record_pack_reproduction(uuid, text, text, text[], text, jsonb) IS
	'Records the server''s re-run of an issued evidence pack''s bundle (154_pack_reproduce) from the caller''s running pack_reproduce job of it, for the bundle the pack records; once per engine version (false when one is recorded already).';
REVOKE ALL ON FUNCTION app_record_pack_reproduction(uuid, text, text, text[], text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_record_pack_reproduction(uuid, text, text, text[], text, jsonb) TO water_app;
