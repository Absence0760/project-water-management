-- 162_applicant_visibility — what an applicant sees, on the licensing
-- positions taken before counsel and the client confirm them (provisional
-- position, pre-counsel research, 2026-10-01; docs/legal-status.md;
-- docs/evidence-pack.md § Applicants, docs/security.md § The k rule on
-- series, docs/scenarios.md § Applications). Forward from the latest
-- definition of each function and policy it changes (CLAUDE.md rule 3),
-- named at each.
--
-- 1. An issued pack's own units are frozen at issue (build item 5). The
--    applicant's copy named "own" the application's nodes its owner *still*
--    links (app_application_own_nodes, 071), so a farm sold or unlinked
--    after issue went anonymous in the applicant's copy of a pack that was
--    about it. Now the units the pack's own report counted as the
--    applicant's (`users[].own`, frozen in the hashed manifest when the
--    draft was made, from the application run's recorded own nodes) that
--    the scenario's stored own nodes hold (frozen at submit; 071 checked
--    them against the owner's links when they were set) are theirs for
--    good, whatever the owner links later. A report without the flag reads
--    the stored list alone. The other units'
--    naming (applicantPacks.ts) starts from the same list, which the
--    database returns to the server only (`units.ownNodeIds`).
--    Signature and grants unchanged.

-- ---------------------------------------------------------------------------
-- 1. The applicant's units, frozen at issue
-- ---------------------------------------------------------------------------

-- app_applicant_pack_units, from 135_pack_security.sql (its latest).
CREATE OR REPLACE FUNCTION app_applicant_pack_units(p_report jsonb, p_own text[]) RETURNS jsonb
	LANGUAGE sql IMMUTABLE SET search_path = public
	AS $$
	WITH u AS (
		SELECT x.u FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_report->'users') = 'array' THEN p_report->'users' ELSE '[]'::jsonb END) x(u)
		WHERE jsonb_typeof(x.u) = 'object' AND x.u->>'kind' IN ('farm', 'user') AND jsonb_typeof(x.u->'nodeId') = 'string'
	), flagged AS (
		-- Theirs as the frozen report counted it (162), and only a node the application's stored list holds (p_own,
		-- guarded by 071 when it was set): a report can't make a unit the applicant's that the application never held.
		SELECT u, u->>'nodeId' = ANY (coalesce(p_own, '{}')) AND (jsonb_typeof(u->'own') <> 'boolean' OR (u->>'own')::boolean) AS own
		FROM u
	), mine AS (
		-- Their own units, and the nodes their proposals add (only in the application run).
		SELECT u FROM flagged WHERE own OR u->>'onlyIn' = 'application'
	), others AS (
		SELECT u FROM flagged
		WHERE NOT own AND u->>'onlyIn' IS NULL
		  AND jsonb_typeof(u->'change') = 'object' AND jsonb_typeof(u->'change'->'run') = 'number'
	)
	SELECT jsonb_build_object(
		'own', coalesce((
			SELECT jsonb_agg(jsonb_build_object(
				'name', u->'name',
				'kind', u->'kind',
				'onlyIn', u->'onlyIn',
				'suppliedA', u->'suppliedA',
				'suppliedB', u->'suppliedB',
				'timeReliabilityA', u->'timeReliabilityA',
				'timeReliabilityB', u->'timeReliabilityB',
				'annualReliabilityA', u->'annualReliabilityA',
				'annualReliabilityB', u->'annualReliabilityB',
				'change', CASE WHEN jsonb_typeof(u->'change') = 'object' THEN jsonb_build_object(
					'run', u->'change'->'run',
					'band', app_share_pack_band(u->'change'->'band'),
					'worse', CASE WHEN jsonb_typeof(u->'change'->'worse') = 'object'
						THEN jsonb_build_object('k', u->'change'->'worse'->'k', 'n', u->'change'->'worse'->'n') END
				) END
			) ORDER BY u->>'kind', u->>'name', u->>'nodeId')
			FROM mine
		), '[]'::jsonb),
		-- For the server only: the route keeps those downstream, names them as the results view does and drops the id (module comment).
		'others', coalesce((
			SELECT jsonb_agg(jsonb_build_object(
				'nodeId', u->'nodeId',
				'kind', u->'kind',
				-- Whole percentage points; +0 for a rounded −0.
				'changePts', round((u->'change'->>'run')::numeric) + 0
			) ORDER BY u->>'nodeId')
			FROM others
		), '[]'::jsonb),
		-- For the server only (162): the frozen own units the others are named and filtered from.
		'ownNodeIds', coalesce((SELECT jsonb_agg(u->'nodeId' ORDER BY u->>'nodeId') FROM flagged WHERE own), '[]'::jsonb)
	)
	$$;

REVOKE ALL ON FUNCTION app_applicant_pack_units(jsonb, text[]) FROM PUBLIC, water_app;

-- app_applicant_pack, from 135_pack_security.sql (its latest): the fallback
-- own list is the scenario's stored one (frozen at submit), not the links
-- its owner holds now. Same return type, so replaced in place; grants kept.
CREATE OR REPLACE FUNCTION app_applicant_pack(p_project uuid, p_pack uuid)
	RETURNS TABLE (
		pack jsonb,
		verify jsonb,
		figures jsonb,
		units jsonb,
		application_run_id uuid
	)
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	DECLARE
		v_meta jsonb;
		p evidence_pack;
		v_verify jsonb;
		v_k boolean;
		v_proposals boolean;
		v_own text[];
	BEGIN
		v_meta := app_applicant_pack_meta(p_project, p_pack);
		IF v_meta IS NULL THEN
			RETURN;
		END IF;
		SELECT ep.* INTO p FROM evidence_pack ep WHERE ep.id = p_pack AND ep.project_id = p_project;
		v_verify := app_verify_pack(p.manifest_sha256);
		IF v_verify IS NULL THEN
			RETURN;
		END IF;
		-- app_share_series' k (128's): at least 5 farm holders, counted from nobody's point of view.
		SELECT count(DISTINCT coalesce(
			(SELECT min(fl.user_id::text) FROM farm_link fl WHERE fl.node_id = n.id),
			'node:' || n.id::text
		)) >= 5 INTO v_k
		FROM node n WHERE n.project_id = p_project AND n.kind = 'farm';
		-- A report says so when it changed a baseline assumption; one that doesn't say is taken as changed.
		v_proposals := coalesce((p.manifest->'report'->>'assumptionsChanged')::boolean, true) = false;
		-- Frozen (162): the stored list, never the links its owner holds now.
		SELECT coalesce(array_agg(x::text), '{}') INTO v_own FROM scenario s, unnest(s.owned_node_ids) x WHERE s.id = p.scenario_id;

		RETURN QUERY SELECT
			v_meta,
			v_verify,
			app_share_pack_projection(p.manifest->'report', v_k AND v_proposals),
			CASE WHEN v_proposals THEN app_applicant_pack_units(p.manifest->'report', v_own) END,
			p.scenario_run_id;
	END
	$$;
COMMENT ON FUNCTION app_applicant_pack(uuid, uuid) IS
	'An application''s issued pack for its party (131_applicant_packs, 135_pack_security, 162_applicant_visibility): verify''s fields, a pack link''s figures, D2''s units frozen at issue with the other units'' ids for the server to name (never returned), and the application run. Never the manifest.';
