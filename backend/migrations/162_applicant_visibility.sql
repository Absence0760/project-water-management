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
--
-- 2. The k rule is split (build item 7). The catchment's natural flow and
--    its EWR requirement (derived from natural flow) describe the river,
--    not any holder's use, so a share link and an applicant read them
--    whatever the farm holder count. The impacted series (simulated
--    outflow, observed flow below the farms, EWR shortfall), from which
--    "natural minus outflow = the farms' use" follows, keep k ≥ 5 (FARMER_K),
--    as do the volume rows (app_share_run_projection, unchanged).
--      app_share_series        from 115: the k test only for an impacted key.
--      app_contributor_published_runs
--                              new: the published runs of projects where the
--                              caller is exactly a contributor, without k
--                              (app_contributor_catchment_runs, 046, is the
--                              same set with k, and stays).
--      run_series_select_contributor
--                              from 046: natural_flow and ewr of a published
--                              run, or of an application run they read
--                              (app_contributor_scenario_runs, 118), at any
--                              holder count; the impacted keys as before.
--
-- 3. Masked-rule wording (build item 6). A rule an application breaks
--    because of data its applicant can't see read only "doesn't apply to the
--    catchment as modelled", to the assessors too. The engine now gives the
--    assessors the real words (`assessorProblems`, editors and up only) and,
--    for the catchment-wide rules (flow shares, area), the applicant the
--    catchment's value and the hidden units' aggregate when those units have
--    5 or more holders (MASKED_RULE_AGGREGATE): an aggregate over that many
--    relates to no one of them. The engine can't count holders, so:
--      app_application_hidden_holders
--                              new: the farm holders of the farms outside an
--                              application's stored own nodes, its owner
--                              left out, counted as app_share_series counts
--                              them and capped at 5 (all the check needs),
--                              for a caller who reads the application; 0
--                              otherwise. The server's only: never returned.

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

-- ---------------------------------------------------------------------------
-- 2. The k rule, split: the river always, the use at k ≥ 5
-- ---------------------------------------------------------------------------

-- app_share_series, from 115_scenario_share_notes.sql (its latest): an
-- untargeted link only; natural_flow and ewr at any holder count.
CREATE OR REPLACE FUNCTION app_share_series(p_hash bytea, p_key text)
	RETURNS TABLE (
		label text,
		unit text,
		monthly_start date,
		monthly double precision[],
		recent_start date,
		recent double precision[]
	)
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		WITH pub AS (
			SELECT p.project_id, p.run_id, r.start_date
			FROM share_link s
			JOIN run_publication p ON p.project_id = s.project_id AND p.superseded_at IS NULL
			JOIN model_run r ON r.id = p.run_id
			WHERE s.token_hash = p_hash AND s.target_kind IS NULL AND s.revoked_at IS NULL AND s.expires_at > now()
			  AND p_key IN ('natural_flow', 'simulated_outflow', 'observed_flow', 'ewr', 'ewr_shortfall')
		), holders AS (
			SELECT count(DISTINCT coalesce(
				(SELECT min(fl.user_id::text) FROM farm_link fl WHERE fl.node_id = n.id),
				'node:' || n.id::text
			)) AS n
			FROM node n JOIN pub ON n.project_id = pub.project_id
			WHERE n.kind = 'farm'
		), series AS (
			SELECT rs.meta, rs."values" AS vals, pub.start_date
			FROM run_series rs JOIN pub ON rs.run_id = pub.run_id AND rs.project_id = pub.project_id
			WHERE rs.node_id IS NULL AND rs.key = p_key
			  -- The river (162): natural flow and the requirement made from it, always; the use's series at k ≥ 5.
			  AND (p_key IN ('natural_flow', 'ewr') OR (SELECT n FROM holders) >= 5)
		), days AS (
			SELECT (series.start_date + (u.o - 1)::int) AS d, NULLIF(u.v, 'NaN'::double precision) AS v
			FROM series, unnest(series.vals) WITH ORDINALITY u(v, o)
		), months AS (
			SELECT date_trunc('month', d)::date AS m, avg(v) AS v FROM days GROUP BY 1
		)
		SELECT
			coalesce(series.meta->>'label', p_key),
			coalesce(series.meta->>'unit', ''),
			date_trunc('month', series.start_date)::date,
			coalesce((SELECT array_agg(months.v ORDER BY months.m) FROM months), '{}'),
			series.start_date + greatest(0, cardinality(series.vals) - 365),
			coalesce((SELECT array_agg(days.v ORDER BY days.d) FROM days WHERE days.d >= series.start_date + greatest(0, cardinality(series.vals) - 365)), '{}')
		FROM series
	$$;

-- The published runs of the projects where the current user is exactly a
-- contributor, at any holder count: where they read the river's series.
CREATE FUNCTION app_contributor_published_runs() RETURNS SETOF uuid
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
	BEGIN
		-- Most readers are no contributor anywhere: one index probe, and done.
		IF NOT EXISTS (SELECT 1 FROM project_member WHERE user_id = uid AND role = 'contributor') THEN
			RETURN;
		END IF;
		RETURN QUERY
			SELECT p.run_id FROM run_publication p
			JOIN project_member m ON m.project_id = p.project_id AND m.user_id = uid AND m.role = 'contributor'
			WHERE app_is_contributor(p.project_id);
	END
	$$;
REVOKE ALL ON FUNCTION app_contributor_published_runs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_contributor_published_runs() TO water_app;

-- run_series_select_contributor, from 046_contributor_runs.sql (its latest).
DROP POLICY run_series_select_contributor ON run_series;
CREATE POLICY run_series_select_contributor ON run_series FOR SELECT
	USING (
		-- An application run they read: the application's own nodes.
		(run_id, node_id) IN (SELECT n.run_id, n.node_id FROM app_contributor_run_nodes() n)
		-- The river (162): natural flow and the EWR requirement, of a published run or of an application run they read, always.
		OR (
			node_id IS NULL
			AND key IN ('natural_flow', 'ewr')
			AND (run_id IN (SELECT app_contributor_published_runs()) OR run_id IN (SELECT app_contributor_scenario_runs()))
		)
		-- The use's series (the share links' allowlist, 025) under the k rule: of a
		-- published run, or of an application run they read.
		OR (
			node_id IS NULL
			AND key IN ('simulated_outflow', 'observed_flow', 'ewr_shortfall')
			AND (
				run_id IN (SELECT app_contributor_catchment_runs())
				OR (run_id IN (SELECT app_contributor_scenario_runs()) AND project_id IN (SELECT app_contributor_k_projects()))
			)
		)
	);

-- ---------------------------------------------------------------------------
-- 3. The hidden units' holders, for the masked-rule aggregate
-- ---------------------------------------------------------------------------

CREATE FUNCTION app_application_hidden_holders(p_scenario uuid) RETURNS integer
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		s record;
		n integer;
	BEGIN
		SELECT project_id, origin, status, owner_user_id, owned_node_ids INTO s FROM scenario WHERE id = p_scenario;
		IF NOT FOUND OR s.origin <> 'applicant' OR NOT app_scenario_visible(s.project_id, p_scenario, s.origin, s.status, s.owner_user_id) THEN
			RETURN 0;
		END IF;
		SELECT count(DISTINCT h.holder) INTO n
		FROM (
			SELECT coalesce((SELECT min(fl.user_id::text) FROM farm_link fl WHERE fl.node_id = nd.id), 'node:' || nd.id::text) AS holder
			FROM node nd
			WHERE nd.project_id = s.project_id AND nd.kind = 'farm' AND NOT (nd.id = ANY (s.owned_node_ids))
		) h
		-- The applicant's own other farms tell them nothing they don't know: not a holder that protects anyone.
		WHERE h.holder IS DISTINCT FROM s.owner_user_id::text;
		RETURN least(n, 5);
	END
	$$;
COMMENT ON FUNCTION app_application_hidden_holders(uuid) IS
	'The farm holders of an application''s hidden farms (outside its stored own nodes, its owner left out), capped at 5, for the check''s masked-rule aggregate (162_applicant_visibility). Server only.';
REVOKE ALL ON FUNCTION app_application_hidden_holders(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_application_hidden_holders(uuid) TO water_app;
