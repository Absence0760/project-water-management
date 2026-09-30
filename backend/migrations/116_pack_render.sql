-- 116_pack_render — the server-rendered PDF of an issued evidence pack
-- (roadmap WP-3.14 "Rendering: reuse WP-2.15", issue #71;
-- docs/evidence-pack.md § The PDF, docs/architecture.md § Server-side
-- reports, docs/security.md § Render tokens).
--
-- Issuing a pack (POST …/packs/:packId/issue) queues a `pack_render` job,
-- which prints the pack's own page (/projects/:id/packs/:packId) in headless
-- Chromium exactly as the report_render job prints the report route, and
-- records the PDF's key, SHA-256 and page count on the pack once. The PDF's
-- hash is then what GET /verify/:code returns as pdfSha256.
--
--   1. job.kind accepts 'pack_render' (latest list: 108_auto_calibration).
--   2. render_token opens a pack as well as a run: purpose 'pack', pack_id
--      (CASCADE, indexed, same-project), run_id now NULL for a pack. Exactly
--      one of them is set, and the purpose says which. render_token_issue
--      (latest: 082_report_against) checks a pack token: the issuer reads the
--      pack (RLS, as themselves) and it is past draft (only an issued pack
--      is printed). app_consume_render_token (latest: 082) consumes either
--      purpose and returns pack_id too: a new return type, so drop and
--      create, and grant again.
--   3. app_record_pack_pdf(pack, sha256, pages): the one way the PDF columns
--      are written. water_app has no UPDATE grant on them (112 withheld it:
--      the hash is printed and verified publicly, so an editor's UPDATE must
--      never set it). SECURITY DEFINER; it records only
--        - for a pack past draft,
--        - from a running pack_render job of that pack whose acting user is
--          the caller (so only the job handler's transaction, never a
--          route's),
--        - under the key derived from the ids and the hash
--          (packs/<project>/<pack>/<sha256>.pdf; backend/src/reports/storage.ts
--          packPdfKey says the same), never a key a caller names,
--      and only once: when a PDF is recorded already it changes nothing and
--      returns false (evidence_pack_guard, 112, refuses any second write,
--      the schema owner's included).
--   4. app_pack_render_target(pack): the production worker's lookup for a
--      render-results answer about a pack (reports/schedule.ts
--      acceptPackRenderResult), as app_report_render_target does for a
--      report: the project and the acting user of the pack's latest render
--      request, while the pack has no PDF.

-- ---------------------------------------------------------------------------
-- 1. job: the new kind. From 108_auto_calibration's list.
-- ---------------------------------------------------------------------------
ALTER TABLE job DROP CONSTRAINT job_kind_check;
ALTER TABLE job ADD CONSTRAINT job_kind_check
	CHECK (kind IN ('feed_fetch', 'feed_ingest', 'rerun', 'alert_eval', 'report_render', 'yield', 'sweep', 'outlook', 'auto_calibration',
		'uncertainty', 'pack_render'));

-- ---------------------------------------------------------------------------
-- 2. render_token: a pack target
-- ---------------------------------------------------------------------------
-- CASCADE: a token for a deleted pack opens nothing (only a draft is ever deleted, and a draft is never printed).
ALTER TABLE render_token ADD COLUMN pack_id uuid REFERENCES evidence_pack(id) ON DELETE CASCADE;
CREATE INDEX render_token_pack_idx ON render_token (pack_id);
ALTER TABLE render_token ALTER COLUMN run_id DROP NOT NULL;
ALTER TABLE render_token DROP CONSTRAINT render_token_purpose_check;
ALTER TABLE render_token
	ADD CONSTRAINT render_token_purpose_check CHECK (purpose IN ('report', 'pack')),
	-- A report token opens a run (and maybe a baseline); a pack token opens a pack and nothing else.
	ADD CONSTRAINT render_token_target CHECK (
		CASE purpose
			WHEN 'report' THEN run_id IS NOT NULL AND pack_id IS NULL
			WHEN 'pack' THEN pack_id IS NOT NULL AND run_id IS NULL AND against_run_id IS NULL
		END
	);
COMMENT ON COLUMN render_token.pack_id IS
	'The evidence pack a pack render session may read (116_pack_render); NULL for a report token. Readable by the issuer and past draft at issue (render_token_issue).';

CREATE TRIGGER render_token_same_project BEFORE INSERT OR UPDATE ON render_token
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('pack_id');

-- Latest definition: 082_report_against.sql. The purpose follows the target;
-- a pack token's pack is one the issuer reads (this function is SECURITY
-- INVOKER, so evidence_pack's RLS is theirs) and is past draft.
CREATE OR REPLACE FUNCTION render_token_issue() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
	BEGIN
		IF uid IS NULL THEN
			RAISE EXCEPTION 'a render token needs a signed-in user' USING ERRCODE = 'insufficient_privilege';
		END IF;
		NEW.user_id := uid;
		NEW.purpose := CASE WHEN NEW.pack_id IS NULL THEN 'report' ELSE 'pack' END;
		NEW.created_at := now();
		NEW.expires_at := now() + interval '5 minutes';
		-- The policy checks this too; saying it first keeps a stranger's
		-- refusal "not permitted" rather than "no such run".
		IF NOT app_has_role(NEW.project_id, 'viewer') THEN
			RAISE EXCEPTION 'not permitted' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF NEW.pack_id IS NOT NULL THEN
			IF NOT EXISTS (SELECT 1 FROM evidence_pack p WHERE p.id = NEW.pack_id AND p.project_id = NEW.project_id) THEN
				RAISE EXCEPTION 'not permitted' USING ERRCODE = 'insufficient_privilege';
			END IF;
			IF EXISTS (SELECT 1 FROM evidence_pack p WHERE p.id = NEW.pack_id AND p.status = 'draft') THEN
				RAISE EXCEPTION 'a draft evidence pack is not printed' USING ERRCODE = 'check_violation';
			END IF;
			RETURN NEW;
		END IF;
		IF NOT EXISTS (SELECT 1 FROM model_run r WHERE r.id = NEW.run_id AND r.project_id = NEW.project_id) THEN
			RAISE EXCEPTION 'the run is not one of the project''s' USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.against_run_id IS NOT NULL THEN
			IF NOT EXISTS (SELECT 1 FROM model_run r WHERE r.id = NEW.against_run_id AND app_has_role(r.project_id, 'viewer')) THEN
				RAISE EXCEPTION 'not permitted' USING ERRCODE = 'insufficient_privilege';
			END IF;
			IF NEW.against_run_id = NEW.run_id THEN
				RAISE EXCEPTION 'the baseline is the run itself' USING ERRCODE = 'check_violation';
			END IF;
		END IF;
		RETURN NEW;
	END
	$$;

-- Latest definition: 082_report_against.sql. Consumes either purpose and
-- returns the pack too, so the return type changes: drop and create, and
-- grant again as 082 did.
DROP FUNCTION app_consume_render_token(bytea);
CREATE FUNCTION app_consume_render_token(p_hash bytea)
	RETURNS TABLE (user_id uuid, project_id uuid, run_id uuid, against_project_id uuid, against_run_id uuid, pack_id uuid)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_user uuid;
		v_project uuid;
		v_run uuid;
		v_against uuid;
		v_pack uuid;
		v_expires timestamptz;
	BEGIN
		DELETE FROM render_token t WHERE t.token_hash = p_hash
			RETURNING t.user_id, t.project_id, t.run_id, t.against_run_id, t.pack_id, t.expires_at INTO v_user, v_project, v_run, v_against, v_pack, v_expires;
		DELETE FROM render_token t WHERE t.expires_at < now() - interval '1 day';
		IF v_user IS NULL OR v_expires <= now() THEN
			RETURN;
		END IF;
		RETURN QUERY SELECT v_user, v_project, v_run, (SELECT r.project_id FROM model_run r WHERE r.id = v_against), v_against, v_pack;
	END
	$$;
REVOKE ALL ON FUNCTION app_consume_render_token(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_consume_render_token(bytea) TO water_app;

-- ---------------------------------------------------------------------------
-- 3. Recording the PDF, once, from the render job only.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_record_pack_pdf(p_pack uuid, p_sha256 text, p_pages integer) RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
		v record;
	BEGIN
		IF uid IS NULL THEN
			RAISE EXCEPTION 'a pack''s PDF is recorded by its render job' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' OR p_pages IS NULL OR p_pages < 1 THEN
			RAISE EXCEPTION 'a pack''s PDF is a SHA-256 and at least one page' USING ERRCODE = 'check_violation';
		END IF;
		SELECT p.id, p.project_id, p.status, p.pdf_key INTO v FROM evidence_pack p WHERE p.id = p_pack FOR UPDATE;
		-- The caller's own running render job of this pack: nothing else writes these columns.
		IF NOT FOUND OR NOT EXISTS (
			SELECT 1 FROM job j
			WHERE j.project_id = v.project_id AND j.kind = 'pack_render' AND j.status = 'running' AND j.acting_user_id = uid
				AND j.payload->>'packId' = p_pack::text
		) THEN
			RAISE EXCEPTION 'a pack''s PDF is recorded by its render job' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF v.status = 'draft' THEN
			RAISE EXCEPTION 'a draft evidence pack has no PDF' USING ERRCODE = 'check_violation';
		END IF;
		-- The first PDF recorded stands (a redelivered answer, a second render).
		IF v.pdf_key IS NOT NULL THEN
			RETURN false;
		END IF;
		UPDATE evidence_pack
			SET pdf_key = format('packs/%s/%s/%s.pdf', v.project_id, v.id, p_sha256), pdf_sha256 = p_sha256, pdf_pages = p_pages
			WHERE id = p_pack;
		RETURN true;
	END
	$$;
COMMENT ON FUNCTION app_record_pack_pdf(uuid, text, integer) IS
	'Records an issued evidence pack''s PDF (key packs/<project>/<pack>/<sha256>.pdf, its SHA-256, pages) once, from the caller''s running pack_render job of it (116_pack_render). False when one is recorded already.';

-- ---------------------------------------------------------------------------
-- 4. The production worker's lookup for a render-results answer about a pack.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_pack_render_target(p_pack uuid)
	RETURNS TABLE (project_id uuid, acting_user_id uuid)
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT p.project_id, j.acting_user_id FROM evidence_pack p
		JOIN LATERAL (
			SELECT j.acting_user_id FROM job j
			WHERE j.project_id = p.project_id AND j.kind = 'pack_render' AND j.payload->>'packId' = p.id::text AND NOT (j.payload ? 'result')
			ORDER BY j.created_at DESC LIMIT 1
		) j ON true
		WHERE p.id = p_pack AND p.status <> 'draft' AND p.pdf_key IS NULL
	$$;

REVOKE ALL ON FUNCTION app_record_pack_pdf(uuid, text, integer), app_pack_render_target(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_record_pack_pdf(uuid, text, integer), app_pack_render_target(uuid) TO water_app;
