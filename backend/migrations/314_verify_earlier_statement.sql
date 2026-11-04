-- 314_verify_earlier_statement — the public verify lookup marks a sign-off
-- made against an earlier statement (issue #670; docs/evidence-pack.md
-- § Verification).
--
-- In this file:
--  * app_verify_pack, from its latest definition (313_fit_errata_every_location),
--    adds to each signer `statementVersion` (the sign-off statement version it
--    was made against, e.g. pack-signoff-1: a version name, never personal)
--    and `earlierStatement`, and to the pack `statementVersion`, the version
--    of the statement its issue rested on. Every sign-off stays listed: the
--    record is complete, and a sign-off of an earlier statement is marked, not
--    hidden.
--  * The statement the issue rested on is the pack's latest `specialist`
--    sign-off's. Issue needs a specialist sign-off of the pack's current
--    statement (evidence/packs.ts issueChecks), only a draft is signed, and a
--    sign-off is refused unless it is of the statement current then, which
--    only moves forward (a new erratum, limitation or disclaimer version
--    changes it; a pack's statement version is fixed by its manifest). So the
--    last specialist sign-off before issue is of the statement issue checked,
--    and any sign-off with another statement hash was made against an earlier
--    one. Compared by hash, not version: a new erratum changes the statement
--    without changing its version. A pack with no specialist sign-off (before
--    167 every sign-off was one, so none in practice) marks nothing.
--  * Nothing else changes. CREATE OR REPLACE keeps its grants (water_app and
--    the anonymous lookup call it as before); no table, policy or grant change,
--    so no RLS change. search_path stays pinned.

CREATE OR REPLACE FUNCTION app_verify_pack(p_code text) RETURNS jsonb
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		c text := lower(regexp_replace(coalesce(p_code, ''), '[\s-]', '', 'g'));
		p evidence_pack;
		-- The statement the issue rested on: its latest specialist sign-off's (314).
		i record;
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
		SELECT s.statement_sha256 AS sha, s.statement_version AS version INTO i
		FROM signoff s WHERE s.pack_id = p.id AND s.kind = 'specialist'
		ORDER BY s.signed_at DESC, s.id DESC LIMIT 1;
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
					'fitEngineVersions', to_jsonb(run_fit_engine_versions(r.inputs, r.summary))
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
					'signedAt', s.signed_at,
					-- 167: who signed as what, and the check bound at issue (none: self-declared).
					'kind', s.kind,
					'registrationCheck', (
						SELECT jsonb_build_object('checkedAt', rc.checked_at, 'checkedByOrg', rc.checked_by_org)
						FROM signoff_registration_check b JOIN registration_check rc ON rc.id = b.check_id
						WHERE b.signoff_id = s.id
					),
					-- 314: the statement it was made against, and whether that is earlier than the one the issue rested on.
					'statementVersion', s.statement_version,
					'earlierStatement', i.sha IS NOT NULL AND s.statement_sha256 IS DISTINCT FROM i.sha
				) ORDER BY s.signed_at, s.id), '[]'::jsonb)
				FROM signoff s WHERE s.pack_id = p.id
			),
			-- 314: the version of the statement the issue rested on (null: no specialist sign-off, a pack from before 167).
			'statementVersion', i.version
		);
	END
	$$;
