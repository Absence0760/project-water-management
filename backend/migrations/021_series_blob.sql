-- 021_series_blob — reproducible runs: every run keeps the exact input series
-- it used, and the hook that keeps "cited" runs (roadmap WP-3.1;
-- docs/data-model.md § Stored run inputs, docs/security.md § Stored run inputs).
--
-- Until now a run snapshot held only a SHA-256 of each input series
-- (`inputs.series[kind].valuesSha256`), so re-uploading a series made older
-- runs impossible to recompute. Now executeRun also writes each input series'
-- values to `series_blob`, keyed by that same hash, and records which blob
-- each kind used in `run_input_series`. loadRunInput (runs/execute.ts)
-- rebuilds the run's ModelInput from the snapshot plus the blobs.
--
-- * Content-addressed and deduplicated **within a project**: the key is
--   (project_id, sha256). A series that didn't change between runs is stored
--   once, however many runs use it. Not across projects: a shared blob would
--   need a cross-project read path and would make INSERT … ON CONFLICT an
--   oracle for "does another project hold exactly these values".
-- * Readable only through a run the user can see: series_blob's SELECT policy
--   asks for a run_input_series row the user can see, and run_input_series'
--   asks for a model_run the user can see. Both follow model_run's own policy,
--   so if run visibility ever narrows (applicants, WP-3.3) blobs narrow with it.
-- * Immutable: water_app may SELECT and INSERT both tables, never UPDATE or
--   DELETE them (catalogue.db.test.ts APPEND_ONLY). A reference goes with its
--   run (cascade); a blob goes when no run references it any more (the
--   series_blob_gc trigger), and never while one does (the foreign key).
-- * No backfill: a run saved before this migration has no references and
--   loadRunInput says it is not reproducible from stored inputs.

CREATE TABLE series_blob (
	project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- SHA-256 hex of seriesDigest(values) (engine manifest.ts), the same hash as
	-- the run snapshot's valuesSha256.
	sha256     text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
	-- values[i] is day start + i of whichever run uses it (the start date is the
	-- run's, on run_input_series); NULL = no reading, as in time_series.
	"values"   double precision[] NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	-- Also covers the project_id foreign key (catalogue.db.test.ts).
	PRIMARY KEY (project_id, sha256)
);

CREATE TABLE run_input_series (
	run_id     uuid NOT NULL REFERENCES model_run(id) ON DELETE CASCADE,
	project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- The series kind the run used (the first series of that kind by name).
	kind       text NOT NULL,
	start_date date NOT NULL,
	sha256     text NOT NULL,
	-- NO ACTION: checked at the end of the statement, so deleting a whole
	-- project (which cascades to both tables) still works, but no statement can
	-- leave a run pointing at a missing blob.
	FOREIGN KEY (project_id, sha256) REFERENCES series_blob (project_id, sha256),
	-- Also covers the run_id foreign key.
	PRIMARY KEY (run_id, kind)
);
-- Covers the project_id and (project_id, sha256) foreign keys, and is what the
-- blob policy and the garbage collector look up.
CREATE INDEX run_input_series_blob_idx ON run_input_series (project_id, sha256);

COMMENT ON TABLE series_blob IS
	'Input series values kept for reproducible runs (021_series_blob), one row per distinct content per project. Readable only through a run_input_series row the user can see. water_app may only SELECT and INSERT; unreferenced rows are removed by series_blob_gc.';
COMMENT ON TABLE run_input_series IS
	'Which series_blob each input series kind of a run used, and its start date (021_series_blob). Written with the run, gone with it. water_app may only SELECT and INSERT.';

-- Garbage collection: when references go (a trimmed or deleted run cascades
-- here), remove the blobs no run references any more. Statement-level, with
-- the removed rows as a transition table, so trimming ten runs is one DELETE.
-- SECURITY DEFINER because water_app has no DELETE on series_blob; it removes
-- only blobs of the projects whose references just went, and only unreferenced
-- ones (the foreign key refuses the rest anyway). Blobs of kept runs (pinned,
-- nominated, cited: RUN_KEPT_SQL) are referenced by those runs, so they stay.
-- A new run that reuses a blob and a trim that frees it can't cross:
-- executeRun, trimRuns and the run DELETE route hold the project's run lock
-- (runs/execute.ts lockProjectRuns) while writing or removing references.
CREATE FUNCTION series_blob_gc() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		DELETE FROM series_blob b
		USING (SELECT DISTINCT project_id, sha256 FROM gone) g
		WHERE b.project_id = g.project_id AND b.sha256 = g.sha256
		  AND NOT EXISTS (SELECT 1 FROM run_input_series r WHERE r.project_id = g.project_id AND r.sha256 = g.sha256);
		RETURN NULL;
	END
	$$;
CREATE TRIGGER run_input_series_gc AFTER DELETE ON run_input_series
	REFERENCING OLD TABLE AS gone
	FOR EACH STATEMENT EXECUTE FUNCTION series_blob_gc();

-- RLS. Read: through a run the user can see (the subqueries are themselves
-- subject to run_input_series' and model_run's policies). Write: an editor,
-- and a reference only to a run of the same project saved in this very
-- transaction (model_run.created_at defaults to now(), the transaction's
-- start), so an older run can't be given references after the fact.
ALTER TABLE series_blob ENABLE ROW LEVEL SECURITY;
CREATE POLICY series_blob_select ON series_blob FOR SELECT USING (
	EXISTS (SELECT 1 FROM run_input_series r WHERE r.project_id = series_blob.project_id AND r.sha256 = series_blob.sha256)
);
CREATE POLICY series_blob_insert ON series_blob FOR INSERT WITH CHECK (app_has_role(project_id, 'editor'));

ALTER TABLE run_input_series ENABLE ROW LEVEL SECURITY;
CREATE POLICY run_input_series_select ON run_input_series FOR SELECT USING (
	EXISTS (SELECT 1 FROM model_run m WHERE m.id = run_input_series.run_id)
);
CREATE POLICY run_input_series_insert ON run_input_series FOR INSERT WITH CHECK (
	app_has_role(project_id, 'editor')
	AND EXISTS (SELECT 1 FROM model_run m WHERE m.id = run_input_series.run_id AND m.project_id = run_input_series.project_id AND m.created_at = now())
);

GRANT SELECT, INSERT ON series_blob, run_input_series TO water_app;

-- ---------------------------------------------------------------------------
-- Cited runs: the one place later migrations add a citation.
--
-- A run that a scenario is based on (WP-3.2), or that an evidence pack or an
-- assessment cites (WP-3.13, WP-3.14), must never be trimmed or deleted, and
-- no editor action may lift that. runs/execute.ts RUN_KEPT_SQL (shared by
-- trimRuns and the DELETE route) calls this function, so a new kind of
-- citation is **one clause here**, added by that WP's migration with CREATE OR
-- REPLACE (keep the signature, SECURITY DEFINER and search_path), e.g. the
-- scenarios migration:
--
--   CREATE OR REPLACE FUNCTION model_run_cited(p_run uuid) RETURNS boolean
--   	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
--   	AS $f$ SELECT EXISTS (SELECT 1 FROM scenario s WHERE s.base_run_id = p_run) $f$;
--
-- and a later one ORs its own EXISTS onto the latest body. Pair each with a
-- RESTRICT (or NO ACTION) foreign key to model_run, so the database refuses
-- the delete even if the exemption were bypassed.
--
-- SECURITY DEFINER so a citation the caller can't see (a scenario hidden from
-- this editor by a narrower policy) still keeps the run: otherwise trimRuns
-- would try to delete it and the citation's foreign key would fail the whole
-- run. It answers only "is this run cited", for a run id the caller already
-- holds. No citations exist yet, so it is false.
-- ---------------------------------------------------------------------------
CREATE FUNCTION model_run_cited(p_run uuid) RETURNS boolean
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$ SELECT false $$;

COMMENT ON FUNCTION model_run_cited(uuid) IS
	'True for a run a scenario, evidence pack or assessment cites (021_series_blob; one EXISTS clause per citing table, added by that table''s migration). Part of RUN_KEPT_SQL in backend/src/runs/execute.ts.';
