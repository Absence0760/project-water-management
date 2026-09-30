-- 131_applicant_packs — an applicant reads and shares their own
-- application's issued evidence packs (roadmap WP-3.15; issue #71;
-- docs/evidence-pack.md § Applicants, docs/data-model.md § Evidence packs,
-- docs/security.md § Evidence packs → An applicant's packs, docs/api.md
-- § Evidence packs → An applicant's packs).
--
-- Expand-only. Issuing, superseding and withdrawing stay with the project's
-- editors (operator decision, 2026-09-29): nothing here writes a pack.
--
-- Why no row policy on evidence_pack. The pack's `manifest` is the whole
-- evidence report: every hydrological unit's name and figures, the
-- registered volumes and their holders, the other applications, the
-- settings and model. RLS picks rows, not columns, and water_app holds
-- table-wide SELECT on evidence_pack (112), so a contributor SELECT policy
-- would hand an applicant every farm in the catchment. Instead, as the share
-- links do (app_share_pack, 128), an applicant reads a pack only through
-- SECURITY DEFINER functions that build an allowlisted projection of the
-- frozen report. A route that forgets to project can't leak what the
-- database never returned.
--
-- Who reads (app_applicant_pack_meta): the application's parties
-- (app_scenario_party, 115: its owner or someone they shared it with
-- through scenario_member, as a contributor or above), for a pack of an
-- application (origin 'applicant') of this project that was issued: issued,
-- superseded or withdrawn after issue, each with its standing. Never a
-- draft, nor a pack withdrawn before it was issued (as verify, 112).
--
-- What they read (app_applicant_pack), D2's recommended default
-- (docs/roadmap/step-3-licensing.md § WP-3.3, pending the client), never
-- wider than the pack:
--   - `pack`: its id, scenario, title, mode, version, standing, issue date,
--     manifest hash, its predecessor and successor (packs of the same
--     application), the withdrawal reason (verify's already), whether the
--     caller is the application's owner, and whether they may link it (the
--     owner, while it is issued);
--   - `verify`: exactly what GET /verify/:code answers (app_verify_pack);
--   - `figures`: exactly what a pack link shows while the pack is issued
--     (app_share_pack_projection, 128: the river's rows and sites, the paired
--     change by month, the volume rows only past the k rule and without a
--     changed baseline assumption), here for every standing, since the
--     applicant is the pack's party, not the public;
--   - `units`, D2's anonymising: their own units (the application's owned
--     nodes the owner still links, app_application_own_nodes, 071; and the
--     nodes its proposals add) by name with their supply and reliability,
--     baseline beside application; every other farm or water user present in
--     both runs only as "Farm n" / "Water user n" (numbered by a hash of its
--     id, so the number says nothing about its name or place and stays the
--     same across versions) with its change in share of demand supplied, in
--     whole percentage points. NULL when the report changed a baseline
--     assumption (app_run_all_proposals' rule, 118: such a change could read
--     another unit's values out through every figure that moves with it).
--   Never another unit's name, id, demand, volumes or reliability, the
--   registered volumes or their holders, the other applications, the flags
--   and questions (they name units), the settings, model, input diff, series
--   hashes, warnings, the applicant statement, or any person but the signers
--   verify already names. Not the PDF, the manifest or the reproduction
--   bundle: each carries the whole report (the assessor's copy, D2).
--
-- Share links (from 128's definitions): the application's owner links their
-- own issued pack (app_share_link_creatable), and lists and revokes the pack
-- links they made (app_share_link_visible), as for a scenario link (115).
-- Editors and the project owner are unchanged.

-- ---------------------------------------------------------------------------
-- 1. What an applicant reads
-- ---------------------------------------------------------------------------

-- One pack as its application's party sees it, or NULL (module comment).
CREATE FUNCTION app_applicant_pack_meta(p_project uuid, p_pack uuid) RETURNS jsonb
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		p evidence_pack;
		v_owner uuid;
	BEGIN
		SELECT ep.* INTO p FROM evidence_pack ep WHERE ep.id = p_pack AND ep.project_id = p_project;
		IF NOT FOUND OR p.scenario_id IS NULL OR p.status = 'draft' OR p.issued_at IS NULL THEN
			RETURN NULL;
		END IF;
		SELECT s.owner_user_id INTO v_owner FROM scenario s
		WHERE s.id = p.scenario_id AND s.project_id = p_project AND s.origin = 'applicant';
		IF NOT FOUND OR NOT app_scenario_party(p.scenario_id) THEN
			RETURN NULL;
		END IF;
		RETURN jsonb_build_object(
			'id', p.id,
			'scenarioId', p.scenario_id,
			'title', p.manifest->'report'->'identity'->>'title',
			'mode', p.manifest->'report'->>'mode',
			'version', p.version,
			'status', p.status,
			'issuedAt', p.issued_at,
			'manifestSha256', p.manifest_sha256,
			'supersedesId', p.supersedes_pack_id,
			'supersededById', p.superseded_by_pack_id,
			'withdrawnReason', CASE WHEN p.status = 'withdrawn' THEN p.status_reason END,
			-- The application's owner: they list and revoke the links they made, whatever its standing.
			'isOwner', v_owner = app_current_user_id(),
			-- As for a scenario link: the owner makes one while the pack stands.
			'canShare', p.status = 'issued' AND v_owner = app_current_user_id()
		);
	END
	$$;
COMMENT ON FUNCTION app_applicant_pack_meta(uuid, uuid) IS
	'An issued (or since superseded or withdrawn) pack of an application, for its parties (app_scenario_party): lifecycle fields only, never the manifest (131_applicant_packs). NULL otherwise.';

-- An application's packs as its party sees them, newest first (the Application panel's list).
CREATE FUNCTION app_applicant_packs(p_project uuid, p_scenario uuid) RETURNS SETOF jsonb
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	SELECT m FROM (
		SELECT app_applicant_pack_meta(p_project, ep.id) AS m, ep.version, ep.id
		FROM evidence_pack ep
		WHERE ep.project_id = p_project AND ep.scenario_id = p_scenario AND ep.status <> 'draft' AND ep.issued_at IS NOT NULL
	) x
	WHERE m IS NOT NULL
	ORDER BY x.version DESC, x.id
	$$;
COMMENT ON FUNCTION app_applicant_packs(uuid, uuid) IS
	'The packs of one application its party reads (app_applicant_pack_meta), newest version first (131_applicant_packs).';

-- D2's anonymising of the report's § 4 users (module comment). Pure; called
-- only from app_applicant_pack, not by water_app.
CREATE FUNCTION app_applicant_pack_units(p_report jsonb, p_own text[]) RETURNS jsonb
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
	), numbered AS (
		SELECT u, row_number() OVER (PARTITION BY u->>'kind' ORDER BY md5(u->>'nodeId'), u->>'nodeId') AS n FROM others
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
		'others', coalesce((
			SELECT jsonb_agg(jsonb_build_object(
				'kind', u->'kind',
				'n', n,
				-- Whole percentage points; +0 for a rounded −0.
				'changePts', round((u->'change'->>'run')::numeric) + 0
			) ORDER BY u->>'kind', n)
			FROM numbered
		), '[]'::jsonb)
	)
	$$;
REVOKE ALL ON FUNCTION app_applicant_pack_units(jsonb, text[]) FROM PUBLIC, water_app;

-- One pack's page as its application's party sees it (module comment). No
-- row when app_applicant_pack_meta answers NULL.
CREATE FUNCTION app_applicant_pack(p_project uuid, p_pack uuid)
	RETURNS TABLE (
		pack jsonb,
		verify jsonb,
		figures jsonb,
		units jsonb
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
			CASE WHEN v_proposals THEN app_applicant_pack_units(p.manifest->'report', v_own) END;
	END
	$$;
COMMENT ON FUNCTION app_applicant_pack(uuid, uuid) IS
	'An application''s issued pack for its party (131_applicant_packs): verify''s fields, a pack link''s figures and D2''s anonymised units. Never the manifest.';

GRANT EXECUTE ON FUNCTION app_applicant_pack_meta(uuid, uuid), app_applicant_packs(uuid, uuid), app_applicant_pack(uuid, uuid) TO water_app;

-- ---------------------------------------------------------------------------
-- 2. Share links: the applicant's own pack links
-- ---------------------------------------------------------------------------

-- app_share_link_visible, from 128: a pack link is its editors' and, as a
-- scenario link, the contributor's who made it.
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
				OR (p_created_by = app_current_user_id() AND app_has_role(p_project, 'contributor'));
		END IF;
		RETURN false;
	END
	$$;

-- app_share_link_creatable, from 128: an editor links an issued pack of this
-- project, and the application's owner (a contributor) their own issued one.
CREATE OR REPLACE FUNCTION app_share_link_creatable(p_project uuid, p_kind text, p_target uuid) RETURNS boolean
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_owner uuid;
	BEGIN
		IF p_kind IS NULL THEN
			RETURN app_has_role(p_project, 'owner');
		END IF;
		IF p_kind = 'scenario' THEN
			SELECT s.owner_user_id INTO v_owner FROM scenario s
			WHERE s.id = p_target AND s.project_id = p_project AND s.status IN ('submitted', 'decided') AND s.origin = 'applicant';
			IF NOT FOUND THEN
				RETURN false;
			END IF;
			RETURN (app_has_role(p_project, 'editor') AND app_scenario_readable(p_target))
				OR (v_owner = app_current_user_id() AND app_has_role(p_project, 'contributor'));
		END IF;
		IF p_kind = 'pack' THEN
			IF NOT EXISTS (SELECT 1 FROM evidence_pack p WHERE p.id = p_target AND p.project_id = p_project AND p.status = 'issued') THEN
				RETURN false;
			END IF;
			RETURN app_has_role(p_project, 'editor')
				OR coalesce((app_applicant_pack_meta(p_project, p_target)->>'canShare')::boolean, false);
		END IF;
		RETURN false;
	END
	$$;
-- share_link_select / _insert / _update (115) call these two unchanged.
