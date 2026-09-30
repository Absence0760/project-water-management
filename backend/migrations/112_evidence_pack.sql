-- 112_evidence_pack — the licensing evidence pack: a versioned, hashed,
-- immutable-once-issued evidence report, its sign-off, and the public verify
-- lookup (roadmap WP-3.14, issue #71; docs/evidence-pack.md,
-- docs/data-model.md § Evidence packs, docs/security.md § Evidence packs).
--
--   1. evidence_pack: one version of a pack. Its manifest (engine
--      evidence/pack.ts: the pack's identity, the project, the engine and the
--      evidence report as the API serves it) is written once, with the
--      SHA-256 of its RFC 8785 text, and never changes. The lifecycle is
--      outside the hash: draft → issued → superseded | withdrawn,
--      superseded → withdrawn, and a draft may be withdrawn (a signed draft
--      can't be deleted, below). A new version is a new row that supersedes
--      the old one when it is issued; nothing is edited.
--
--      evidence_pack_guard (BEFORE INSERT OR UPDATE) keeps it so, whoever
--      writes: a pack is inserted as a draft only; from then on the
--      manifest, its hash, the runs, the scenario, the version and its
--      predecessor, the engine and report versions and the creation are
--      frozen, and the manifest must name the row's own id, version,
--      project, engine and report versions. Only these move, each once and only forward: the status; the
--      issue stamp (issued_at, issued_by: set by the trigger on the move to
--      issued, never by the caller); status_reason (with the move to
--      withdrawn); superseded_by_pack_id (with the move to superseded, naming
--      an issued successor that supersedes this pack); the PDF and the bundle
--      (null to a value, each as a set). Issuing needs a sign-off of the
--      pack (signoff.pack_id). created_by and issued_by may go to NULL only
--      when the account they name is gone (the foreign key's SET NULL on an
--      account deletion, as 052 did for scenario.decided_by).
--
--      Deletes: RLS lets an editor delete a draft only (no trigger, so a
--      project delete still cascades). A signed draft is kept by its
--      sign-off's foreign key; it is withdrawn instead. project_pack_guard
--      refuses deleting a project that has a pack past draft, whoever runs
--      the DELETE (operator decision, 2026-09-29; a project with a pack has
--      nominated a run, so 035's project_evidence_guard refuses it too).
--
--      The runs, the scenario and the predecessor are NO ACTION foreign keys,
--      and model_run_cited (below) cites both runs, so trimRuns, the unpin
--      and the run DELETE keep them. scenario_signed_run_guard (072) now
--      refuses deleting a scenario a pack cites as well.
--
--      evidence_pack_one_issued: one issued pack per application (and one
--      for baseline evidence) at a time, checked at commit.
--
--      RLS: editors and owners read every pack of the project; viewers read
--      a baseline pack, and an application pack when they read its scenario
--      (app_scenario_readable, 045). Contributors and farmers read none.
--      Editors insert (as themselves), update and delete (drafts).
--
--   2. signoff: a sign-off of a pack. pack_id (NO ACTION), run_id now
--      nullable, exactly one of them set; a pack statement's version starts
--      `pack-` and a run statement's doesn't (engine liability/signoff.ts);
--      a pack is signed only while it is a draft (signoff_pack_draft).
--      signoff_same_project covers pack_id; signoff_select (latest: 045)
--      hides a sign-off of a pack the reader can't see. app_subject_export
--      (latest: 092) carries packId.
--
--   3. assert_same_project (latest: 022_publication) learns `%pack_id`
--      (evidence_pack) and `%scenario_id` (scenario).
--
--   4. model_run_cited (latest: 036_signoff) adds the pack's two runs.
--
--   5. app_verify_pack(code): the public verify lookup (GET /verify/:code),
--      SECURITY DEFINER. For a short code or a full manifest hash of a pack
--      that was issued, only the public fields listed at the function; for a
--      draft, a never-issued pack or anything else, NULL.

-- ---------------------------------------------------------------------------
-- 3. assert_same_project, from its latest definition (022_publication.sql),
-- with two more kinds of column.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 1. evidence_pack
-- ---------------------------------------------------------------------------
CREATE TABLE evidence_pack (
	id                    uuid PRIMARY KEY,
	project_id            uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- The application's scenario and run; both NULL for baseline evidence.
	scenario_id           uuid REFERENCES scenario(id),
	baseline_run_id       uuid NOT NULL REFERENCES model_run(id),
	scenario_run_id       uuid REFERENCES model_run(id),
	version               integer NOT NULL CHECK (version >= 1),
	-- The issued pack this version replaces (manifest pack.supersedes).
	supersedes_pack_id    uuid REFERENCES evidence_pack(id),
	status                text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'superseded', 'withdrawn')),
	manifest              jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
	manifest_sha256       text NOT NULL UNIQUE CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
	report_version        text NOT NULL CHECK (length(report_version) BETWEEN 1 AND 50),
	engine_version        text NOT NULL CHECK (length(engine_version) BETWEEN 1 AND 50),
	-- The server-rendered PDF and the reproduction bundle, each set once (not built yet: followups.md).
	pdf_key               text CHECK (length(pdf_key) BETWEEN 1 AND 500),
	pdf_sha256            text CHECK (pdf_sha256 ~ '^[0-9a-f]{64}$'),
	pdf_pages             integer CHECK (pdf_pages >= 1),
	bundle_key            text CHECK (length(bundle_key) BETWEEN 1 AND 500),
	bundle_sha256         text CHECK (bundle_sha256 ~ '^[0-9a-f]{64}$'),
	created_by            uuid REFERENCES app_user(id) ON DELETE SET NULL,
	created_at            timestamptz NOT NULL DEFAULT now(),
	issued_by             uuid REFERENCES app_user(id) ON DELETE SET NULL,
	issued_at             timestamptz,
	superseded_by_pack_id uuid REFERENCES evidence_pack(id),
	status_reason         text CHECK (length(status_reason) BETWEEN 1 AND 1000),
	CONSTRAINT evidence_pack_application CHECK ((scenario_id IS NULL) = (scenario_run_id IS NULL)),
	CONSTRAINT evidence_pack_lineage CHECK ((supersedes_pack_id IS NULL) = (version = 1)),
	CONSTRAINT evidence_pack_not_self CHECK (supersedes_pack_id <> id AND superseded_by_pack_id <> id),
	CONSTRAINT evidence_pack_pdf CHECK ((pdf_key IS NULL) = (pdf_sha256 IS NULL) AND (pdf_key IS NOT NULL OR pdf_pages IS NULL)),
	CONSTRAINT evidence_pack_bundle CHECK ((bundle_key IS NULL) = (bundle_sha256 IS NULL)),
	-- Each status with the columns it carries.
	CONSTRAINT evidence_pack_status_columns CHECK (
		CASE status
			WHEN 'draft' THEN issued_at IS NULL AND superseded_by_pack_id IS NULL AND status_reason IS NULL
			WHEN 'issued' THEN issued_at IS NOT NULL AND superseded_by_pack_id IS NULL AND status_reason IS NULL
			WHEN 'superseded' THEN issued_at IS NOT NULL AND superseded_by_pack_id IS NOT NULL AND status_reason IS NULL
			WHEN 'withdrawn' THEN status_reason IS NOT NULL
		END
	)
);
COMMENT ON TABLE evidence_pack IS
	'A licensing evidence pack (112_evidence_pack, WP-3.14): a frozen manifest and its SHA-256; draft → issued → superseded | withdrawn. Immutable but for its lifecycle (evidence_pack_guard).';
COMMENT ON COLUMN evidence_pack.manifest_sha256 IS
	'SHA-256 of the manifest''s RFC 8785 text (engine evidence/pack.ts packManifestText). Its first 12 hex digits are the pack''s short code (unique).';

CREATE INDEX evidence_pack_project_idx ON evidence_pack (project_id, created_at DESC);
CREATE INDEX evidence_pack_scenario_idx ON evidence_pack (scenario_id);
CREATE INDEX evidence_pack_baseline_run_idx ON evidence_pack (baseline_run_id);
CREATE INDEX evidence_pack_scenario_run_idx ON evidence_pack (scenario_run_id);
CREATE INDEX evidence_pack_supersedes_idx ON evidence_pack (supersedes_pack_id);
CREATE INDEX evidence_pack_superseded_by_idx ON evidence_pack (superseded_by_pack_id);
CREATE INDEX evidence_pack_created_by_idx ON evidence_pack (created_by);
CREATE INDEX evidence_pack_issued_by_idx ON evidence_pack (issued_by);
-- The short code (GET /verify/:code) finds one pack.
CREATE UNIQUE INDEX evidence_pack_short_code_idx ON evidence_pack (left(manifest_sha256, 12));
-- One issued pack per application, and one for the project's baseline
-- evidence: a later version supersedes it, so the chain never forks. Deferred
-- to commit, because issuing a new version and superseding its predecessor
-- are two updates of one transaction (the successor first: the guard wants
-- it issued when the predecessor names it).
ALTER TABLE evidence_pack ADD CONSTRAINT evidence_pack_one_issued
	EXCLUDE USING btree (project_id WITH =, (coalesce(scenario_id, project_id)) WITH =) WHERE (status = 'issued')
	DEFERRABLE INITIALLY DEFERRED;

CREATE TRIGGER evidence_pack_same_project BEFORE INSERT OR UPDATE ON evidence_pack
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('scenario_id', 'baseline_run_id', 'scenario_run_id', 'supersedes_pack_id', 'superseded_by_pack_id');

CREATE FUNCTION evidence_pack_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		-- Everything but the lifecycle columns: frozen from the insert.
		lifecycle constant text[] := ARRAY['status', 'issued_at', 'issued_by', 'status_reason', 'superseded_by_pack_id',
			'pdf_key', 'pdf_sha256', 'pdf_pages', 'bundle_key', 'bundle_sha256', 'created_by'];
		pred record;
		succ record;
	BEGIN
		IF TG_OP = 'INSERT' THEN
			IF NEW.status <> 'draft' OR NEW.issued_at IS NOT NULL OR NEW.issued_by IS NOT NULL OR NEW.superseded_by_pack_id IS NOT NULL
				OR NEW.status_reason IS NOT NULL THEN
				RAISE EXCEPTION 'an evidence pack is created as a draft' USING ERRCODE = 'check_violation';
			END IF;
			-- The baseline is a run of the model itself; the application run is its scenario's.
			IF EXISTS (SELECT 1 FROM model_run WHERE id = NEW.baseline_run_id AND scenario_id IS NOT NULL) THEN
				RAISE EXCEPTION 'an evidence pack''s baseline is not a scenario run' USING ERRCODE = 'check_violation';
			END IF;
			IF NEW.scenario_run_id IS NOT NULL
				AND NOT EXISTS (SELECT 1 FROM model_run WHERE id = NEW.scenario_run_id AND scenario_id = NEW.scenario_id) THEN
				RAISE EXCEPTION 'an evidence pack''s application run is a run of its scenario' USING ERRCODE = 'check_violation';
			END IF;
			-- The manifest is this row's: its pack id and version, project, engine and report versions are the columns'.
			-- (Its SHA-256 is the backend's to check: SQL has no RFC 8785.)
			IF NEW.manifest->'pack'->>'id' IS DISTINCT FROM NEW.id::text
				OR NEW.manifest->'pack'->>'version' IS DISTINCT FROM NEW.version::text
				OR NEW.manifest->'project'->>'id' IS DISTINCT FROM NEW.project_id::text
				OR NEW.manifest->'engine'->>'version' IS DISTINCT FROM NEW.engine_version
				OR NEW.manifest->'report'->>'version' IS DISTINCT FROM NEW.report_version THEN
				RAISE EXCEPTION 'an evidence pack''s manifest names another pack, version, project or engine' USING ERRCODE = 'check_violation';
			END IF;
			IF NEW.supersedes_pack_id IS NOT NULL THEN
				SELECT version, status, scenario_id INTO pred FROM evidence_pack WHERE id = NEW.supersedes_pack_id;
				IF NOT FOUND OR pred.status <> 'issued' OR NEW.version <> pred.version + 1
					OR pred.scenario_id IS DISTINCT FROM NEW.scenario_id THEN
					RAISE EXCEPTION 'a new version of an evidence pack supersedes an issued pack of the same application (or baseline evidence), as its version + 1'
						USING ERRCODE = 'check_violation';
				END IF;
			END IF;
			RETURN NEW;
		END IF;

		IF (to_jsonb(NEW) - lifecycle) IS DISTINCT FROM (to_jsonb(OLD) - lifecycle) THEN
			RAISE EXCEPTION 'evidence pack % is frozen: only its status, reason, successor, PDF and bundle change', OLD.id
				USING ERRCODE = 'check_violation';
		END IF;
		-- An account deletion clears who made or issued it (the foreign key's SET NULL), nothing else.
		IF NEW.created_by IS DISTINCT FROM OLD.created_by
			AND NOT (NEW.created_by IS NULL AND NOT EXISTS (SELECT 1 FROM app_user WHERE id = OLD.created_by)) THEN
			RAISE EXCEPTION 'who created evidence pack % never changes', OLD.id USING ERRCODE = 'check_violation';
		END IF;

		IF NEW.status IS DISTINCT FROM OLD.status THEN
			IF NOT ((OLD.status = 'draft' AND NEW.status IN ('issued', 'withdrawn'))
				OR (OLD.status = 'issued' AND NEW.status IN ('superseded', 'withdrawn'))
				OR (OLD.status = 'superseded' AND NEW.status = 'withdrawn')) THEN
				RAISE EXCEPTION 'evidence pack % can''t move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'check_violation';
			END IF;
		END IF;

		IF OLD.status = 'draft' AND NEW.status = 'issued' THEN
			IF NOT EXISTS (SELECT 1 FROM signoff WHERE pack_id = OLD.id) THEN
				RAISE EXCEPTION 'evidence pack % has no sign-off, so it can''t be issued', OLD.id USING ERRCODE = 'check_violation';
			END IF;
			IF app_current_user_id() IS NULL THEN
				RAISE EXCEPTION 'an evidence pack is issued by a signed-in user' USING ERRCODE = 'check_violation';
			END IF;
			NEW.issued_at := now();
			NEW.issued_by := app_current_user_id();
		ELSE
			IF NEW.issued_at IS DISTINCT FROM OLD.issued_at THEN
				RAISE EXCEPTION 'evidence pack % was issued once, when it was', OLD.id USING ERRCODE = 'check_violation';
			END IF;
			IF NEW.issued_by IS DISTINCT FROM OLD.issued_by
				AND NOT (NEW.issued_by IS NULL AND NOT EXISTS (SELECT 1 FROM app_user WHERE id = OLD.issued_by)) THEN
				RAISE EXCEPTION 'who issued evidence pack % never changes', OLD.id USING ERRCODE = 'check_violation';
			END IF;
		END IF;

		IF NEW.status_reason IS DISTINCT FROM OLD.status_reason
			AND NOT (OLD.status_reason IS NULL AND NEW.status = 'withdrawn' AND OLD.status <> 'withdrawn') THEN
			RAISE EXCEPTION 'evidence pack %''s reason is given once, when it is withdrawn', OLD.id USING ERRCODE = 'check_violation';
		END IF;

		IF NEW.superseded_by_pack_id IS DISTINCT FROM OLD.superseded_by_pack_id THEN
			IF NOT (OLD.superseded_by_pack_id IS NULL AND OLD.status = 'issued' AND NEW.status = 'superseded') THEN
				RAISE EXCEPTION 'evidence pack %''s successor is named once, when it is superseded', OLD.id USING ERRCODE = 'check_violation';
			END IF;
			SELECT status, supersedes_pack_id INTO succ FROM evidence_pack WHERE id = NEW.superseded_by_pack_id;
			IF NOT FOUND OR succ.status <> 'issued' OR succ.supersedes_pack_id IS DISTINCT FROM OLD.id THEN
				RAISE EXCEPTION 'evidence pack % is superseded by an issued pack that supersedes it', OLD.id USING ERRCODE = 'check_violation';
			END IF;
		END IF;

		IF (NEW.pdf_key, NEW.pdf_sha256, NEW.pdf_pages) IS DISTINCT FROM (OLD.pdf_key, OLD.pdf_sha256, OLD.pdf_pages) AND OLD.pdf_key IS NOT NULL THEN
			RAISE EXCEPTION 'evidence pack %''s PDF is recorded once', OLD.id USING ERRCODE = 'check_violation';
		END IF;
		IF (NEW.bundle_key, NEW.bundle_sha256) IS DISTINCT FROM (OLD.bundle_key, OLD.bundle_sha256) AND OLD.bundle_key IS NOT NULL THEN
			RAISE EXCEPTION 'evidence pack %''s bundle is recorded once', OLD.id USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER evidence_pack_guard BEFORE INSERT OR UPDATE ON evidence_pack
	FOR EACH ROW EXECUTE FUNCTION evidence_pack_guard();

ALTER TABLE evidence_pack ENABLE ROW LEVEL SECURITY;
CREATE POLICY evidence_pack_select ON evidence_pack FOR SELECT
	USING (
		app_has_role(project_id, 'editor')
		OR (app_has_role(project_id, 'viewer') AND (scenario_id IS NULL OR app_scenario_readable(scenario_id)))
	);
CREATE POLICY evidence_pack_insert ON evidence_pack FOR INSERT
	WITH CHECK (app_has_role(project_id, 'editor') AND created_by = app_current_user_id());
CREATE POLICY evidence_pack_update ON evidence_pack FOR UPDATE
	USING (app_has_role(project_id, 'editor')) WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY evidence_pack_delete ON evidence_pack FOR DELETE
	USING (app_has_role(project_id, 'editor') AND status = 'draft');

-- The frozen columns can't even be named in an UPDATE by water_app; the guard
-- covers the owner and the lifecycle's own rules.
GRANT SELECT, INSERT, DELETE ON evidence_pack TO water_app;
-- The PDF and bundle columns are not granted: their hashes are printed and
-- verified publicly, so the renderer will set them through a SECURITY DEFINER
-- setter when they are built, never an editor's UPDATE.
GRANT UPDATE (status, status_reason, superseded_by_pack_id) ON evidence_pack TO water_app;

-- A project with a pack past draft is kept (operator decision, 2026-09-29).
-- SECURITY DEFINER so it sees every pack whatever the deleter reads.
CREATE FUNCTION project_pack_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF EXISTS (SELECT 1 FROM evidence_pack WHERE project_id = OLD.id AND status <> 'draft') THEN
			RAISE EXCEPTION 'project % has an issued evidence pack, so it is kept', OLD.id USING ERRCODE = 'restrict_violation';
		END IF;
		RETURN OLD;
	END
	$$;
CREATE TRIGGER project_pack_guard BEFORE DELETE ON project
	FOR EACH ROW EXECUTE FUNCTION project_pack_guard();

-- ---------------------------------------------------------------------------
-- 2. signoff: a pack target
-- ---------------------------------------------------------------------------
ALTER TABLE signoff ADD COLUMN pack_id uuid REFERENCES evidence_pack(id);
CREATE INDEX signoff_pack_idx ON signoff (pack_id, signed_at DESC);
ALTER TABLE signoff ALTER COLUMN run_id DROP NOT NULL;
ALTER TABLE signoff
	ADD CONSTRAINT signoff_one_target CHECK (num_nonnulls(run_id, pack_id) = 1),
	-- A pack statement (pack-signoff-N) signs a pack; a run statement (signoff-N) a run.
	ADD CONSTRAINT signoff_statement_target CHECK ((pack_id IS NOT NULL) = (statement_version LIKE 'pack-%'));
COMMENT ON COLUMN signoff.pack_id IS
	'The evidence pack signed (112_evidence_pack), or NULL for a sign-off of a run (run_id). Exactly one is set.';

DROP TRIGGER signoff_same_project ON signoff;
CREATE TRIGGER signoff_same_project BEFORE INSERT OR UPDATE ON signoff
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('run_id', 'pack_id');

-- A pack is signed while it is a draft: an issued pack is what its signers signed.
CREATE FUNCTION signoff_pack_draft() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NEW.pack_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM evidence_pack WHERE id = NEW.pack_id AND status = 'draft') THEN
			RAISE EXCEPTION 'evidence pack % is not a draft, so it can''t be signed', NEW.pack_id USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER signoff_pack_draft BEFORE INSERT OR UPDATE OF pack_id ON signoff
	FOR EACH ROW EXECUTE FUNCTION signoff_pack_draft();

-- signoff_select, from 045_contributor_scope.sql: a sign-off of a pack shows
-- to whoever reads the pack (its policy applies inside the subquery). The run
-- clause now holds only for a run sign-off (NULL NOT IN … is not true).
DROP POLICY signoff_select ON signoff;
CREATE POLICY signoff_select ON signoff FOR SELECT
	USING (
		app_has_role(project_id, 'viewer')
		AND (run_id IS NULL OR run_id NOT IN (SELECT app_hidden_scenario_runs()))
		AND (pack_id IS NULL OR EXISTS (SELECT 1 FROM evidence_pack p WHERE p.id = pack_id))
	);

-- ---------------------------------------------------------------------------
-- A scenario a pack cites is kept, as one with a signed-off run (072). From
-- 072_audit_trail's body, with the pack clause; same trigger.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION scenario_signed_run_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF EXISTS (SELECT 1 FROM project WHERE id = OLD.project_id)
		   AND (EXISTS (SELECT 1 FROM signoff so JOIN model_run r ON r.id = so.run_id WHERE r.scenario_id = OLD.id)
			OR EXISTS (SELECT 1 FROM evidence_pack ep WHERE ep.scenario_id = OLD.id)) THEN
			RAISE EXCEPTION 'scenario % has a signed-off run or an evidence pack, so it is kept', OLD.id
				USING ERRCODE = 'restrict_violation';
		END IF;
		RETURN OLD;
	END
	$$;
COMMENT ON FUNCTION scenario_signed_run_guard() IS
	'Refuses to delete a scenario one of whose runs is signed off, or that an evidence pack cites, so the run keeps its scenario (072_audit_trail, 036_signoff, 112_evidence_pack).';

-- Trigger functions need no EXECUTE grant (as 072's).
REVOKE ALL ON FUNCTION evidence_pack_guard(), project_pack_guard(), signoff_pack_draft() FROM PUBLIC, water_app;

-- ---------------------------------------------------------------------------
-- 4. A pack cites both its runs. Latest body: 036_signoff, with the pack's
-- clauses; same signature, SECURITY DEFINER and search_path.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION model_run_cited(p_run uuid) RETURNS boolean
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$ SELECT EXISTS (SELECT 1 FROM run_publication p WHERE p.run_id = p_run)
		OR EXISTS (SELECT 1 FROM scenario s WHERE s.base_run_id = p_run)
		OR EXISTS (SELECT 1 FROM signoff so WHERE so.run_id = p_run)
		OR EXISTS (SELECT 1 FROM evidence_pack ep WHERE ep.baseline_run_id = p_run)
		OR EXISTS (SELECT 1 FROM evidence_pack ep WHERE ep.scenario_run_id = p_run) $$;

COMMENT ON FUNCTION model_run_cited(uuid) IS
	'True for a run a publication (022_publication), a scenario (024_scenarios), a sign-off (036_signoff) or an evidence pack (112_evidence_pack) cites; assessments add their own EXISTS clause. Part of RUN_KEPT_SQL in backend/src/runs/execute.ts.';

-- ---------------------------------------------------------------------------
-- 5. The public verify lookup. Returns only what the pack prints on every
-- page, or NULL: status, version, issuedAt, catchment (the manifest's project
-- name), engineVersion, reportVersion, manifestSha256, pdfSha256,
-- successorSha256 (of the pack that superseded it), withdrawnReason,
-- methodology {version, sha256}, errata [{id, summary}] (as the manifest
-- froze them) and signers [{fullName, registrationBody,
-- registrationCategory, registrationField, registrationNo, signedAt}]. No
-- ids, no inputs, no results, no account. A draft, or a pack withdrawn
-- before it was issued, was never public: NULL, as for an unknown code.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_verify_pack(p_code text) RETURNS jsonb
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		c text := lower(regexp_replace(coalesce(p_code, ''), '[\s-]', '', 'g'));
		p evidence_pack;
	BEGIN
		IF c ~ '^[0-9a-f]{64}$' THEN
			SELECT * INTO p FROM evidence_pack WHERE manifest_sha256 = c;
		ELSIF c ~ '^[0-9a-f]{12}$' THEN
			SELECT * INTO p FROM evidence_pack WHERE left(manifest_sha256, 12) = c;
		ELSE
			RETURN NULL;
		END IF;
		IF NOT FOUND OR p.status = 'draft' OR p.issued_at IS NULL THEN
			RETURN NULL;
		END IF;
		RETURN jsonb_build_object(
			'status', p.status,
			'version', p.version,
			'issuedAt', p.issued_at,
			'catchment', p.manifest->'project'->>'name',
			'engineVersion', p.engine_version,
			'reportVersion', p.report_version,
			'manifestSha256', p.manifest_sha256,
			'pdfSha256', p.pdf_sha256,
			'successorSha256', (SELECT s.manifest_sha256 FROM evidence_pack s WHERE s.id = p.superseded_by_pack_id),
			'withdrawnReason', CASE WHEN p.status = 'withdrawn' THEN p.status_reason END,
			'methodology', jsonb_build_object(
				'version', p.manifest->'report'->'verification'->'methodology'->>'version',
				'sha256', p.manifest->'report'->'verification'->'methodology'->>'sha256'
			),
			'errata', (
				SELECT coalesce(jsonb_agg(jsonb_build_object('id', e->>'id', 'summary', e->>'summary') ORDER BY ord), '[]'::jsonb)
				FROM jsonb_array_elements(coalesce(p.manifest->'report'->'verification'->'errata', '[]'::jsonb)) WITH ORDINALITY AS x(e, ord)
			),
			'signers', (
				SELECT coalesce(jsonb_agg(jsonb_build_object(
					'fullName', s.full_name,
					'registrationBody', s.registration_body,
					'registrationCategory', s.registration_category,
					'registrationField', s.registration_field,
					'registrationNo', s.registration_no,
					'signedAt', s.signed_at
				) ORDER BY s.signed_at, s.id), '[]'::jsonb)
				FROM signoff s WHERE s.pack_id = p.id
			)
		);
	END
	$$;
REVOKE ALL ON FUNCTION app_verify_pack(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_verify_pack(text) TO water_app;
COMMENT ON FUNCTION app_verify_pack(text) IS
	'The public verify lookup (112_evidence_pack, GET /verify/:code): only the printed fields of a pack that was issued, by short code or manifest hash; NULL otherwise.';

-- ---------------------------------------------------------------------------
-- app_subject_export(): the data-subject export's signoffs carry packId (a
-- sign-off of an evidence pack has no run). Latest body: 092_signoff_registration,
-- kept as it was otherwise (same signature, SECURITY DEFINER, search_path;
-- CREATE OR REPLACE keeps 054's REVOKE / GRANT EXECUTE). The packs someone
-- drafted or issued reach the export through their audit events (pack.*,
-- actor = them), as every other action does.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_subject_export() RETURNS jsonb
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		me uuid := app_current_user_id();
		my_email citext;
		verified boolean;
		max_events constant integer := 50000;
		events jsonb;
		n_events integer;
	BEGIN
		IF me IS NULL THEN
			RETURN NULL;
		END IF;
		SELECT u.email, u.email_verified_at IS NOT NULL INTO my_email, verified FROM app_user u WHERE u.id = me;
		IF NOT FOUND THEN
			RETURN NULL;
		END IF;

		SELECT coalesce(jsonb_agg(x.ev ORDER BY x.created_at DESC, x.id DESC), '[]'::jsonb), count(*)
		INTO events, n_events
		FROM (
			SELECT jsonb_build_object(
				'id', e.id,
				'projectId', e.project_id,
				'projectName', p.name,
				'kind', e.kind,
				'at', e.created_at,
				'actor', e.actor_label,
				'byYou', e.actor_user_id IS NOT DISTINCT FROM me,
				'subject', e.subject
			) AS ev, e.created_at, e.id
			FROM audit_event e
			JOIN project p ON p.id = e.project_id
			WHERE e.actor_user_id = me
			   OR (e.subject ? 'userId' AND e.subject->>'userId' = me::text)
			   OR (e.kind = 'note.deleted' AND e.subject->>'authorId' = me::text)
			ORDER BY e.created_at DESC, e.id DESC
			LIMIT max_events + 1
		) x;
		IF n_events > max_events THEN
			events := events - max_events;
		END IF;

		RETURN jsonb_build_object(
			'auditEvents', events,
			'auditEventsTruncated', n_events > max_events,
			'invites', (
				SELECT coalesce(jsonb_agg(jsonb_build_object(
					'id', i.id,
					'projectId', i.project_id,
					'projectName', p.name,
					'projectRole', i.project_role,
					'teamId', i.team_id,
					'teamName', t.name,
					'teamRole', i.team_role,
					'invitedBy', u.display_name,
					'language', i.locale,
					'createdAt', i.created_at,
					'lastSentAt', i.last_sent_at,
					'expiresAt', i.expires_at,
					'farms', (
						SELECT coalesce(jsonb_agg(jsonb_build_object('nodeId', n.id, 'name', n.name) ORDER BY n.name), '[]'::jsonb)
						FROM invite_node inn JOIN node n ON n.id = inn.node_id WHERE inn.invite_id = i.id
					)
				) ORDER BY i.created_at DESC), '[]'::jsonb)
				FROM invite i
				LEFT JOIN project p ON p.id = i.project_id
				LEFT JOIN team t ON t.id = i.team_id
				LEFT JOIN app_user u ON u.id = i.invited_by
				WHERE verified AND i.email = my_email
			),
			'notes', (
				SELECT coalesce(jsonb_agg(jsonb_build_object(
					'id', nt.id,
					'projectId', nt.project_id,
					'projectName', p.name,
					'body', nt.body,
					'visibility', nt.visibility,
					'nodeId', nt.node_id,
					'nodeName', n.name,
					'runId', nt.run_id,
					'settingKey', nt.setting_key,
					'createdAt', nt.created_at,
					'editedAt', nt.edited_at,
					'deletedAt', nt.deleted_at
				) ORDER BY nt.created_at DESC), '[]'::jsonb)
				FROM note nt
				JOIN project p ON p.id = nt.project_id
				LEFT JOIN node n ON n.id = nt.node_id
				WHERE nt.author_id = me
			),
			'signoffs', (
				SELECT coalesce(jsonb_agg(jsonb_build_object(
					'id', s.id,
					'projectId', s.project_id,
					'projectName', p.name,
					'runId', s.run_id,
					'packId', s.pack_id,
					'fullName', s.full_name,
					'registrationBody', s.registration_body,
					'registrationCategory', s.registration_category,
					'registrationField', s.registration_field,
					'registrationNo', s.registration_no,
					'scope', s.scope,
					'statementVersion', s.statement_version,
					'statementSha256', s.statement_sha256,
					'disclaimerVersion', s.disclaimer_version,
					'signedAt', s.signed_at
				) ORDER BY s.signed_at DESC), '[]'::jsonb)
				FROM signoff s JOIN project p ON p.id = s.project_id
				WHERE s.user_id = me
			),
			'alertSubscriptions', (
				SELECT coalesce(jsonb_agg(jsonb_build_object(
					'projectId', a.project_id,
					'projectName', p.name,
					'kind', a.kind,
					'nodeId', a.node_id,
					'nodeName', n.name,
					'channel', a.channel,
					'mode', a.mode,
					'createdAt', a.created_at,
					'updatedAt', a.updated_at
				) ORDER BY p.name, a.kind), '[]'::jsonb)
				FROM alert_subscription a
				JOIN project p ON p.id = a.project_id
				LEFT JOIN node n ON n.id = a.node_id
				WHERE a.user_id = me
			),
			'reportSubscriptions', (
				SELECT coalesce(jsonb_agg(jsonb_build_object(
					'projectId', rs.project_id,
					'projectName', p.name,
					'frequency', rs.frequency,
					'weekday', rs.weekday,
					'monthDay', rs.month_day,
					'hour', rs.hour,
					'timezone', rs.timezone,
					'enabled', rs.enabled
				) ORDER BY p.name), '[]'::jsonb)
				FROM report_schedule_recipient r
				JOIN report_schedule rs ON rs.id = r.schedule_id
				JOIN project p ON p.id = rs.project_id
				WHERE r.user_id = me
			)
		);
	END
	$$;
