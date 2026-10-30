-- 289_calibration_locations — engine 1.110.0 calibrates at any gauge, none
-- required (issue #659; docs/model.md §2.10n, docs/engine-audit.md CZ2,
-- docs/data-model.md § Project settings). Every gauge with a record, and the
-- outlet, is a calibration location, and none is special:
--
-- * an inner gauge's location is its row of settings.calibrationZones (the
--   row shape #555 stored, 270), which may now lie anywhere on the network;
-- * the outlet's location is the top-level calibration keys (window, flow
--   kind, exclusions, quality flags, gr4j, fitRecord), ticked by the new
--   settings.calibrateAtOutlet;
-- * settings.calibrationSiteNodeId is the optional headline pointer (whose
--   statistics are the run's calibration statistics), no longer a special
--   zone;
-- * settings.calibrationRest says what the units with no ticked location
--   downstream take ('nearest' | 'headline' | 'default'), and the optional
--   settings.unitParamsFrom gives a unit another location's parameters.
--
-- 1. Settings (data). Every project whose object settings has no boolean
--    calibrateAtOutlet gets the shape the engine's read-time conversion
--    gives it (engine calibrate/locations.ts normalizeCalibrationLocations),
--    so every run and fit stays the same, to the bit
--    (backend/src/model/examples.zones.test.ts; migration-289.db.test.ts
--    asserts this SQL agrees with the engine on every case):
--
--    * calibrationSiteNodeId names a gauge of the project that drains
--      somewhere (an inner gauge G): the top-level window (an ISO date each;
--      a reversed window is the whole record, as the engine reads it), flow
--      kind, exclusions, { suspect, zeroFlowMonths } (sorted; the default
--      'exclude' when unset) and GR4J X1–X4 (the engine's defaults where
--      unset; null when out of range) become G's ticked row, replacing a row
--      G had, and the fit record moves into it (the top-level one becomes
--      null; the engine reads a moved record, whose zone is absent or null,
--      as its row's own). Every other ticked row at or below G is unticked:
--      engines before left those out as unusable. calibrateAtOutlet false,
--      calibrationRest 'headline' (the units no gauge claims took the site's
--      parameters), and G stays the headline pointer. The top-level keys keep
--      their values: they are the outlet record's settings, which its other
--      readers (gauged ranges, gap filling, missing and low-flow periods, the
--      outlet EWR test) read. A regional-prior start record
--      (settings.gr4jPrior, calibration/prior.ts) whose target was the site's
--      zone (zoneNodeId null) now names G. The exclusions and the other rows
--      are copied as stored: the API validated them on save, and the engine
--      sanitises a row (a bad exclusion dropped, a repeated gauge's second
--      row ignored) on every read, as it did the top level.
--    * otherwise (the outlet, or a site that is gone or isn't an inner gauge,
--      which engines before scored at the outlet): the pointer becomes null
--      and calibrateAtOutlet is whether the project has an outlet record (a
--      flow record with no site, 084), calibrationRest 'headline' with one
--      and 'default' without (the units on settings.gr4j either way). The
--      engine's read path can't see records and assumes one, so a fit that
--      failed at an outlet without a record now fits the gauges instead.
--
--    Stored runs (model_run.inputs), model revisions and scenarios keep their
--    JSON: the engine converts a snapshot when it reads it, and so does the
--    API when it restores or imports one (projects/calibrationSite.ts
--    locatedSettings). Non-object settings and team.settings are untouched.
--
-- 2. run_fit_engine_version(inputs, summary): the engine of the fit a run's
--    headline parameters came from, which a `fit` erratum keys on (153). It
--    was inputs.settings.fitRecord; once a gauge's location is the headline,
--    its row's. The headline is the location summary.unitRain.zones marks
--    `headline` (engine 1.110.0): a gauge's (kind 'gauge') reads its row's
--    fit record, the outlet's, a run with no gauge location and every run
--    before 1.110.0 the top level (a legacy snapshot's site record is there).
--    app_erratum_sweep (153), app_verify_pack (167) and app_specialist_pack
--    (280) call it, from their latest definitions with only that expression
--    changed; CREATE OR REPLACE keeps their grants. The API reads it the
--    same way (runs/read.ts RUN_META, signoffs, evidence packs).
--
-- No table, policy or grant change, so no RLS change. The new function is
-- IMMUTABLE, reads only its arguments, pins search_path, and water_app gets
-- EXECUTE from the owner's default privileges (028).

-- ---------------------------------------------------------------------------
-- 1. Settings
-- ---------------------------------------------------------------------------
WITH legacy AS (
	SELECT p.id, p.settings AS s,
		CASE WHEN jsonb_typeof(p.settings -> 'calibrationSiteNodeId') = 'string' THEN p.settings ->> 'calibrationSiteNodeId' END AS site
	FROM project p
	WHERE jsonb_typeof(p.settings) = 'object'
		AND jsonb_typeof(p.settings -> 'calibrateAtOutlet') IS DISTINCT FROM 'boolean'
),
located AS (
	SELECT l.id, l.s,
		-- The inner gauge the site names (calibrationLocationError: a gauge of the project that isn't the outlet).
		(SELECT n.id FROM node n
		 WHERE n.project_id = l.id AND n.id::text = l.site AND n.kind = 'gauge' AND n.downstream_node_id IS NOT NULL) AS g,
		EXISTS (
			SELECT 1 FROM time_series t
			WHERE t.project_id = l.id AND t.site_node_id IS NULL AND t.kind IN ('flow_observed_m3s', 'flow_logger_m3s')
		) AS outlet_record
	FROM legacy l
),
-- The top-level values the engine reads (prepare.ts mergeSettings), for the site's row.
site_values AS (
	SELECT x.id, x.s, x.g,
		-- An ISO day (a month and day that can be; the engine's Date.parse check), else none.
		CASE WHEN jsonb_typeof(x.s -> 'calibrationStart') = 'string' AND x.s ->> 'calibrationStart' ~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$' THEN x.s ->> 'calibrationStart' END AS ws,
		CASE WHEN jsonb_typeof(x.s -> 'calibrationEnd') = 'string' AND x.s ->> 'calibrationEnd' ~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$' THEN x.s ->> 'calibrationEnd' END AS we,
		-- X1–X4 over the engine's defaults (gr4jDefaults, engine 1.110.0).
		coalesce(nullif(gr.v -> 'x1', 'null'::jsonb), '350'::jsonb) AS x1,
		coalesce(nullif(gr.v -> 'x2', 'null'::jsonb), '0'::jsonb) AS x2,
		coalesce(nullif(gr.v -> 'x3', 'null'::jsonb), '90'::jsonb) AS x3,
		coalesce(nullif(gr.v -> 'x4', 'null'::jsonb), '1.7'::jsonb) AS x4,
		qf.v AS qf,
		-- The river-stops months when they are whole calendar months, each once (zeroFlowMonthsError), else none.
		CASE WHEN jsonb_typeof(qf.v -> 'zeroFlowMonths') = 'array' THEN
			CASE WHEN NOT EXISTS (
					SELECT 1 FROM jsonb_array_elements(qf.v -> 'zeroFlowMonths') m
					WHERE jsonb_typeof(m) <> 'number' OR m::text !~ '^([1-9]|1[0-2])$'
				) AND (SELECT count(DISTINCT m) = count(*) FROM jsonb_array_elements(qf.v -> 'zeroFlowMonths') m)
			THEN (SELECT jsonb_agg(m ORDER BY m::text::integer) FROM jsonb_array_elements(qf.v -> 'zeroFlowMonths') m)
			END
		END AS zfm
	FROM located x
	CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(x.s -> 'gr4j') = 'object' THEN x.s -> 'gr4j' ELSE '{}'::jsonb END AS v) gr
	CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(x.s -> 'qualityFlags') = 'object' THEN x.s -> 'qualityFlags' ELSE '{}'::jsonb END AS v) qf
	WHERE x.g IS NOT NULL
),
site_row AS (
	SELECT v.id, v.s, v.g,
		jsonb_build_object(
			'nodeId', v.g::text,
			'enabled', true,
			-- A window that ends before it starts is the whole record (calibration.windowReversed).
			'calibrationStart', CASE WHEN v.ws > v.we THEN NULL ELSE v.ws END,
			'calibrationEnd', CASE WHEN v.ws > v.we THEN NULL ELSE v.we END,
			'calibrationFlowKind', CASE WHEN v.s ->> 'calibrationFlowKind' IN ('flow_observed_m3s', 'flow_logger_m3s') THEN v.s -> 'calibrationFlowKind' ELSE 'null'::jsonb END,
			'calibrationExclusions', CASE WHEN jsonb_typeof(v.s -> 'calibrationExclusions') = 'array' THEN v.s -> 'calibrationExclusions' ELSE '[]'::jsonb END,
			'qualityFlags', jsonb_build_object('suspect', CASE WHEN v.qf ->> 'suspect' IN ('exclude', 'include') THEN v.qf ->> 'suspect' ELSE 'exclude' END)
				|| CASE WHEN jsonb_array_length(coalesce(v.zfm, '[]'::jsonb)) > 0 THEN jsonb_build_object('zeroFlowMonths', v.zfm) ELSE '{}'::jsonb END,
			-- Null (its units take the catchment's) when one is not a number in its range (zoneParamsError). Nested, so a
			-- value is cast only once it is known to be a number.
			'gr4j', CASE
				WHEN jsonb_typeof(v.x1) = 'number' AND jsonb_typeof(v.x2) = 'number' AND jsonb_typeof(v.x3) = 'number' AND jsonb_typeof(v.x4) = 'number' THEN
					CASE WHEN v.x1::text::numeric BETWEEN 10 AND 3000 AND v.x2::text::numeric BETWEEN -5 AND 3
						AND v.x3::text::numeric BETWEEN 1 AND 1000 AND v.x4::text::numeric BETWEEN 0.5 AND 10
					THEN jsonb_build_object('x1', v.x1, 'x2', v.x2, 'x3', v.x3, 'x4', v.x4)
					ELSE 'null'::jsonb END
				ELSE 'null'::jsonb
			END,
			'fitRecord', coalesce(v.s -> 'fitRecord', 'null'::jsonb)
		) AS row
	FROM site_values v
),
inner_site AS (
	SELECT r.id,
		r.s || jsonb_build_object(
			-- The other rows in their order, every ticked one at or below the site unticked, then the site's.
			'calibrationZones', (
				WITH RECURSIVE below(id) AS (
					SELECT r.g
					UNION
					SELECT n.downstream_node_id FROM node n JOIN below b ON n.id = b.id WHERE n.downstream_node_id IS NOT NULL
				)
				SELECT coalesce(jsonb_agg(
					CASE WHEN z -> 'enabled' = 'true'::jsonb AND z ->> 'nodeId' IN (SELECT id::text FROM below)
						THEN jsonb_set(z, '{enabled}', 'false'::jsonb) ELSE z END
					ORDER BY ord), '[]'::jsonb)
				FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.s -> 'calibrationZones') = 'array' THEN r.s -> 'calibrationZones' ELSE '[]'::jsonb END) WITH ORDINALITY AS a(z, ord)
				WHERE jsonb_typeof(z) = 'object' AND jsonb_typeof(z -> 'nodeId') = 'string' AND z ->> 'nodeId' <> '' AND z ->> 'nodeId' <> r.g::text
			) || jsonb_build_array(r.row),
			'fitRecord', NULL,
			'calibrateAtOutlet', false,
			'calibrationRest', 'headline',
			'calibrationSiteNodeId', r.g::text
		)
		-- A prior start for the site's zone (target zoneNodeId null) is G's now.
		|| CASE WHEN jsonb_typeof(r.s -> 'gr4jPrior') = 'array' THEN jsonb_build_object('gr4jPrior', (
				SELECT coalesce(jsonb_agg(
					CASE WHEN jsonb_typeof(p -> 'provenance' -> 'target') = 'object' AND coalesce(p -> 'provenance' -> 'target' -> 'zoneNodeId', 'null'::jsonb) = 'null'::jsonb
						THEN jsonb_set(p, '{provenance,target,zoneNodeId}', to_jsonb(r.g::text)) ELSE p END
					ORDER BY ord), '[]'::jsonb)
				FROM jsonb_array_elements(r.s -> 'gr4jPrior') WITH ORDINALITY AS a(p, ord)
			)) ELSE '{}'::jsonb END AS settings
	FROM site_row r
)
UPDATE project p
SET settings = coalesce(
	(SELECT i.settings FROM inner_site i WHERE i.id = x.id),
	x.s || jsonb_build_object(
		'calibrateAtOutlet', x.outlet_record,
		'calibrationRest', CASE WHEN x.outlet_record THEN 'headline' ELSE 'default' END,
		'calibrationSiteNodeId', NULL
	)
)
FROM located x
WHERE p.id = x.id;

-- ---------------------------------------------------------------------------
-- 2. The engine of the fit a run's headline parameters came from
-- ---------------------------------------------------------------------------
CREATE FUNCTION run_fit_engine_version(p_inputs jsonb, p_summary jsonb) RETURNS text
	LANGUAGE sql IMMUTABLE SET search_path = public
	AS $$
		SELECT CASE
			WHEN h ->> 'kind' = 'gauge' THEN (
				SELECT z -> 'fitRecord' ->> 'engineVersion'
				FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_inputs -> 'settings' -> 'calibrationZones') = 'array' THEN p_inputs -> 'settings' -> 'calibrationZones' ELSE '[]'::jsonb END) z
				WHERE z ->> 'nodeId' = h ->> 'nodeId'
				LIMIT 1
			)
			ELSE p_inputs -> 'settings' -> 'fitRecord' ->> 'engineVersion'
		END
		FROM (
			SELECT (
				SELECT zz FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_summary -> 'unitRain' -> 'zones') = 'array' THEN p_summary -> 'unitRain' -> 'zones' ELSE '[]'::jsonb END) zz
				WHERE zz -> 'headline' = 'true'::jsonb
				LIMIT 1
			) AS h
		) x
	$$;
COMMENT ON FUNCTION run_fit_engine_version(jsonb, jsonb) IS
	'The engine version of the fit a run''s headline parameters came from (289, issue #659): the headline gauge''s row''s fit record (summary.unitRain.zones, engine 1.110.0), else settings.fitRecord; NULL for entered parameters. What a `fit` erratum keys on (153).';

-- ---------------------------------------------------------------------------
-- app_erratum_sweep, from 153_erratum_notices.sql: a `fit` erratum keys on
-- run_fit_engine_version. Nothing else changes.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_erratum_sweep(p_errata jsonb) RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		e record;
		lo integer[];
		hi integer[];
		n integer;
		total integer := 0;
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker sweeps errata' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_errata IS NULL OR jsonb_typeof(p_errata) <> 'array' OR jsonb_array_length(p_errata) > 1000 THEN
			RAISE EXCEPTION 'errata: a JSON array of at most 1000' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		FOR e IN SELECT * FROM jsonb_to_recordset(p_errata) AS x(id text, "keyedOn" text, "firstAffected" text, "fixedIn" text) LOOP
			IF e.id IS NULL OR e.id !~ '^ER-[1-9][0-9]*$' OR e."keyedOn" IS NULL OR e."keyedOn" NOT IN ('run', 'fit')
				OR engine_version_key(e."firstAffected") IS NULL OR (e."fixedIn" IS NOT NULL AND engine_version_key(e."fixedIn") IS NULL) THEN
				RAISE EXCEPTION 'not an erratum: %', left(e.id, 20) USING ERRCODE = 'invalid_parameter_value';
			END IF;
			-- Swept already with this range: nothing to do.
			CONTINUE WHEN EXISTS (
				SELECT 1 FROM erratum_sweep s WHERE s.erratum_id = e.id AND s.keyed_on = e."keyedOn"
					AND s.first_affected = e."firstAffected" AND s.fixed_in IS NOT DISTINCT FROM e."fixedIn"
			);
			lo := engine_version_key(e."firstAffected");
			hi := engine_version_key(e."fixedIn");
			WITH affected AS (
				SELECT r.project_id, count(*)::integer AS runs
				FROM model_run r
				CROSS JOIN LATERAL (SELECT engine_version_key(CASE WHEN e."keyedOn" = 'fit'
					THEN run_fit_engine_version(r.inputs, r.summary) ELSE r.engine_version END) AS v) k
				WHERE k.v >= lo AND (hi IS NULL OR k.v < hi)
				GROUP BY r.project_id
			), owners AS (
				SELECT m.project_id, m.user_id FROM project_member m JOIN affected a ON a.project_id = m.project_id WHERE m.role = 'owner'
				UNION
				SELECT p.id, tm.user_id FROM project p JOIN affected a ON a.project_id = p.id
				JOIN team_member tm ON tm.team_id = p.team_id WHERE tm.role = 'admin'
			)
			INSERT INTO erratum_notice (erratum_id, project_id, user_id, run_count)
				SELECT e.id, o.project_id, o.user_id, a.runs
				FROM owners o JOIN affected a ON a.project_id = o.project_id
				JOIN app_user u ON u.id = o.user_id
				WHERE u.email_verified_at IS NOT NULL AND u.mail_suppressed_at IS NULL
				ON CONFLICT DO NOTHING;
			GET DIAGNOSTICS n = ROW_COUNT;
			total := total + n;
			INSERT INTO erratum_sweep (erratum_id, keyed_on, first_affected, fixed_in) VALUES (e.id, e."keyedOn", e."firstAffected", e."fixedIn")
				ON CONFLICT (erratum_id) DO UPDATE SET keyed_on = EXCLUDED.keyed_on, first_affected = EXCLUDED.first_affected,
					fixed_in = EXCLUDED.fixed_in, swept_at = now();
		END LOOP;
		RETURN total;
	END
	$$;

-- ---------------------------------------------------------------------------
-- app_verify_pack, from 167_signers.sql: its runs' fits' engines through
-- run_fit_engine_version. Nothing else changes.
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
			-- For the API's errata found since issue only; never returned as is (132).
			'runs', (
				SELECT coalesce(jsonb_agg(jsonb_build_object(
					'engineVersion', r.engine_version,
					'fitEngineVersion', run_fit_engine_version(r.inputs, r.summary)
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
					)
				) ORDER BY s.signed_at, s.id), '[]'::jsonb)
				FROM signoff s WHERE s.pack_id = p.id
			)
		);
	END
	$$;

-- ---------------------------------------------------------------------------
-- app_specialist_pack, from 280_future_yield.sql: its runs' fits' engines
-- through run_fit_engine_version. Nothing else changes.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_specialist_pack(p_project uuid, p_pack uuid) RETURNS jsonb
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		p evidence_pack;
	BEGIN
		IF NOT app_pack_specialist(p_project, p_pack) THEN
			RETURN NULL;
		END IF;
		SELECT * INTO p FROM evidence_pack WHERE id = p_pack AND project_id = p_project;
		RETURN jsonb_build_object(
			'id', p.id,
			'scenarioId', p.scenario_id,
			'title', p.manifest->'report'->'identity'->>'title',
			'version', p.version,
			'status', p.status,
			'manifestSha256', p.manifest_sha256,
			'baselineRunId', p.baseline_run_id,
			'scenarioRunId', p.scenario_run_id,
			'createdAt', p.created_at,
			'futureYield', coalesce(p.manifest->'report'->'futureYield'->>'status' = 'ok', false),
			'runs', (
				SELECT coalesce(jsonb_agg(jsonb_build_object(
					'id', r.id,
					'engineVersion', r.engine_version,
					'scenario', r.from_scenario,
					'fitEngineVersion', run_fit_engine_version(r.inputs, r.summary),
					'legacy', coalesce(r.inputs->'settings'->>'runoffModel', 'legacy') = 'legacy',
					'forecast', r."trigger" = 'forecast',
					'stamp', encode(r.stamp, 'hex'),
					'digest', encode(app_run_digest_body(r.id), 'hex')
				)), '[]'::jsonb)
				FROM model_run r WHERE r.project_id = p_project AND (r.id = p.baseline_run_id OR r.id = p.scenario_run_id)
			)
		);
	END
	$$;
