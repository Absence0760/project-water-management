-- 036_signoff — professional sign-off on a run (roadmap WP-3.13;
-- docs/data-model.md § Sign-offs, docs/security.md § Liability).
--
-- A registered professional (normally the applicant's consultant, a SACNASP
-- Pr.Sci.Nat. in Water Resources Science) signs that a run's calibration,
-- EWR tables, network and assurance levels are appropriate, and that they
-- read its known limitations. The row records who signed (their account and
-- the full name and registration they typed; the registration is
-- self-declared, never checked against the register), what the signature
-- covers (scope), and the exact statement shown: its version and the SHA-256
-- of its RFC 8785 text (engine liability/signoff.ts). The route recomputes
-- the statement and refuses a hash that doesn't match, so a signature is
-- bound to the words the signer saw.
--
-- Immutable: water_app may SELECT and INSERT only, and there is no UPDATE or
-- DELETE policy (catalogue.db.test.ts APPEND_ONLY). A correction is a new
-- sign-off. The row goes only with its project (cascade).
--
-- A sign-off cites its run (model_run_cited below), so trimRuns and the run
-- DELETE route keep a signed run; the run_id foreign key refuses the delete
-- too. The WP's pack target (WP-3.14) adds its own column when packs exist.
--
-- RLS: editors and owners sign, as themselves only; viewers and above read.
-- Farmers see nothing (like the change history). Each sign-off also writes an
-- audit_event 'signoff.created' in the same transaction (the route).

CREATE TABLE signoff (
	id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id        uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	run_id            uuid NOT NULL REFERENCES model_run(id),
	-- The signer's account. SET NULL if the account is deleted: the typed
	-- name and registration stay, as the professional record they are.
	user_id           uuid REFERENCES app_user(id) ON DELETE SET NULL,
	full_name         text NOT NULL CHECK (length(full_name) BETWEEN 1 AND 200),
	-- e.g. 'SACNASP'; the number as registered, e.g. '400123/15'.
	registration_body text NOT NULL CHECK (length(registration_body) BETWEEN 1 AND 100),
	registration_no   text NOT NULL CHECK (length(registration_no) BETWEEN 1 AND 50),
	-- What the signature covers, in the signer's words (e.g. "the hydrology of
	-- the WULA technical report for the proposed dam").
	scope             text NOT NULL CHECK (length(scope) BETWEEN 1 AND 1000),
	statement_version text NOT NULL CHECK (length(statement_version) BETWEEN 1 AND 50),
	statement_sha256  text NOT NULL CHECK (statement_sha256 ~ '^[0-9a-f]{64}$'),
	-- The disclaimer version the statement carried (DISCLAIMER.version).
	disclaimer_version text NOT NULL CHECK (length(disclaimer_version) BETWEEN 1 AND 50),
	signed_at         timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE signoff IS
	'A professional sign-off on a run, bound to the SHA-256 of the statement shown (036_signoff, WP-3.13). Immutable (insert only); cites its run.';
CREATE INDEX signoff_project_idx ON signoff (project_id, signed_at DESC);
CREATE INDEX signoff_run_idx ON signoff (run_id, signed_at DESC);
CREATE INDEX signoff_user_idx ON signoff (user_id);

CREATE TRIGGER signoff_same_project BEFORE INSERT OR UPDATE ON signoff
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('run_id');

ALTER TABLE signoff ENABLE ROW LEVEL SECURITY;
CREATE POLICY signoff_select ON signoff FOR SELECT USING (app_has_role(project_id, 'viewer'));
CREATE POLICY signoff_insert ON signoff FOR INSERT
	WITH CHECK (app_has_role(project_id, 'editor') AND user_id = app_current_user_id());

GRANT SELECT, INSERT ON signoff TO water_app;

-- ---------------------------------------------------------------------------
-- A sign-off cites its run. Latest body: 024_scenarios (publication and
-- scenario clauses, kept as they were). Same signature, SECURITY DEFINER and
-- search_path.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION model_run_cited(p_run uuid) RETURNS boolean
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$ SELECT EXISTS (SELECT 1 FROM run_publication p WHERE p.run_id = p_run)
		OR EXISTS (SELECT 1 FROM scenario s WHERE s.base_run_id = p_run)
		OR EXISTS (SELECT 1 FROM signoff so WHERE so.run_id = p_run) $$;

COMMENT ON FUNCTION model_run_cited(uuid) IS
	'True for a run a publication (022_publication), a scenario (024_scenarios) or a sign-off (036_signoff) cites; evidence packs and assessments add their own EXISTS clause. Part of RUN_KEPT_SQL in backend/src/runs/execute.ts.';
