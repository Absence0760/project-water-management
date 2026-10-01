-- 165_applicant_copy — the applicant's printable copy of an issued evidence
-- pack (licensing build item 12; provisional position, pre-counsel research,
-- 2026-10-01; docs/evidence-pack.md § Applicants, docs/security.md § Render
-- tokens).
--
-- An application's parties read their issued packs through the D2
-- projection (131_applicant_packs, 164) but got no PDF: the pack's own PDF,
-- manifest and bundle name every unit. R267 reg 11(1) has the applicant file
-- the technical report, and what they file reaches the public (Annexure D
-- item 8), so the copy they file should withhold other water users' figures.
-- This prints the applicant's own pack page (/projects/:id/scenarios/:sid/
-- packs/:packId) in the same headless Chromium as the pack's PDF, as the
-- applicant, and keeps it beside the pack's own PDF with its own SHA-256.
-- The page says on it that it is a derived copy, not the pack, and where to
-- check the pack (verify).
--
--   1. job.kind accepts 'applicant_pack_render' (latest list:
--      154_pack_reproduce). A party of the application queues it as
--      themselves (job_insert_applicant_copy, through
--      app_applicant_copy_target), and reads their own (job_select_applicant_copy).
--   2. evidence_pack_applicant_copy: one per pack (the first recorded
--      stands), key packs/<project>/<pack>/applicant/<sha256>.pdf, SHA-256,
--      pages, when. Read by the project's viewers and up and by the pack's
--      parties; written only by app_record_applicant_pack_pdf, from the
--      caller's own running applicant_pack_render job of that pack.
--   3. render_token: purpose 'applicant_pack' (pack_id set, no run). The
--      issuer is a party of the pack's application (app_applicant_pack_meta,
--      131), not a viewer: render_token_issue (latest: 119_pack_render) and
--      render_token_insert (latest: 023_reports) say so.
--      app_consume_render_token (latest: 119) returns the purpose too, so its
--      return type changes: drop, create, grant again.
--   4. app_applicant_copy_render_target(pack): the production worker's
--      lookup for a render-results answer about an applicant copy, as
--      app_pack_render_target (119) is for the pack's own.
--   5. authorised_impact (licensing build item 8, evidence-14): page 1's
--      board against full authorised use for an application run, built by an
--      editor over the full-allocation pair and kept for the evidence report.

-- ---------------------------------------------------------------------------
-- 1. job: the new kind, and who queues and reads it
-- ---------------------------------------------------------------------------
ALTER TABLE job DROP CONSTRAINT job_kind_check;
ALTER TABLE job ADD CONSTRAINT job_kind_check
	CHECK (kind IN ('feed_fetch', 'feed_ingest', 'rerun', 'alert_eval', 'report_render', 'yield', 'sweep', 'outlook', 'auto_calibration',
		'uncertainty', 'pack_render', 'assessment', 'pack_reproduce', 'applicant_pack_render'));

-- The caller is a party of the application whose issued pack p_pack (text,
-- from a job's payload) is: app_applicant_pack_meta answers them.
CREATE FUNCTION app_applicant_copy_target(p_project uuid, p_pack text) RETURNS boolean
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF p_pack IS NULL OR p_pack !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
			RETURN false;
		END IF;
		RETURN app_applicant_pack_meta(p_project, p_pack::uuid) IS NOT NULL;
	END
	$$;
REVOKE ALL ON FUNCTION app_applicant_copy_target(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_applicant_copy_target(uuid, text) TO water_app;

CREATE POLICY job_insert_applicant_copy ON job FOR INSERT
	WITH CHECK (
		kind = 'applicant_pack_render'
		AND acting_user_id = app_current_user_id()
		AND app_applicant_copy_target(project_id, payload->>'packId')
	);
-- Their own, as a contributor reads their own yield jobs (096): what the pack
-- page says of the copy (rendering, failed). The insert policy above is what
-- holds the pack to theirs.
CREATE POLICY job_select_applicant_copy ON job FOR SELECT
	USING (kind = 'applicant_pack_render' AND acting_user_id = app_current_user_id() AND app_has_role(project_id, 'contributor'));

-- ---------------------------------------------------------------------------
-- 2. The copies
-- ---------------------------------------------------------------------------
CREATE TABLE evidence_pack_applicant_copy (
	pack_id     uuid PRIMARY KEY REFERENCES evidence_pack(id) ON DELETE CASCADE,
	project_id  uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	pdf_key     text NOT NULL,
	pdf_sha256  text NOT NULL CHECK (pdf_sha256 ~ '^[0-9a-f]{64}$'),
	pdf_pages   integer NOT NULL CHECK (pdf_pages >= 1),
	rendered_at timestamptz NOT NULL DEFAULT now(),
	CHECK (pdf_key = format('packs/%s/%s/applicant/%s.pdf', project_id, pack_id, pdf_sha256))
);
CREATE INDEX evidence_pack_applicant_copy_project_idx ON evidence_pack_applicant_copy (project_id);
CREATE TRIGGER evidence_pack_applicant_copy_same_project BEFORE INSERT OR UPDATE ON evidence_pack_applicant_copy
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('pack_id');
COMMENT ON TABLE evidence_pack_applicant_copy IS
	'The applicant''s printable copy of an issued pack (165_applicant_copy): their own pack page printed as them, other water users'' figures withheld. Not the pack: its own SHA-256. One per pack; written only by app_record_applicant_pack_pdf.';

ALTER TABLE evidence_pack_applicant_copy ENABLE ROW LEVEL SECURITY;
CREATE POLICY evidence_pack_applicant_copy_select ON evidence_pack_applicant_copy FOR SELECT
	USING (app_has_role(project_id, 'viewer') OR app_applicant_pack_meta(project_id, pack_id) IS NOT NULL);
-- Reading only: water_app writes through app_record_applicant_pack_pdf.
GRANT SELECT ON evidence_pack_applicant_copy TO water_app;

-- Record the copy once, from the caller's own running applicant_pack_render
-- job of this pack, under the key derived from the ids and the hash. False
-- when one is recorded already (the first stands).
CREATE FUNCTION app_record_applicant_pack_pdf(p_pack uuid, p_sha256 text, p_pages integer) RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
		v record;
	BEGIN
		IF uid IS NULL THEN
			RAISE EXCEPTION 'an applicant''s copy is recorded by its render job' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' OR p_pages IS NULL OR p_pages < 1 THEN
			RAISE EXCEPTION 'an applicant''s copy is a SHA-256 and at least one page' USING ERRCODE = 'check_violation';
		END IF;
		SELECT p.id, p.project_id, p.issued_at INTO v FROM evidence_pack p WHERE p.id = p_pack FOR UPDATE;
		IF NOT FOUND OR NOT EXISTS (
			SELECT 1 FROM job j
			WHERE j.project_id = v.project_id AND j.kind = 'applicant_pack_render' AND j.status = 'running' AND j.acting_user_id = uid
				AND j.payload->>'packId' = p_pack::text
		) THEN
			RAISE EXCEPTION 'an applicant''s copy is recorded by its render job' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF v.issued_at IS NULL OR app_applicant_pack_meta(v.project_id, v.id) IS NULL THEN
			RAISE EXCEPTION 'only a party of the application records its copy of a pack that was issued' USING ERRCODE = 'insufficient_privilege';
		END IF;
		INSERT INTO evidence_pack_applicant_copy (pack_id, project_id, pdf_key, pdf_sha256, pdf_pages)
		VALUES (v.id, v.project_id, format('packs/%s/%s/applicant/%s.pdf', v.project_id, v.id, p_sha256), p_sha256, p_pages)
		ON CONFLICT (pack_id) DO NOTHING;
		RETURN FOUND;
	END
	$$;
COMMENT ON FUNCTION app_record_applicant_pack_pdf(uuid, text, integer) IS
	'Records an applicant''s copy of an issued pack (key packs/<project>/<pack>/applicant/<sha256>.pdf) once, from the caller''s running applicant_pack_render job of it (165_applicant_copy). False when one is recorded already.';
REVOKE ALL ON FUNCTION app_record_applicant_pack_pdf(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_record_applicant_pack_pdf(uuid, text, integer) TO water_app;

-- ---------------------------------------------------------------------------
-- 3. render_token: the applicant's pack page
-- ---------------------------------------------------------------------------
ALTER TABLE render_token DROP CONSTRAINT render_token_purpose_check;
ALTER TABLE render_token DROP CONSTRAINT render_token_target;
ALTER TABLE render_token
	ADD CONSTRAINT render_token_purpose_check CHECK (purpose IN ('report', 'pack', 'applicant_pack')),
	ADD CONSTRAINT render_token_target CHECK (
		CASE purpose
			WHEN 'report' THEN run_id IS NOT NULL AND pack_id IS NULL
			WHEN 'pack' THEN pack_id IS NOT NULL AND run_id IS NULL AND against_run_id IS NULL
			WHEN 'applicant_pack' THEN pack_id IS NOT NULL AND run_id IS NULL AND against_run_id IS NULL
		END
	);

-- Latest definition: 119_pack_render.sql. A pack token asked for as
-- 'applicant_pack' stays one: its issuer is a party of the pack's
-- application (app_applicant_pack_meta: issued, and theirs), not a viewer.
-- Every other token as before.
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
		NEW.purpose := CASE WHEN NEW.pack_id IS NULL THEN 'report' WHEN NEW.purpose = 'applicant_pack' THEN 'applicant_pack' ELSE 'pack' END;
		NEW.created_at := now();
		NEW.expires_at := now() + interval '5 minutes';
		IF NEW.purpose = 'applicant_pack' THEN
			IF NEW.run_id IS NOT NULL OR NEW.against_run_id IS NOT NULL OR app_applicant_pack_meta(NEW.project_id, NEW.pack_id) IS NULL THEN
				RAISE EXCEPTION 'not permitted' USING ERRCODE = 'insufficient_privilege';
			END IF;
			RETURN NEW;
		END IF;
		-- The policy checks this too; saying it first keeps a stranger's
		-- refusal "not permitted" rather than "no such run".
		IF NOT app_has_role(NEW.project_id, 'viewer') THEN
			RAISE EXCEPTION 'not permitted' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF NEW.pack_id IS NOT NULL THEN
			IF NOT EXISTS (SELECT 1 FROM evidence_pack p WHERE p.id = NEW.pack_id AND p.project_id = NEW.project_id) THEN
				RAISE EXCEPTION 'not permitted' USING ERRCODE = 'insufficient_privilege';
			END IF;
			IF EXISTS (SELECT 1 FROM evidence_pack p WHERE p.id = NEW.pack_id AND p.issued_at IS NULL) THEN
				RAISE EXCEPTION 'an evidence pack that was never issued is not printed' USING ERRCODE = 'check_violation';
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

-- Latest definition: 023_reports.sql. The applicant's pack token is a
-- party's, who is no viewer; the trigger above has set the purpose and
-- checked them already.
DROP POLICY render_token_insert ON render_token;
CREATE POLICY render_token_insert ON render_token FOR INSERT
	WITH CHECK (
		user_id = app_current_user_id()
		AND (app_has_role(project_id, 'viewer') OR (purpose = 'applicant_pack' AND app_applicant_pack_meta(project_id, pack_id) IS NOT NULL))
	);

-- Latest definition: 119_pack_render.sql. Returns the purpose too: drop,
-- create, grant again.
DROP FUNCTION app_consume_render_token(bytea);
CREATE FUNCTION app_consume_render_token(p_hash bytea)
	RETURNS TABLE (user_id uuid, project_id uuid, run_id uuid, against_project_id uuid, against_run_id uuid, pack_id uuid, purpose text)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_user uuid;
		v_project uuid;
		v_run uuid;
		v_against uuid;
		v_pack uuid;
		v_purpose text;
		v_expires timestamptz;
	BEGIN
		DELETE FROM render_token t WHERE t.token_hash = p_hash
			RETURNING t.user_id, t.project_id, t.run_id, t.against_run_id, t.pack_id, t.purpose, t.expires_at
			INTO v_user, v_project, v_run, v_against, v_pack, v_purpose, v_expires;
		DELETE FROM render_token t WHERE t.expires_at < now() - interval '1 day';
		IF v_user IS NULL OR v_expires <= now() THEN
			RETURN;
		END IF;
		RETURN QUERY SELECT v_user, v_project, v_run, (SELECT r.project_id FROM model_run r WHERE r.id = v_against), v_against, v_pack, v_purpose;
	END
	$$;
REVOKE ALL ON FUNCTION app_consume_render_token(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_consume_render_token(bytea) TO water_app;

-- ---------------------------------------------------------------------------
-- 4. The production worker's lookup for a render-results answer
-- ---------------------------------------------------------------------------
-- The project and the acting user of the newest applicant_pack_render
-- request for the pack, while it was issued and has no copy recorded.
CREATE FUNCTION app_applicant_copy_render_target(p_pack uuid)
	RETURNS TABLE (project_id uuid, acting_user_id uuid)
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT p.project_id, j.acting_user_id FROM evidence_pack p
		JOIN LATERAL (
			SELECT j.acting_user_id FROM job j
			WHERE j.project_id = p.project_id AND j.kind = 'applicant_pack_render' AND j.payload->>'packId' = p.id::text AND NOT (j.payload ? 'result')
			ORDER BY j.created_at DESC LIMIT 1
		) j ON true
		WHERE p.id = p_pack AND p.issued_at IS NOT NULL
			AND NOT EXISTS (SELECT 1 FROM evidence_pack_applicant_copy c WHERE c.pack_id = p.id)
	$$;
REVOKE ALL ON FUNCTION app_applicant_copy_render_target(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_applicant_copy_render_target(uuid) TO water_app;

-- ---------------------------------------------------------------------------
-- 5. Both impact bases (licensing build item 8): the full-authorised-use board
-- ---------------------------------------------------------------------------
-- (In this file with the applicant's copy because the round's migration
-- numbers were assigned per branch; docs/model.md §2.14a, docs/evidence-pack.md
-- § Both impact bases.) Page 1's headline licence impact board judges an
-- application against full authorised use: the baseline and the application
-- both run with every holder at their registered volume. That is two model
-- runs, which a report request (a viewer's GET, a pack draft) must not carry,
-- so an editor runs the pair (POST …/runs/:runId/authorised-impact) and the
-- board the engine builds over it is kept here; the evidence report reads the
-- newest for the application run, or says why there is none. Nothing else:
-- the pair's runs aren't stored (they would count toward the run cap and show
-- in every run list), only the board, the authorised volume's mix and what
-- built them.
CREATE TABLE authorised_impact (
	id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id         uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- The application run the board is about, and its baseline (both go with the run).
	application_run_id uuid NOT NULL REFERENCES model_run(id) ON DELETE CASCADE,
	base_run_id        uuid NOT NULL REFERENCES model_run(id) ON DELETE CASCADE,
	-- The engine that ran the pair (the report reads it only when it is the baseline's).
	engine_version     text NOT NULL CHECK (char_length(engine_version) BETWEEN 1 AND 40),
	-- The project's outcome settings it was built with (year classes, and the Reserve site node, null = the outlet; the report reads it only when they are the project's now).
	year_class_method  text NOT NULL CHECK (char_length(year_class_method) BETWEEN 1 AND 40),
	reserve_site       text CHECK (reserve_site IS NULL OR char_length(reserve_site) BETWEEN 1 AND 100),
	-- engine EvidenceAuthorisedImpact with status 'ok': the board, the mix, when, which engine.
	result             jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object' AND result->>'status' = 'ok'),
	created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX authorised_impact_run_idx ON authorised_impact (application_run_id, created_at DESC);
CREATE INDEX authorised_impact_base_idx ON authorised_impact (base_run_id);
CREATE INDEX authorised_impact_project_idx ON authorised_impact (project_id);
CREATE TRIGGER authorised_impact_same_project BEFORE INSERT OR UPDATE ON authorised_impact
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('application_run_id', 'base_run_id');
COMMENT ON TABLE authorised_impact IS
	'Page 1''s licence impact board against full authorised use (165, licensing build item 8): the board over an application run''s full-allocation pair, its authorised-volume mix, engine and outcome settings. Read by whoever reads the run; written by editors; never changed (newest wins, older go).';

ALTER TABLE authorised_impact ENABLE ROW LEVEL SECURITY;
-- Whoever reads the application run (model_run's RLS, in the subquery: a draft application's run is its applicant's).
CREATE POLICY authorised_impact_select ON authorised_impact FOR SELECT
	USING (app_has_role(project_id, 'viewer') AND EXISTS (SELECT 1 FROM model_run r WHERE r.id = application_run_id));
CREATE POLICY authorised_impact_insert ON authorised_impact FOR INSERT
	WITH CHECK (app_has_role(project_id, 'editor') AND EXISTS (SELECT 1 FROM model_run r WHERE r.id = application_run_id));
-- The older boards of a run go when an editor builds a new one.
CREATE POLICY authorised_impact_delete ON authorised_impact FOR DELETE
	USING (app_has_role(project_id, 'editor'));
GRANT SELECT, INSERT, DELETE ON authorised_impact TO water_app;
