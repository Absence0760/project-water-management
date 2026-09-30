-- 132_verify_pack_run_engines — errata found since a pack was issued, on
-- verify (issue #71 follow-up "Errata found after issue on verify";
-- docs/evidence-pack.md § Verification, docs/api.md § Evidence packs,
-- docs/engine-errata.md).
--
-- Verify lists the errata a pack's manifest recorded when it was drafted. An
-- erratum added to docs/engine-errata.md later, for an engine the pack's runs
-- used, wasn't shown. The API now lists those too, apart and marked "found
-- since issue" (`errataFoundSince`), from the current list
-- (ENGINE_ERRATA) over the runs' engine versions and their fits'. The manifest
-- and its hash are untouched: what was recorded stays as recorded.
--
-- The errata list lives in the engine (TypeScript), so the database only
-- says which engines the pack's runs used. app_verify_pack, from its latest
-- definition (122_pack_bundle; 112 before it), returns `runs` too: per run
-- (baseline first, then the application's), its engine_version and the
-- engine of the automatic fit its parameters came from
-- (inputs.settings.fitRecord.engineVersion, null for entered parameters),
-- read from model_run past RLS, as the rest of the lookup is. A cited run is
-- never deleted (112's foreign keys have no ON DELETE), so both are there.
--
-- `runs` is for the API only: GET /verify/:code and POST /share/pack map the
-- verify object field by field (share/links.ts toVerify) and never return it;
-- they return the errata derived from it. Same signature, SECURITY DEFINER
-- and search_path (CREATE OR REPLACE keeps 112's grants). No table, policy
-- or grant changes. Forward-only; expand-only.
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
			-- For the API's errata found since issue only; never returned as is (132).
			'runs', (
				SELECT coalesce(jsonb_agg(jsonb_build_object(
					'engineVersion', r.engine_version,
					'fitEngineVersion', r.inputs->'settings'->'fitRecord'->>'engineVersion'
				) ORDER BY r.id IS DISTINCT FROM p.baseline_run_id), '[]'::jsonb)
				FROM model_run r WHERE r.id = p.baseline_run_id OR r.id = p.scenario_run_id
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
	'The public verify lookup (112_evidence_pack, 122_pack_bundle, 132_verify_pack_run_engines; GET /verify/:code): only the printed fields of a pack that was issued, by short code or manifest hash, with its PDF and bundle hashes, and its runs'' engines and fits'' engines for the errata found since issue (the API maps them to errata, never returns them); NULL otherwise.';
