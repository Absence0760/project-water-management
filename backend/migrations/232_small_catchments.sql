-- 232_small_catchments — small catchments (issue #523 G8; docs/security.md
-- § The k rule on series, docs/allocations.md § Who sees what). Two changes
-- to what a share link and an applicant (the contributor role) read of the
-- catchment's series and figures, from the licensing assessors' review of
-- #523 ("Catchment series in small catchments"):
--
--  1. A published DWS gauge record is shown at any holder count. Observed
--     flow from a DWS gauging station is published by DWS Hydrological
--     Services, so hiding it below five holders protects no one. A run marks
--     the outlet's observed series that holds one: run_series.meta gets
--     `publishedBy: 'DWS'` and `station` (runs/publishedRecords.ts, written by
--     storeRun: an outlet flow record whose every reading a DWS river-gauge
--     feed wrote, not gap-filled). Runs stored before this keep no mark, so
--     their observed flow stays under the k rule until the next run (fail
--     closed). Private loggers, the outflow and the EWR shortfall keep the
--     rule. An applicant reads the record of a published run only (a
--     scenario run is never marked); `observed_flow_other` too, when that is
--     the DWS record.
--
--  2. The dominance rule beside k (docs/followups.md "A dominance rule beside
--     k", filed with 164). k alone doesn't protect a catchment where one
--     holder does almost all the abstraction: natural flow less the outflow
--     is then mostly that holder's use. app_run_use_shown(run) is the one
--     place that decides whether a run's use may be shown to someone kept
--     from each farm: at least 5 farm holders in the catchment (the k rule,
--     as before), and, over the run's modelled supply per holder
--     (summary.farms avgSuppliedM3Day, a holder's farms summed: the lowest
--     linked user, else the farm; an application's new farms its owner's),
--     either no supply at all, or 5 or more holders with some, none above
--     80 % of the total and no two above 90 % (engine allocations/holders.ts
--     totalShown, DOMINANCE_TOP1 / DOMINANCE_TOP2: the same provisional
--     limits as the registered volumes, pending the CISO and counsel's D3
--     review, #92; app_use_parts_shown, pinned to totalShown by
--     small-catchments.db.test.ts). Used by:
--       app_share_series              the use's series of a share link
--       run_series_select_contributor through app_contributor_use_runs (new)
--       app_contributor_catchment_runs (046), on the same rule
--       app_application_run_results   farm_holders_ok: run and base
--       app_share_run_projection      a scenario link's volumes, per run
--       app_share_pack / app_applicant_pack  a pack's volume rows, both runs
--     Each from its latest definition (190, 164, 046, 188, 115, 128, 164).
--
-- No table, column or grant changes: run_series.meta is jsonb (its policies
-- and water_app's table grants cover the new keys). app_run_use_shown and
-- app_use_parts_shown are invoker's-rights helpers closed to PUBLIC and water_app (as 230 closed
-- app_authority_member): every caller is SECURITY DEFINER, so it runs as the
-- owner, and it can't be asked about another project's run.

-- ---------------------------------------------------------------------------
-- The one rule
-- ---------------------------------------------------------------------------
-- The dominance rule on a sum's parts, one per holder (engine
-- allocations/holders.ts totalShown, pinned to it by
-- small-catchments.db.test.ts): none above 0, or 5 or more above 0 with none
-- above 80 % of the sum and no two above 90 %.
CREATE FUNCTION app_use_parts_shown(p_parts double precision[]) RETURNS boolean
	LANGUAGE sql IMMUTABLE SET search_path = public
	AS $$
	WITH ranked AS (
		SELECT v, row_number() OVER (ORDER BY v DESC) AS i FROM unnest(p_parts) v WHERE v > 0
	), agg AS (
		SELECT count(*) AS n, coalesce(sum(v), 0) AS total,
			coalesce(max(v) FILTER (WHERE i = 1), 0) AS top1,
			coalesce(sum(v) FILTER (WHERE i <= 2), 0) AS top2
		FROM ranked
	)
	SELECT n = 0 OR (n >= 5 AND top1 <= 0.8 * total AND top2 <= 0.9 * total) FROM agg
	$$;
REVOKE ALL ON FUNCTION app_use_parts_shown(double precision[]) FROM PUBLIC, water_app;
COMMENT ON FUNCTION app_use_parts_shown(double precision[]) IS
	'The dominance rule on a sum''s parts, one per holder (232; engine totalShown): none above 0, or 5 or more above 0, none above 80 % and no two above 90 % of the sum (provisional, #92). Internal.';

CREATE FUNCTION app_run_use_shown(p_run uuid) RETURNS boolean
	LANGUAGE sql STABLE SET search_path = public
	AS $$
	WITH r AS (
		SELECT m.project_id, m.summary, s.owner_user_id
		FROM model_run m LEFT JOIN scenario s ON s.id = m.scenario_id AND s.project_id = m.project_id
		WHERE m.id = p_run
	), holder AS (
		-- Each node and its holder key (020's rule): the lowest linked user, or the node itself.
		SELECT n.id::text AS node_id, n.kind, coalesce(
			(SELECT min(fl.user_id::text) FROM farm_link fl WHERE fl.node_id = n.id),
			'node:' || n.id::text
		) AS key
		FROM node n JOIN r ON n.project_id = r.project_id
	), parts AS (
		-- The run's supply per holder: a farm the project no longer has (an application's new one) is its owner's.
		SELECT coalesce(h.key, r.owner_user_id::text, 'node:' || (f->>'nodeId')) AS key,
			sum(greatest(coalesce((f->>'avgSuppliedM3Day')::float8, 0), 0)) AS v
		FROM r
		CROSS JOIN jsonb_array_elements(CASE WHEN jsonb_typeof(r.summary->'farms') = 'array' THEN r.summary->'farms' ELSE '[]'::jsonb END) f
		LEFT JOIN holder h ON h.node_id = f->>'nodeId'
		GROUP BY 1
	)
	SELECT EXISTS (SELECT 1 FROM r)
		-- k: 5 or more farm holders, counted from nobody's point of view (app_share_series' count since 025).
		AND (SELECT count(DISTINCT key) FROM holder WHERE kind = 'farm') >= 5
		-- dominance: over the run's supply per holder.
		AND app_use_parts_shown(ARRAY(SELECT v FROM parts))
	$$;
REVOKE ALL ON FUNCTION app_run_use_shown(uuid) FROM PUBLIC, water_app;
COMMENT ON FUNCTION app_run_use_shown(uuid) IS
	'Whether a run''s use (outflow, observed flow, EWR shortfall, catchment volumes) may be shown to someone kept from each farm: 5 or more farm holders (k) and the dominance rule over the run''s supply per holder (none above 80 %, no two above 90 %; provisional, #92) (232, #523 G8). Internal: invoker''s rights, closed to PUBLIC and water_app; every caller is SECURITY DEFINER.';

-- The runs whose use's series the current contributor reads: their projects'
-- published runs and the application runs they read (118: every op a
-- proposal), each past the rule. Uncorrelated, so a policy evaluates it once.
CREATE FUNCTION app_contributor_use_runs() RETURNS SETOF uuid
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
			SELECT x.id FROM (
				SELECT app_contributor_published_runs() AS id
				UNION
				SELECT app_contributor_scenario_runs()
			) x
			WHERE app_run_use_shown(x.id);
	END
	$$;
REVOKE ALL ON FUNCTION app_contributor_use_runs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_contributor_use_runs() TO water_app;
COMMENT ON FUNCTION app_contributor_use_runs() IS
	'The published runs and application runs the current contributor reads whose use''s series pass the k and dominance rules (app_run_use_shown) (232). For run_series_select_contributor.';

-- app_contributor_catchment_runs, from 046 (its latest): the same rule, per run.
CREATE OR REPLACE FUNCTION app_contributor_catchment_runs() RETURNS SETOF uuid
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		RETURN QUERY
			SELECT p.run_id FROM run_publication p
			WHERE p.project_id IN (SELECT app_contributor_k_projects()) AND app_run_use_shown(p.run_id);
	END
	$$;

-- ---------------------------------------------------------------------------
-- run_series_select_contributor, from 164 (its latest)
-- ---------------------------------------------------------------------------
DROP POLICY run_series_select_contributor ON run_series;
CREATE POLICY run_series_select_contributor ON run_series FOR SELECT
	USING (
		-- An application run they read: the application's own nodes.
		(run_id, node_id) IN (SELECT n.run_id, n.node_id FROM app_contributor_run_nodes() n)
		-- The river (164): natural flow and the EWR requirement, of a published run or of an application run they read, always.
		OR (
			node_id IS NULL
			AND key IN ('natural_flow', 'ewr')
			AND (run_id IN (SELECT app_contributor_published_runs()) OR run_id IN (SELECT app_contributor_scenario_runs()))
		)
		-- A published DWS gauge record (232) of a published run, always.
		OR (
			node_id IS NULL
			AND key IN ('observed_flow', 'observed_flow_other')
			AND meta->>'publishedBy' = 'DWS'
			AND run_id IN (SELECT app_contributor_published_runs())
		)
		-- The use's series (the share links' allowlist, 025) past the k and dominance rules (232):
		-- of a published run, or of an application run they read.
		OR (
			node_id IS NULL
			AND key IN ('simulated_outflow', 'observed_flow', 'ewr_shortfall')
			AND run_id IN (SELECT app_contributor_use_runs())
		)
	);

-- ---------------------------------------------------------------------------
-- app_share_series, from 190 (its latest): a published DWS record always; the
-- use's series past the rule.
-- ---------------------------------------------------------------------------
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
			SELECT p.project_id, p.run_id, r.start_date, (r.summary->'forecast'->>'from')::date AS forecast_from
			FROM share_link s
			JOIN run_publication p ON p.project_id = s.project_id AND p.superseded_at IS NULL
			JOIN model_run r ON r.id = p.run_id
			WHERE s.token_hash = p_hash AND s.target_kind IS NULL AND s.revoked_at IS NULL AND s.expires_at > now()
			  AND p_key IN ('natural_flow', 'simulated_outflow', 'observed_flow', 'ewr', 'ewr_shortfall')
		), series AS (
			-- A forecast run's days before its first forecast day (a slice past the end clamps).
			SELECT rs.meta,
				CASE WHEN pub.forecast_from IS NULL THEN rs."values"
					ELSE rs."values"[1 : greatest(0, pub.forecast_from - pub.start_date)] END AS vals,
				pub.start_date
			FROM run_series rs JOIN pub ON rs.run_id = pub.run_id AND rs.project_id = pub.project_id
			WHERE rs.node_id IS NULL AND rs.key = p_key
			  -- The river (164): natural flow and the requirement made from it, always; a published DWS gauge
			  -- record (232) always; the use's series past the k and dominance rules (app_run_use_shown, 232).
			  AND (
				p_key IN ('natural_flow', 'ewr')
				OR (p_key = 'observed_flow' AND rs.meta->>'publishedBy' = 'DWS')
				OR app_run_use_shown(pub.run_id)
			  )
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

-- ---------------------------------------------------------------------------
-- app_share_run_projection, from 115 (its latest): a scenario link's volumes
-- per run past the dominance rule (share/links.ts drops the base's when a
-- run's are withheld).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_share_run_projection(p_run uuid, p_volumes boolean) RETURNS jsonb
	LANGUAGE sql STABLE SET search_path = public
	AS $$
	-- The volumes past the dominance rule too (232): the caller's p_volumes is the k rule and every op a proposal.
	SELECT jsonb_build_object(
		'engineVersion', r.engine_version,
		'startDate', to_char(r.start_date, 'YYYY-MM-DD'),
		'endDate', to_char(r.end_date, 'YYYY-MM-DD'),
		'createdAt', r.created_at,
		'ewrDaysNotMet', r.summary->'catchment'->'ewrDaysNotMet',
		'ewrFractionDaysNotMet', r.summary->'catchment'->'ewrFractionDaysNotMet',
		'volumes', CASE WHEN p_volumes AND app_run_use_shown(r.id) THEN jsonb_build_object(
			'meanNaturalFlowM3Day', r.summary->'catchment'->'meanNaturalFlowM3Day',
			'meanSimulatedOutflowM3Day', r.summary->'catchment'->'meanSimulatedOutflowM3Day',
			'farms', (SELECT jsonb_build_object(
					'count', count(*),
					'demandM3Day', coalesce(sum((f->>'avgDemandM3Day')::float8), 0),
					'suppliedM3Day', coalesce(sum((f->>'avgSuppliedM3Day')::float8), 0),
					-- engine compare.ts SUPPLY_TARGET
					'belowTarget', count(*) FILTER (WHERE (f->>'fractionSupplied')::float8 < 0.95)
				) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.summary->'farms') = 'array' THEN r.summary->'farms' ELSE '[]'::jsonb END) f)
		) END,
		'ewrSites', coalesce((
			SELECT jsonb_agg(jsonb_build_object(
				'name', CASE WHEN coalesce((e.s->>'isOutlet')::boolean, false) THEN NULL ELSE e.s->'name' END,
				'isOutlet', coalesce((e.s->>'isOutlet')::boolean, false),
				'months', e.s->'overall'->'months',
				'met', e.s->'overall'->'met',
				'rate', e.s->'overall'->'rate',
				'longestNotMetRun', e.s->'overall'->'longestNotMetRun',
				'deficitM3', CASE WHEN p_volumes AND app_run_use_shown(r.id) THEN e.s->'overall'->'deficitM3' END,
				'byMonth', coalesce((
					SELECT jsonb_agg(jsonb_build_object('month', m.v->'month', 'years', m.v->'years', 'met', m.v->'met', 'rate', m.v->'rate') ORDER BY m.o)
					FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.s->'byMonth') = 'array' THEN e.s->'byMonth' ELSE '[]'::jsonb END) WITH ORDINALITY m(v, o)
				), '[]'::jsonb)
			) ORDER BY e.o)
			FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.summary->'ewrAssurance') = 'array' THEN r.summary->'ewrAssurance' ELSE '[]'::jsonb END) WITH ORDINALITY e(s, o)
		), '[]'::jsonb)
	)
	FROM model_run r
	WHERE r.id = p_run
	$$;

-- ---------------------------------------------------------------------------
-- app_share_pack, from 128 (its latest), and app_applicant_pack, from 164
-- (its latest): a pack's volume rows past the dominance rule over its runs.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_share_pack(p_hash bytea)
	RETURNS TABLE (
		pack jsonb,
		verify jsonb,
		figures jsonb,
		comments jsonb
	)
	LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	DECLARE
		v_link uuid;
		v_project uuid;
		v_target uuid;
		p evidence_pack;
		v_verify jsonb;
		v_k boolean;
	BEGIN
		SELECT l.id, l.project_id, l.target_id INTO v_link, v_project, v_target FROM share_link l
		WHERE l.token_hash = p_hash AND l.target_kind = 'pack' AND l.revoked_at IS NULL AND l.expires_at > now();
		IF v_link IS NULL THEN
			RETURN;
		END IF;
		SELECT ep.* INTO p FROM evidence_pack ep WHERE ep.id = v_target AND ep.project_id = v_project;
		IF NOT FOUND OR p.status = 'draft' OR p.issued_at IS NULL THEN
			RETURN;
		END IF;
		-- Exactly what the public verify lookup answers for it: the link widens none of that.
		v_verify := app_verify_pack(p.manifest_sha256);
		IF v_verify IS NULL THEN
			RETURN;
		END IF;
		-- app_share_series' k: at least 5 farm holders, counted from nobody's point of view.
		SELECT count(DISTINCT coalesce(
			(SELECT min(fl.user_id::text) FROM farm_link fl WHERE fl.node_id = n.id),
			'node:' || n.id::text
		)) >= 5 INTO v_k
		FROM node n WHERE n.project_id = v_project AND n.kind = 'farm';
		-- And the dominance rule over both of the pack's runs (232).
		v_k := v_k AND coalesce(app_run_use_shown(p.baseline_run_id), false)
			AND (p.scenario_run_id IS NULL OR coalesce(app_run_use_shown(p.scenario_run_id), false));

		RETURN QUERY SELECT
			jsonb_build_object(
				-- Ids only so a signed-in member can comment from the page (POST …/notes); they grant nothing.
				'id', p.id,
				'projectId', p.project_id,
				'title', p.manifest->'report'->'identity'->'title',
				'mode', p.manifest->'report'->'mode',
				'version', p.version
			),
			v_verify,
			-- Figures only while the pack stands: a superseded or withdrawn one shows that, not its numbers.
			CASE WHEN p.status = 'issued' THEN app_share_pack_projection(
				p.manifest->'report',
				v_k AND coalesce((p.manifest->'report'->>'assumptionsChanged')::boolean, true) = false
			) END,
			coalesce((
				SELECT jsonb_agg(c.j ORDER BY c.created_at, c.id)
				FROM (
					SELECT n.id, n.created_at, jsonb_build_object(
						'body', n.body,
						'author', u.display_name,
						'createdAt', n.created_at,
						'editedAt', n.edited_at
					) AS j
					FROM note n LEFT JOIN app_user u ON u.id = n.author_id
					WHERE n.pack_id = p.id AND n.project_id = v_project
					  AND n.visibility = 'public_participation' AND n.deleted_at IS NULL
					-- The newest 500, shown oldest first.
					ORDER BY n.created_at DESC, n.id DESC
					LIMIT 500
				) c
			), '[]'::jsonb);
		UPDATE share_link SET last_used_at = now()
		WHERE id = v_link AND (last_used_at IS NULL OR last_used_at <= now() - interval '1 hour');
	END
	$$;

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
		-- And the dominance rule over both of the pack's runs (232).
		v_k := v_k AND coalesce(app_run_use_shown(p.baseline_run_id), false)
			AND (p.scenario_run_id IS NULL OR coalesce(app_run_use_shown(p.scenario_run_id), false));
		-- A report says so when it changed a baseline assumption; one that doesn't say is taken as changed.
		v_proposals := coalesce((p.manifest->'report'->>'assumptionsChanged')::boolean, true) = false;
		-- Frozen (164): the stored list, never the links its owner holds now.
		SELECT coalesce(array_agg(x::text), '{}') INTO v_own FROM scenario s, unnest(s.owned_node_ids) x WHERE s.id = p.scenario_id;

		RETURN QUERY SELECT
			v_meta,
			v_verify,
			app_share_pack_projection(p.manifest->'report', v_k AND v_proposals),
			CASE WHEN v_proposals THEN app_applicant_pack_units(p.manifest->'report', v_own) END,
			p.scenario_run_id;
	END
	$$;

-- ---------------------------------------------------------------------------
-- app_application_run_results, from 188 (its latest): farm_holders_ok is now
-- the k and dominance rules over the application run and its base.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_application_run_results(p_project uuid, p_scenario uuid, p_run uuid) RETURNS TABLE(label text, engine_version text, start_date date, end_date date, created_at timestamp with time zone, scenario jsonb, model jsonb, summary jsonb, base_run_id uuid, base_start_date date, base_summary jsonb, all_proposals boolean, farm_holders_ok boolean)
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NOT app_has_role(p_project, 'contributor') OR NOT app_scenario_readable(p_scenario) THEN
			RETURN;
		END IF;
		RETURN QUERY
			SELECT r.label, r.engine_version, r.start_date, r.end_date, r.created_at,
				r.inputs->'scenario', r.inputs->'model', r.summary,
				b.id, b.start_date, b.summary,
				app_run_all_proposals(r.inputs),
				-- The k and dominance rules (232) over the run and its base: the use's figures show only past both.
				coalesce(app_run_use_shown(r.id) AND app_run_use_shown(b.id), false)
			FROM model_run r
			JOIN scenario s ON s.id = r.scenario_id AND s.project_id = p_project AND s.origin = 'applicant'
			-- The base only when a publication of the project names it (an application's base always is one).
			LEFT JOIN model_run b ON b.id::text = r.inputs->'scenario'->>'baseRunId' AND b.project_id = p_project AND NOT b.from_scenario
				AND EXISTS (SELECT 1 FROM run_publication p WHERE p.run_id = b.id AND p.project_id = p_project)
			WHERE r.id = p_run AND r.project_id = p_project AND r.scenario_id = p_scenario;
	END
	$$;
