-- 313_fit_errata_every_location — a `fit` erratum flags a run when it affects
-- the fit at any calibration location the run applied, not just the headline
-- location's (issue #670, decided there; #659 slice B; docs/engine-errata.md,
-- docs/legal/known-defect-procedure.md).
--
-- 289 keyed a `fit` erratum on run_fit_engine_version, the headline
-- location's fit alone. A run calibrated at several gauges takes each unit's
-- GR4J parameters from its own location's fit, so a bug in the fit at a
-- non-headline location changed that run's results without flagging it.
--
-- 1. run_fit_engine_versions(inputs, summary) text[]: the engines of every
--    fit the run's parameters came from, distinct, sorted (byte order, as the
--    engine's sort), no nulls. Each group the run applied
--    (summary.unitRain.zones, engine 1.106.0): a gauge's location (a string
--    nodeId) its row's fit record (the first settings.calibrationZones row
--    with that node), plus the top-level settings.fitRecord when it had no
--    parameters of its own (fitted false: its units took the catchment's);
--    the outlet's location and the units on settings.gr4j (nodeId null) the
--    top-level fit record. The top level too when no group is the headline
--    (a run with no gauge location, or from before engine 1.110.0), so
--    run_fit_engine_version's value is always among them. Only string
--    versions. The engine's runFitEngineVersions
--    (packages/engine/src/liability/errata.ts) is the same rule, and
--    migration-313.db.test.ts asserts they agree.
-- 2. app_erratum_sweep, app_verify_pack and app_specialist_pack, from their
--    latest definitions (289): the sweep keys a `fit` erratum on any element;
--    the verify and specialist objects carry `fitEngineVersions` (a JSON
--    array) in place of `fitEngineVersion`. Nothing else changes, and
--    CREATE OR REPLACE keeps their grants. The API reads the list the same
--    way (runs/read.ts RUN_META, signoffs, evidence packs), so a run's
--    "May be affected" flag, its validation and sign-off statements and a
--    pack's errata found since issue all agree with the email.
--
-- run_fit_engine_version (289) stays: the run list's `fitEngineVersion`
-- (the headline fit) still reads it. No table, policy or grant change, so no
-- RLS change. The new function is IMMUTABLE, reads only its arguments, pins
-- search_path, and water_app gets EXECUTE from the owner's default
-- privileges (028).
--
-- The sweep looks at runs only for a range it hasn't swept (erratum_sweep),
-- so an erratum swept before this migration is not swept again. None needs
-- it: the only `fit` erratum (ER-6) was fixed in engine 1.22.0, and a fit at
-- a location other than the headline exists only from engine 1.106.0
-- (issue #555), so no run's other fit falls in its range. Re-sweeping would
-- also risk a second email once erratum_notice's 30-day purge has run.

-- ---------------------------------------------------------------------------
-- 1. The engines of every fit a run's parameters came from
-- ---------------------------------------------------------------------------
CREATE FUNCTION run_fit_engine_versions(p_inputs jsonb, p_summary jsonb) RETURNS text[]
	LANGUAGE sql IMMUTABLE SET search_path = public
	AS $$
		WITH s AS (
			SELECT
				CASE WHEN jsonb_typeof(p_inputs -> 'settings' -> 'fitRecord' -> 'engineVersion') = 'string'
					THEN p_inputs -> 'settings' -> 'fitRecord' ->> 'engineVersion' END AS top,
				CASE WHEN jsonb_typeof(p_inputs -> 'settings' -> 'calibrationZones') = 'array'
					THEN p_inputs -> 'settings' -> 'calibrationZones' ELSE '[]'::jsonb END AS rows
		), zones AS (
			SELECT zz
			FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_summary -> 'unitRain' -> 'zones') = 'array'
				THEN p_summary -> 'unitRain' -> 'zones' ELSE '[]'::jsonb END) zz
			WHERE jsonb_typeof(zz) = 'object'
		), v AS (
			-- A gauge's location: its row's fit (the first row with its node).
			SELECT (
				SELECT CASE WHEN jsonb_typeof(z -> 'fitRecord' -> 'engineVersion') = 'string' THEN z -> 'fitRecord' ->> 'engineVersion' END
				FROM jsonb_array_elements(s.rows) WITH ORDINALITY AS a(z, ord)
				WHERE jsonb_typeof(z -> 'nodeId') = 'string' AND z ->> 'nodeId' = zones.zz ->> 'nodeId'
				ORDER BY ord
				LIMIT 1
			) AS v
			FROM zones, s
			WHERE jsonb_typeof(zones.zz -> 'nodeId') = 'string'
			UNION ALL
			-- The outlet's location, settings.gr4j's units, and a gauge's location that took the catchment's parameters.
			SELECT s.top FROM zones, s
			WHERE jsonb_typeof(zones.zz -> 'nodeId') IS DISTINCT FROM 'string' OR zones.zz -> 'fitted' = 'false'::jsonb
			UNION ALL
			-- No headline group (no gauge location, or a run from before engine 1.110.0): the top level is the headline's.
			SELECT s.top FROM s
			WHERE NOT EXISTS (SELECT 1 FROM zones WHERE zones.zz -> 'headline' = 'true'::jsonb)
		)
		SELECT coalesce(array_agg(DISTINCT v.v COLLATE "C" ORDER BY v.v COLLATE "C"), '{}'::text[])
		FROM v
		WHERE v.v IS NOT NULL
	$$;
COMMENT ON FUNCTION run_fit_engine_versions(jsonb, jsonb) IS
	'The engine versions of every automatic fit a run''s parameters came from (313, issue #670): each applied calibration location''s (summary.unitRain.zones) fit record, distinct and sorted; empty for entered parameters. What a `fit` erratum keys on. The engine''s runFitEngineVersions is the same rule.';

-- ---------------------------------------------------------------------------
-- 2. app_erratum_sweep, from 289_calibration_locations.sql: a `fit` erratum
-- keys on any of run_fit_engine_versions. Nothing else changes.
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
				-- 313: a `fit` erratum reaches a run when any of its fits is in range (issue #670), not just the headline's.
				WHERE EXISTS (
					SELECT 1
					FROM unnest(CASE WHEN e."keyedOn" = 'fit'
						THEN run_fit_engine_versions(r.inputs, r.summary) ELSE ARRAY[r.engine_version] END) AS f(v)
					CROSS JOIN LATERAL (SELECT engine_version_key(f.v) AS k) kk
					WHERE kk.k >= lo AND (hi IS NULL OR kk.k < hi)
				)
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
-- app_verify_pack, from 289_calibration_locations.sql: its runs carry
-- fitEngineVersions (run_fit_engine_versions). Nothing else changes.
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
					)
				) ORDER BY s.signed_at, s.id), '[]'::jsonb)
				FROM signoff s WHERE s.pack_id = p.id
			)
		);
	END
	$$;

-- ---------------------------------------------------------------------------
-- app_specialist_pack, from 289_calibration_locations.sql: its runs carry
-- fitEngineVersions (run_fit_engine_versions). Nothing else changes.
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
					'fitEngineVersions', to_jsonb(run_fit_engine_versions(r.inputs, r.summary)),
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
