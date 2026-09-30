-- 135_pack_security — the security review of issue #71's applicant packs
-- and pack notices (a security audit of #269 and #270), forward from
-- 131_applicant_packs and 133_pack_notices (already applied: they are
-- checksummed, so they aren't edited). Each function starts from 131's
-- definition, its latest (CLAUDE.md rule 3).
--
-- 1. The other units of an applicant's pack (Medium). 131 numbered every
--    other unit in both runs by an unkeyed md5 of its node id; /base gives
--    the applicant every node id, so "Farm n" could be mapped back to a node
--    and a place in the network, and the set was wider than the results
--    view (upstream and side units too). Now app_applicant_pack_units
--    returns the other units' node id, kind and whole-point change **for the
--    server only**, and app_applicant_pack returns the pack's application
--    run for the server only too: the route (evidence/applicantPacks.ts)
--    keeps the units downstream of the application in that run's stored
--    model (app_application_run_results, 118; downstreamOf) and names them
--    as the results view does (projectBaseForApplicant over the run's
--    published base, scenarios/applicantResults.ts), then drops the ids.
--    The manifest holds no network, so the set comes from the run's stored
--    model and the names from the application's own units now, as in the
--    results view; without a published base no other unit is shown. The
--    return type changes, so app_applicant_pack is dropped and made again,
--    with its grant.
--
-- 2. A pack link's creator below editor sees and revokes it only while they
--    are still the pack's party (app_applicant_pack_meta answers them): an
--    editor demoted since, who isn't one, no longer does (Low).
--
-- 3. pack_notice: water_app holds SELECT only (Low). Every write goes
--    through 133's SECURITY DEFINER functions; the account's rows go with it
--    by the foreign key's cascade, which needs no grant. catalogue.db.test.ts
--    READ_ONLY pins it.
--
-- (The review's other Low, an application owner ranked viewer still emailed,
-- is the intended rule: 133's audience is unchanged; the docs now say so.)

-- ---------------------------------------------------------------------------
-- 1. The other units, for the server to name
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_applicant_pack_units(p_report jsonb, p_own text[]) RETURNS jsonb
	LANGUAGE sql IMMUTABLE SET search_path = public
	AS $$
	WITH u AS (
		SELECT x.u FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_report->'users') = 'array' THEN p_report->'users' ELSE '[]'::jsonb END) x(u)
		WHERE jsonb_typeof(x.u) = 'object' AND x.u->>'kind' IN ('farm', 'user') AND jsonb_typeof(x.u->'nodeId') = 'string'
	), mine AS (
		-- Their own units, and the nodes their proposals add (only in the application run).
		SELECT u FROM u WHERE u->>'nodeId' = ANY (coalesce(p_own, '{}')) OR u->>'onlyIn' = 'application'
	), others AS (
		SELECT u FROM u
		WHERE NOT (u->>'nodeId' = ANY (coalesce(p_own, '{}'))) AND u->>'onlyIn' IS NULL
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
		), '[]'::jsonb)
	)
	$$;

REVOKE ALL ON FUNCTION app_applicant_pack_units(jsonb, text[]) FROM PUBLIC, water_app;

DROP FUNCTION app_applicant_pack(uuid, uuid);
CREATE FUNCTION app_applicant_pack(p_project uuid, p_pack uuid)
	RETURNS TABLE (
		pack jsonb,
		verify jsonb,
		figures jsonb,
		units jsonb,
		-- The application run the pack froze, for the server only: the route reads its stored model through
		-- app_application_run_results (118) to find which other units are downstream (module comment).
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
		SELECT coalesce(array_agg(x::text), '{}') INTO v_own FROM unnest(app_application_own_nodes(p.scenario_id)) x;

		RETURN QUERY SELECT
			v_meta,
			v_verify,
			app_share_pack_projection(p.manifest->'report', v_k AND v_proposals),
			CASE WHEN v_proposals THEN app_applicant_pack_units(p.manifest->'report', v_own) END,
			p.scenario_run_id;
	END
	$$;
COMMENT ON FUNCTION app_applicant_pack(uuid, uuid) IS
	'An application''s issued pack for its party (131_applicant_packs, 135_pack_security): verify''s fields, a pack link''s figures, D2''s units with the other units'' ids for the server to name (never returned), and the application run. Never the manifest.';
REVOKE ALL ON FUNCTION app_applicant_pack(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_applicant_pack(uuid, uuid) TO water_app;

-- ---------------------------------------------------------------------------
-- 2. A pack link's creator, only while still its party
-- ---------------------------------------------------------------------------

-- app_share_link_visible, from 131: a pack link is its editors' and the
-- contributor's who made it while they are still the pack's party.
CREATE OR REPLACE FUNCTION app_share_link_visible(p_project uuid, p_kind text, p_target uuid, p_created_by uuid) RETURNS boolean
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF app_has_role(p_project, 'owner') THEN
			RETURN true;
		END IF;
		IF p_kind = 'scenario' THEN
			RETURN (app_has_role(p_project, 'editor') AND app_scenario_readable(p_target))
				OR (p_created_by = app_current_user_id() AND app_has_role(p_project, 'contributor'));
		END IF;
		IF p_kind = 'pack' THEN
			RETURN app_has_role(p_project, 'editor')
				OR (p_created_by = app_current_user_id() AND app_applicant_pack_meta(p_project, p_target) IS NOT NULL);
		END IF;
		RETURN false;
	END
	$$;

-- ---------------------------------------------------------------------------
-- 3. pack_notice: read only
-- ---------------------------------------------------------------------------

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON pack_notice FROM water_app;
