-- 059_local_day — the project's own calendar day for the dates a person reads
-- (issue #45's follow-up; docs/followups.md, docs/data-model.md § Alerts and
-- § Projects). 058 gave the project a time zone for its download names; this
-- puts the alert digest's clock on it too.
--
--   app_time_zone(zone)   the zone if Postgres knows it, else the default
--                         (Africa/Johannesburg). The API accepts any zone
--                         the Node runtime's Intl knows (058); the two
--                         tz databases can disagree on a rare name, and
--                         `AT TIME ZONE` raises on an unknown one, so every
--                         SQL use goes through here and one odd name can't
--                         break a query over many projects.
--
--   alert_digest_start(at, zone)
--                         the latest 06:00 in `zone` at or before `at`: the
--                         start of that zone's digest day.
--
--   app_alert_claim / app_alert_claim_digest
--                         were given the digest day's start by the worker,
--                         at 06:00 SAST for every project (051). They now
--                         take the worker's clock (p_now) and work out each
--                         delivery's day from its own project's zone: a
--                         digest line goes out after 06:00 where the
--                         catchment is, and the daily cap counts a person's
--                         immediate mails since the last 06:00 in the zone
--                         of the project whose alert is being claimed. Every
--                         project so far is South African (058's default),
--                         so nothing changes for them. Same checks, same
--                         locks, same grants as 051; only the boundary moved.
--
-- Replaced (not expanded): app_alert_claim's and app_alert_claim_digest's
-- second parameter changes meaning, so each is dropped and recreated with
-- the worker (backend/src/alerts/send.ts) in the same change.

CREATE FUNCTION app_time_zone(p_zone text) RETURNS text
	LANGUAGE plpgsql STABLE SET search_path = public
	AS $$
	BEGIN
		IF p_zone IS NULL THEN
			RETURN 'Africa/Johannesburg';
		END IF;
		PERFORM now() AT TIME ZONE p_zone;
		RETURN p_zone;
	EXCEPTION WHEN invalid_parameter_value THEN
		RETURN 'Africa/Johannesburg';
	END
	$$;
REVOKE ALL ON FUNCTION app_time_zone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_time_zone(text) TO water_app;

CREATE FUNCTION alert_digest_start(p_at timestamptz, p_zone text) RETURNS timestamptz
	LANGUAGE sql STABLE SET search_path = public
	AS $$
		SELECT (date_trunc('day', (p_at AT TIME ZONE z) - interval '6 hours') + interval '6 hours') AT TIME ZONE z
		FROM (SELECT app_time_zone(p_zone) AS z) t
	$$;
REVOKE ALL ON FUNCTION alert_digest_start(timestamptz, text) FROM PUBLIC, water_app;

DROP FUNCTION app_alert_claim(integer, timestamptz, integer, interval);
DROP FUNCTION app_alert_claim_digest(timestamptz, integer, integer, interval);

-- Claim up to p_limit pending deliveries to send now, applying the daily cap:
-- a person who has had p_cap immediate alert mails since the last 06:00 in
-- the delivery's project's zone (at p_now) gets the rest in that project's
-- next digest instead. One person at a time under an advisory lock, so two
-- workers can't both send the fifth mail. A delivery left 'sending' past its
-- lease (the worker died mid-send) is marked failed, never re-sent.
CREATE FUNCTION app_alert_claim(p_limit integer, p_now timestamptz, p_cap integer, p_lease interval)
	RETURNS TABLE (event_id uuid, user_id uuid, project_id uuid, kind text, node_id uuid)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	DECLARE
		d record;
		sent integer;
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker sends alerts' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 OR p_cap IS NULL OR p_cap < 0 OR p_now IS NULL
			OR p_lease IS NULL OR p_lease < interval '10 seconds' OR p_lease > interval '1 hour' THEN
			RAISE EXCEPTION 'claim 1–500 deliveries, a cap ≥ 0 and a lease of 10 s to 1 h' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		UPDATE alert_delivery a SET status = 'failed', locked_until = NULL, reason = 'the worker stopped while sending'
		WHERE a.status = 'sending' AND a.locked_until < now();
		FOR d IN
			SELECT a.event_id, a.user_id, alert_digest_start(p_now, p.time_zone) AS since
			FROM alert_delivery a JOIN project p ON p.id = a.project_id
			WHERE a.status = 'pending'
			ORDER BY a.created_at, a.event_id
			LIMIT p_limit
			FOR UPDATE OF a SKIP LOCKED
		LOOP
			PERFORM pg_advisory_xact_lock(hashtextextended('alert_cap:' || d.user_id::text, 0));
			SELECT count(*) INTO sent FROM alert_delivery a
			WHERE a.user_id = d.user_id AND a.via = 'immediate' AND a.status IN ('sending', 'sent') AND a.claimed_at >= d.since;
			IF sent >= p_cap THEN
				UPDATE alert_delivery a SET status = 'digest', reason = 'over the daily cap'
				WHERE a.event_id = d.event_id AND a.user_id = d.user_id;
			ELSE
				UPDATE alert_delivery a SET status = 'sending', via = 'immediate', claimed_at = now(),
					locked_until = now() + p_lease, attempts = a.attempts + 1
				WHERE a.event_id = d.event_id AND a.user_id = d.user_id;
				RETURN QUERY
					SELECT e.id, d.user_id, e.project_id, e.kind, e.node_id FROM alert_event e WHERE e.id = d.event_id;
			END IF;
		END LOOP;
	END
	$$;

-- Claim the digest lines that are due at p_now (queued before the latest
-- 06:00 in their project's zone) for up to p_people people at once, marked
-- sending: each person's newest p_lines at most. Their older due lines
-- beyond that are marked skipped ("over the digest limit"), so a flapping
-- rule or a day of many crossings can neither build an unbounded email nor
-- pile up for the next digest. The email itself shows fewer still
-- (alerts/send.ts DIGEST_MAX_LINES, then "and N more").
CREATE FUNCTION app_alert_claim_digest(p_now timestamptz, p_people integer, p_lines integer, p_lease interval)
	RETURNS TABLE (event_id uuid, user_id uuid, project_id uuid, kind text, node_id uuid)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	DECLARE
		v_people uuid[];
		v_projects uuid[];
		v_since timestamptz[];
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker sends alerts' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_now IS NULL OR p_people IS NULL OR p_people < 1 OR p_people > 500 OR p_lines IS NULL OR p_lines < 1 OR p_lines > 1000
			OR p_lease IS NULL OR p_lease < interval '10 seconds' OR p_lease > interval '1 hour' THEN
			RAISE EXCEPTION 'claim digests for 1–500 people, 1–1000 lines each, with a lease of 10 s to 1 h' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		-- Each waiting project's digest day, worked out once.
		SELECT array_agg(p.id), array_agg(alert_digest_start(p_now, p.time_zone)) INTO v_projects, v_since
		FROM project p WHERE p.id IN (SELECT DISTINCT x.project_id FROM alert_delivery x WHERE x.status = 'digest');
		IF v_projects IS NULL THEN
			RETURN;
		END IF;
		SELECT array_agg(x.user_id) INTO v_people FROM (
			SELECT DISTINCT a.user_id FROM alert_delivery a JOIN unnest(v_projects, v_since) b(id, since) ON b.id = a.project_id
			WHERE a.status = 'digest' AND a.created_at < b.since
			LIMIT p_people
		) x;
		IF v_people IS NULL THEN
			RETURN;
		END IF;
		-- Due lines past each person's newest p_lines: handled, never sent.
		UPDATE alert_delivery a SET status = 'skipped', via = 'digest', locked_until = NULL, reason = 'over the digest limit'
		FROM (
			SELECT d.event_id, d.user_id, row_number() OVER (PARTITION BY d.user_id ORDER BY d.created_at DESC, d.event_id) AS rn
			FROM alert_delivery d JOIN unnest(v_projects, v_since) b(id, since) ON b.id = d.project_id
			WHERE d.status = 'digest' AND d.created_at < b.since AND d.user_id = ANY (v_people)
		) r
		WHERE a.event_id = r.event_id AND a.user_id = r.user_id AND r.rn > p_lines AND a.status = 'digest';
		RETURN QUERY
		WITH due AS (
			SELECT a.event_id, a.user_id FROM alert_delivery a JOIN unnest(v_projects, v_since) b(id, since) ON b.id = a.project_id
			WHERE a.status = 'digest' AND a.created_at < b.since AND a.user_id = ANY (v_people)
			FOR UPDATE OF a SKIP LOCKED
		), claimed AS (
			UPDATE alert_delivery a SET status = 'sending', via = 'digest', claimed_at = now(),
				locked_until = now() + p_lease, attempts = a.attempts + 1
			FROM due WHERE a.event_id = due.event_id AND a.user_id = due.user_id
			RETURNING a.event_id, a.user_id, a.created_at
		)
		SELECT c.event_id, c.user_id, e.project_id, e.kind, e.node_id
		FROM claimed c JOIN alert_event e ON e.id = c.event_id
		ORDER BY c.user_id, c.created_at DESC, c.event_id;
	END
	$$;

REVOKE ALL ON FUNCTION app_alert_claim(integer, timestamptz, integer, interval), app_alert_claim_digest(timestamptz, integer, integer, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_alert_claim(integer, timestamptz, integer, interval), app_alert_claim_digest(timestamptz, integer, integer, interval) TO water_app;
