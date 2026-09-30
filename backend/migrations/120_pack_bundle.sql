-- 120_pack_bundle — the evidence pack's reproduction bundle (roadmap WP-3.14
-- item 11, issue #71; docs/evidence-pack.md § Reproduction, docs/api.md §
-- Evidence packs, docs/security.md § Evidence packs).
--
-- Issuing a pack (POST …/packs/:packId/issue) builds its reproduction bundle
-- in the same transaction (engine evidence/bundle.ts, backend
-- evidence/bundle.ts): a deterministic ZIP of the manifest, both runs' stored
-- inputs and results, and every input series, which anyone re-runs with
-- `pnpm reproduce:pack`. The API stores it in the packs bucket under a key
-- derived from the ids and its SHA-256, then records it here. The bundle's
-- hash is then what GET /verify/:code returns as bundleSha256.
--
--   1. app_record_pack_bundle(pack, sha256): the one way the bundle columns
--      are written. water_app has no UPDATE grant on them (112 withheld it:
--      the hash is verified publicly, so an editor's UPDATE must never set
--      it). SECURITY DEFINER; it records only
--        - for an editor or owner of the pack's project (checked here: a
--          definer function reads past RLS),
--        - for a pack issued in this very transaction, by the caller
--          (status issued, issued_by the caller, issued_at now(): the
--          transaction's start, which evidence_pack_guard stamps on issue),
--          so only the issue route's transaction, never a later call,
--        - under the key derived from the ids and the hash
--          (packs/<project>/<pack>/<sha256>.zip; backend/src/reports/storage.ts
--          packBundleKey says the same), never a key a caller names,
--      and only once: when a bundle is recorded already it changes nothing
--      and returns NULL (evidence_pack_guard, 112, refuses any second write,
--      the schema owner's included). It returns the key it recorded, so the
--      caller can check it stored the object there.
--   2. app_verify_pack (latest: 112_evidence_pack) returns bundleSha256 too.

-- ---------------------------------------------------------------------------
-- 1. Recording the bundle, once, in the issuing transaction only.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_record_pack_bundle(p_pack uuid, p_sha256 text) RETURNS text
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
		v record;
		k text;
	BEGIN
		IF uid IS NULL THEN
			RAISE EXCEPTION 'a pack''s bundle is recorded by the user who issues it' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' THEN
			RAISE EXCEPTION 'a pack''s bundle is recorded by its SHA-256' USING ERRCODE = 'check_violation';
		END IF;
		SELECT p.id, p.project_id, p.status, p.issued_by, p.issued_at, p.bundle_key INTO v FROM evidence_pack p WHERE p.id = p_pack FOR UPDATE;
		IF NOT FOUND OR NOT app_has_role(v.project_id, 'editor') THEN
			RAISE EXCEPTION 'not permitted' USING ERRCODE = 'insufficient_privilege';
		END IF;
		-- Issued by the caller in this transaction: the issue route's, and nothing later.
		IF v.status <> 'issued' OR v.issued_by IS DISTINCT FROM uid OR v.issued_at IS DISTINCT FROM now() THEN
			RAISE EXCEPTION 'a pack''s bundle is recorded when it is issued' USING ERRCODE = 'check_violation';
		END IF;
		IF v.bundle_key IS NOT NULL THEN
			RETURN NULL;
		END IF;
		k := format('packs/%s/%s/%s.zip', v.project_id, v.id, p_sha256);
		UPDATE evidence_pack SET bundle_key = k, bundle_sha256 = p_sha256 WHERE id = p_pack;
		RETURN k;
	END
	$$;
COMMENT ON FUNCTION app_record_pack_bundle(uuid, text) IS
	'Records an evidence pack''s reproduction bundle (key packs/<project>/<pack>/<sha256>.zip and its SHA-256) once, in the transaction in which the caller, an editor, issued it (120_pack_bundle). Returns the key, or NULL when one is recorded already.';
REVOKE ALL ON FUNCTION app_record_pack_bundle(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_record_pack_bundle(uuid, text) TO water_app;

-- ---------------------------------------------------------------------------
-- 2. The public verify lookup returns the bundle's hash. Latest body:
-- 112_evidence_pack, with bundleSha256 after pdfSha256; same signature,
-- SECURITY DEFINER and search_path (CREATE OR REPLACE keeps 112's grants).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_verify_pack(p_code text) RETURNS jsonb
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
			'bundleSha256', p.bundle_sha256,
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
COMMENT ON FUNCTION app_verify_pack(text) IS
	'The public verify lookup (112_evidence_pack, 120_pack_bundle; GET /verify/:code): only the printed fields of a pack that was issued, by short code or manifest hash, with its PDF and bundle hashes; NULL otherwise.';
