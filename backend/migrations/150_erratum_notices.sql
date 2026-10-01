-- 150_erratum_notices — the known-defect procedure's emails (issue #103,
-- Gate D; docs/legal/known-defect-procedure.md, docs/engine-errata.md,
-- docs/data-model.md § Engine errata notices, docs/security.md § Evidence packs
-- "Who is emailed about a known engine bug").
--
-- Expand-only: two new tables and five new functions; nothing existing is
-- changed.
--
-- An erratum is a confirmed engine bug that changes results
-- (docs/engine-errata.md). It ships as a row of that table, generated into
-- the engine (ENGINE_ERRATA). On the first worker tick after the deploy that
-- carries it, the worker sweeps the runs once (app_erratum_sweep) and queues
-- one email per erratum, project and owner whose project holds a run the
-- erratum may affect; the tick then sends them, each built as its recipient
-- under RLS, as pack notices are (133). The app flags the affected runs
-- itself, from the run's engine version (no table needed).
--
--  1. erratum_sweep: which errata the worker has swept, and the range it
--     swept them with. One row per erratum id. A sweep runs again only when
--     an erratum's range (keyed on, first affected, fixed in) changes, so an
--     unchanged list costs one primary-key lookup per erratum per tick. Not
--     personal and not project data (it repeats what docs/engine-errata.md
--     publishes): readable by a signed-in person (never an API key), written
--     only by app_erratum_sweep.
--
--  2. erratum_notice: one row per erratum, project and recipient, ever (the
--     primary key), so an erratum mails a person about a project at most
--     once, even when its range is widened and it is swept again. Its life
--     is pack_notice's (133): pending → sending (claimed, leased) → sent |
--     skipped | failed (never re-sent). run_count is how many of the
--     project's runs it may affect when swept. Personal (a row says a person
--     was mailed), so it goes with the account (cascade), is in the person's
--     data export (auth/export.ts erratumNotices) and is purged 30 days after
--     it is settled (app_purge_erratum_notices, called by the tick). RLS: a
--     person reads their own rows; water_app has SELECT only and there is
--     no write policy, so rows are written only by the SECURITY DEFINER
--     functions (no caller can choose a recipient).
--
--  3. Who: the project's owners (project_member owner, or admin of the
--     project's team: 094's mapping), with a confirmed address that SES has
--     not suppressed. Editors and viewers see the flag in the app; the
--     owners answer for the project's results.
--
--  4. Which runs: a `run` erratum by the run's engine_version, a `fit` one by
--     the engine of the automatic fit its parameters came from
--     (inputs.settings.fitRecord.engineVersion, runs/execute.ts storeRun),
--     in [first affected, fixed in), the range the engine's errataFor uses.
--     Versions compare numerically (x.y.z as an integer array); anything
--     else matches nothing, as errataFor refuses it.
--
-- Every function pins search_path; the SECURITY DEFINER ones are revoked
-- from PUBLIC and granted to water_app (028), and refuse any context but the
-- worker's own (no user, no API key: alert_worker_context, 051).

-- ---------------------------------------------------------------------------
-- 1–2. The tables
-- ---------------------------------------------------------------------------
CREATE TABLE erratum_sweep (
	erratum_id     text PRIMARY KEY CHECK (erratum_id ~ '^ER-[1-9][0-9]*$'),
	keyed_on       text NOT NULL CHECK (keyed_on IN ('run', 'fit')),
	first_affected text NOT NULL CHECK (first_affected ~ '^\d+\.\d+\.\d+$'),
	fixed_in       text CHECK (fixed_in IS NULL OR fixed_in ~ '^\d+\.\d+\.\d+$'),
	swept_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE erratum_sweep IS
	'Which engine errata the worker has swept for affected runs, and with which range (150_erratum_notices, issue #103). Written and read only by app_erratum_sweep.';

ALTER TABLE erratum_sweep ENABLE ROW LEVEL SECURITY;
-- Reading only, by a signed-in person: it holds what docs/engine-errata.md already publishes. Never an API key,
-- which sees only its own project's allowed series (039; ingest.security.db.test.ts). Written only by app_erratum_sweep.
CREATE POLICY erratum_sweep_read ON erratum_sweep FOR SELECT USING (app_current_user_id() IS NOT NULL);
GRANT SELECT ON erratum_sweep TO water_app;

CREATE TABLE erratum_notice (
	erratum_id   text NOT NULL CHECK (erratum_id ~ '^ER-[1-9][0-9]*$'),
	project_id   uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	user_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
	run_count    integer NOT NULL CHECK (run_count > 0),
	status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'skipped', 'failed')),
	attempts     integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
	created_at   timestamptz NOT NULL DEFAULT now(),
	claimed_at   timestamptz,
	locked_until timestamptz,
	sent_at      timestamptz,
	-- When it became sent, skipped or failed: the purge counts from here.
	settled_at   timestamptz,
	reason       text CHECK (reason IS NULL OR char_length(reason) <= 200),
	PRIMARY KEY (erratum_id, project_id, user_id)
);
CREATE INDEX erratum_notice_project_idx ON erratum_notice (project_id);
CREATE INDEX erratum_notice_user_idx ON erratum_notice (user_id);
CREATE INDEX erratum_notice_open_idx ON erratum_notice (status, created_at) WHERE status IN ('pending', 'sending');
CREATE INDEX erratum_notice_settled_idx ON erratum_notice (settled_at);

COMMENT ON TABLE erratum_notice IS
	'One "known engine bug" email per erratum, project and owner, ever (150_erratum_notices, issue #103). Own rows readable; written only by the SECURITY DEFINER sweep / claim / finish / purge functions. Purged 30 days after it is settled.';

ALTER TABLE erratum_notice ENABLE ROW LEVEL SECURITY;
-- Reading only: no INSERT, UPDATE or DELETE policy.
CREATE POLICY erratum_notice_own ON erratum_notice FOR SELECT USING (user_id = app_current_user_id());
GRANT SELECT ON erratum_notice TO water_app;

-- ---------------------------------------------------------------------------
-- 3–4. Version range, and the sweep
-- ---------------------------------------------------------------------------
-- An x.y.z engine version as an integer array, for numeric comparison; NULL
-- for anything else (a NULL comparison matches nothing).
CREATE FUNCTION engine_version_key(p_version text) RETURNS integer[]
	LANGUAGE sql IMMUTABLE SET search_path = public
	AS $$
		SELECT CASE WHEN p_version ~ '^\d{1,9}\.\d{1,9}\.\d{1,9}$' THEN string_to_array(p_version, '.')::integer[] END
	$$;

-- Sweep every erratum in p_errata (a JSON array of {id, keyedOn,
-- firstAffected, fixedIn}, the engine's ENGINE_ERRATA) not yet swept with
-- that range, and queue its notices. Returns how many notices it queued.
CREATE FUNCTION app_erratum_sweep(p_errata jsonb) RETURNS integer
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
					THEN r.inputs->'settings'->'fitRecord'->>'engineVersion' ELSE r.engine_version END) AS v) k
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
-- Claim, finish, purge (as 133's)
-- ---------------------------------------------------------------------------
-- Claim up to p_limit pending notices. A notice left 'sending' past its
-- lease (the worker died mid-send) is marked failed, never re-sent.
CREATE FUNCTION app_erratum_notice_claim(p_limit integer, p_lease interval)
	RETURNS TABLE (erratum_id text, project_id uuid, user_id uuid, run_count integer)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker sends erratum notices' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 OR p_lease IS NULL OR p_lease < interval '10 seconds' OR p_lease > interval '1 hour' THEN
			RAISE EXCEPTION 'claim 1–500 notices with a lease of 10 s to 1 h' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		UPDATE erratum_notice n SET status = 'failed', locked_until = NULL, settled_at = now(), reason = 'the worker stopped while sending'
		WHERE n.status = 'sending' AND n.locked_until < now();
		RETURN QUERY
			WITH due AS (
				SELECT n.erratum_id, n.project_id, n.user_id FROM erratum_notice n
				WHERE n.status = 'pending'
				ORDER BY n.created_at, n.erratum_id, n.project_id, n.user_id
				LIMIT p_limit
				FOR UPDATE SKIP LOCKED
			), claimed AS (
				UPDATE erratum_notice n SET status = 'sending', claimed_at = now(), locked_until = now() + p_lease, attempts = n.attempts + 1
				FROM due d WHERE n.erratum_id = d.erratum_id AND n.project_id = d.project_id AND n.user_id = d.user_id
				RETURNING n.erratum_id, n.project_id, n.user_id, n.run_count, n.created_at
			)
			SELECT c.erratum_id, c.project_id, c.user_id, c.run_count FROM claimed c
			ORDER BY c.created_at, c.erratum_id, c.project_id, c.user_id;
	END
	$$;

CREATE FUNCTION app_erratum_notice_finish(p_erratum text, p_project uuid, p_user uuid, p_status text, p_reason text DEFAULT NULL) RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker sends erratum notices' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_status IS NULL OR p_status NOT IN ('sent', 'skipped', 'failed', 'retry') THEN
			RAISE EXCEPTION 'unknown notice outcome' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		UPDATE erratum_notice n SET
			status = CASE WHEN p_status <> 'retry' THEN p_status WHEN n.attempts >= 3 THEN 'failed' ELSE 'pending' END,
			sent_at = CASE WHEN p_status = 'sent' THEN now() END,
			settled_at = CASE WHEN p_status <> 'retry' OR n.attempts >= 3 THEN now() END,
			locked_until = NULL,
			reason = left(p_reason, 200)
		WHERE n.erratum_id = p_erratum AND n.project_id = p_project AND n.user_id = p_user AND n.status = 'sending';
		RETURN FOUND;
	END
	$$;

CREATE FUNCTION app_purge_erratum_notices(p_age interval) RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		n integer;
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker purges erratum notices' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_age IS NULL OR p_age < interval '30 days' THEN
			RAISE EXCEPTION 'purge only notices at least 30 days old' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		DELETE FROM erratum_notice WHERE settled_at < now() - p_age AND status NOT IN ('pending', 'sending');
		GET DIAGNOSTICS n = ROW_COUNT;
		RETURN n;
	END
	$$;

REVOKE ALL ON FUNCTION app_erratum_sweep(jsonb), app_erratum_notice_claim(integer, interval),
	app_erratum_notice_finish(text, uuid, uuid, text, text), app_purge_erratum_notices(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_erratum_sweep(jsonb), app_erratum_notice_claim(integer, interval),
	app_erratum_notice_finish(text, uuid, uuid, text, text), app_purge_erratum_notices(interval) TO water_app;
