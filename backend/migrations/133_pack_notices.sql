-- 133_pack_notices — "pack issued" and "pack withdrawn" emails (issue #71,
-- docs/followups.md § Evidence report; docs/evidence-pack.md § Notices,
-- docs/data-model.md § Evidence packs, docs/security.md § Evidence packs).
--
-- Expand-only: one new table and five new functions; nothing existing is
-- changed.
--
-- When an editor issues a pack, or withdraws one that was issued, the route
-- queues one notice per recipient in the same transaction
-- (app_pack_notice_queue), and the worker's tick sends them after the jobs
-- (backend/src/evidence/notices.ts), each built as its recipient under RLS,
-- as alert mails are (051). Mailpit locally, SES in production.
--
--  1. pack_notice: one row per pack, recipient and event, ever (the primary
--     key), so an event can mail a person at most once. Its life is
--     alert_delivery's (051): pending → sending (claimed, leased) → sent |
--     skipped (no longer eligible, or no confirmed or a suppressed address,
--     when it was built) | failed (the transport kept failing, or the worker
--     stopped mid-send: never re-sent, so a crash can't double-mail).
--     Personal (a row says a person was mailed about a pack), so it goes with
--     the account (cascade), is in the person's data export (auth/export.ts
--     packNotices) and is purged 30 days after it is settled
--     (app_purge_pack_notices, called by the tick). RLS: a person reads their
--     own rows; there is no INSERT, UPDATE or DELETE policy, so water_app
--     writes only through the SECURITY DEFINER functions below (the grant
--     mirrors alert_delivery's). pack_id is covered by the primary key; user_id,
--     project_id, the open rows and settled_at (the purge's) have their own
--     indexes. project_id is
--     copied from the pack by app_pack_notice_queue, never the caller's
--     (cross-project-refs.security.db.test.ts: not writable).
--
--  2. Who (pack_notice_audience): everyone whose project role, direct or
--     through the project's team, is editor or owner (they issue and
--     withdraw packs), and the application's scenario owner when they still
--     hold a role on the project above farmer (an applicant is a
--     contributor). Viewers, farmers and non-members never. The person who
--     issued or withdrew it is left out: they just did it. A plain function,
--     revoked from water_app: only the SECURITY DEFINER queue reads it.
--
--  3. Which events: `issued` (a new version's notice says which version it
--     replaces, so a supersede has no email of its own: it happens in the
--     same step) and `withdrawn`, only for a pack that was issued. A draft
--     withdrawn was never public (verify answers 404 for it), so no one is
--     told. The email carries the pack's version, its subject's name, its
--     short code, the public verify link and, for a withdrawal, the reason
--     (public on verify too); never a figure.
--
--  4. app_pack_notice_queue(pack, event): as an editor of the pack's project
--     only, and only for a pack in that state (issued / withdrawn after
--     issue). Idempotent (ON CONFLICT DO NOTHING). NOTIFYs job_queued so the
--     local worker ticks at commit, as a job insert does (016).
--     app_pack_notice_claim / _finish / app_purge_pack_notices: the worker's
--     own context only (no user, no API key; alert_worker_context, 051).
--
-- app_pack_notice_queue checks the caller is an editor and the pack is in
-- that state, not that this transaction made the change: the issue and
-- withdraw routes are its only callers, and the primary key bounds any other
-- call to one email per person and event.
--
-- Every function pins search_path; the SECURITY DEFINER ones are revoked
-- from PUBLIC and granted to water_app (028).

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------
CREATE TABLE pack_notice (
	pack_id      uuid NOT NULL REFERENCES evidence_pack(id) ON DELETE CASCADE,
	user_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
	event        text NOT NULL CHECK (event IN ('issued', 'withdrawn')),
	project_id   uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'skipped', 'failed')),
	attempts     integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
	created_at   timestamptz NOT NULL DEFAULT now(),
	claimed_at   timestamptz,
	locked_until timestamptz,
	sent_at      timestamptz,
	-- When it became sent, skipped or failed: the purge counts from here.
	settled_at   timestamptz,
	reason       text CHECK (reason IS NULL OR char_length(reason) <= 200),
	PRIMARY KEY (pack_id, user_id, event)
);
CREATE INDEX pack_notice_user_idx ON pack_notice (user_id);
CREATE INDEX pack_notice_project_idx ON pack_notice (project_id);
CREATE INDEX pack_notice_open_idx ON pack_notice (status, created_at) WHERE status IN ('pending', 'sending');
CREATE INDEX pack_notice_settled_idx ON pack_notice (settled_at);

COMMENT ON TABLE pack_notice IS
	'One "pack issued" / "pack withdrawn" email per pack, recipient and event, ever (133_pack_notices, issue #71). Own rows readable; written only by the SECURITY DEFINER queue / claim / finish / purge functions. Purged 30 days after it is settled.';

ALTER TABLE pack_notice ENABLE ROW LEVEL SECURITY;
-- Reading only: no INSERT, UPDATE or DELETE policy.
CREATE POLICY pack_notice_own ON pack_notice FOR SELECT USING (user_id = app_current_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON pack_notice TO water_app;

-- ---------------------------------------------------------------------------
-- 2. Who
-- ---------------------------------------------------------------------------
CREATE FUNCTION pack_notice_audience(p_project uuid, p_scenario uuid)
	RETURNS TABLE (user_id uuid)
	LANGUAGE sql STABLE SET search_path = public
	AS $$
		WITH roles AS (
			SELECT x.user_id, max(x.r) AS role FROM (
				SELECT m.user_id, m.role AS r FROM project_member m WHERE m.project_id = p_project
				UNION ALL
				SELECT tm.user_id, CASE tm.role::text
						WHEN 'admin' THEN 'owner'::project_role
						WHEN 'member' THEN 'editor'::project_role
						WHEN 'viewer' THEN 'viewer'::project_role
					END
				FROM project p JOIN team_member tm ON tm.team_id = p.team_id
				WHERE p.id = p_project
			) x WHERE x.r IS NOT NULL
			GROUP BY x.user_id
		)
		SELECT r.user_id FROM roles r WHERE r.role >= 'editor'
		UNION
		SELECT r.user_id FROM roles r JOIN scenario s ON s.owner_user_id = r.user_id
		WHERE p_scenario IS NOT NULL AND s.id = p_scenario AND s.project_id = p_project AND r.role >= 'contributor'
	$$;
REVOKE ALL ON FUNCTION pack_notice_audience(uuid, uuid) FROM PUBLIC, water_app;

-- ---------------------------------------------------------------------------
-- 3–4. Queue, claim, finish, purge
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_pack_notice_queue(p_pack uuid, p_event text) RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		pk record;
		n integer;
	BEGIN
		IF p_event IS NULL OR p_event NOT IN ('issued', 'withdrawn') THEN
			RAISE EXCEPTION 'unknown pack notice event' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		SELECT p.id, p.project_id, p.scenario_id, p.status, p.issued_at INTO pk FROM evidence_pack p WHERE p.id = p_pack;
		IF NOT FOUND OR app_current_user_id() IS NULL OR NOT app_has_role(pk.project_id, 'editor') THEN
			RAISE EXCEPTION 'only an editor of the pack''s project queues its notices' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF (p_event = 'issued' AND pk.status <> 'issued') OR (p_event = 'withdrawn' AND pk.status <> 'withdrawn') THEN
			RAISE EXCEPTION 'the pack is %, not %', pk.status, p_event USING ERRCODE = 'check_violation';
		END IF;
		-- A draft withdrawn was never public: nobody is told.
		IF p_event = 'withdrawn' AND pk.issued_at IS NULL THEN
			RETURN 0;
		END IF;
		INSERT INTO pack_notice (pack_id, user_id, event, project_id)
			SELECT pk.id, a.user_id, p_event, pk.project_id
			FROM pack_notice_audience(pk.project_id, pk.scenario_id) a
			JOIN app_user u ON u.id = a.user_id
			WHERE a.user_id <> app_current_user_id() AND u.email_verified_at IS NOT NULL AND u.mail_suppressed_at IS NULL
			ON CONFLICT DO NOTHING;
		GET DIAGNOSTICS n = ROW_COUNT;
		-- Wakes the local worker at commit (LISTEN job_queued, jobs/worker.ts), as a job insert does.
		IF n > 0 THEN
			PERFORM pg_notify('job_queued', '');
		END IF;
		RETURN n;
	END
	$$;

-- Claim up to p_limit pending notices, with the public facts each email
-- needs (the recipient's own transaction reads the names under RLS). A
-- notice left 'sending' past its lease (the worker died mid-send) is marked
-- failed, never re-sent.
CREATE FUNCTION app_pack_notice_claim(p_limit integer, p_lease interval)
	RETURNS TABLE (pack_id uuid, user_id uuid, event text, project_id uuid, scenario_id uuid, version integer,
		manifest_sha256 text, supersedes_version integer, status_reason text)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker sends pack notices' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 OR p_lease IS NULL OR p_lease < interval '10 seconds' OR p_lease > interval '1 hour' THEN
			RAISE EXCEPTION 'claim 1–500 notices with a lease of 10 s to 1 h' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		UPDATE pack_notice n SET status = 'failed', locked_until = NULL, settled_at = now(), reason = 'the worker stopped while sending'
		WHERE n.status = 'sending' AND n.locked_until < now();
		RETURN QUERY
			WITH due AS (
				SELECT n.pack_id, n.user_id, n.event FROM pack_notice n
				WHERE n.status = 'pending'
				ORDER BY n.created_at, n.pack_id, n.user_id, n.event
				LIMIT p_limit
				FOR UPDATE SKIP LOCKED
			), claimed AS (
				UPDATE pack_notice n SET status = 'sending', claimed_at = now(), locked_until = now() + p_lease, attempts = n.attempts + 1
				FROM due d WHERE n.pack_id = d.pack_id AND n.user_id = d.user_id AND n.event = d.event
				RETURNING n.pack_id, n.user_id, n.event, n.project_id, n.created_at
			)
			SELECT c.pack_id, c.user_id, c.event, c.project_id, p.scenario_id, p.version, p.manifest_sha256,
				pred.version, CASE WHEN c.event = 'withdrawn' THEN p.status_reason END
			FROM claimed c JOIN evidence_pack p ON p.id = c.pack_id
			LEFT JOIN evidence_pack pred ON pred.id = p.supersedes_pack_id
			ORDER BY c.created_at, c.pack_id, c.user_id, c.event;
	END
	$$;

CREATE FUNCTION app_pack_notice_finish(p_pack uuid, p_user uuid, p_event text, p_status text, p_reason text DEFAULT NULL) RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker sends pack notices' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_status IS NULL OR p_status NOT IN ('sent', 'skipped', 'failed', 'retry') THEN
			RAISE EXCEPTION 'unknown notice outcome' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		UPDATE pack_notice n SET
			status = CASE WHEN p_status <> 'retry' THEN p_status WHEN n.attempts >= 3 THEN 'failed' ELSE 'pending' END,
			sent_at = CASE WHEN p_status = 'sent' THEN now() END,
			settled_at = CASE WHEN p_status <> 'retry' OR n.attempts >= 3 THEN now() END,
			locked_until = NULL,
			reason = left(p_reason, 200)
		WHERE n.pack_id = p_pack AND n.user_id = p_user AND n.event = p_event AND n.status = 'sending';
		RETURN FOUND;
	END
	$$;

CREATE FUNCTION app_purge_pack_notices(p_age interval) RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		n integer;
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker purges pack notices' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_age IS NULL OR p_age < interval '30 days' THEN
			RAISE EXCEPTION 'purge only notices at least 30 days old' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		DELETE FROM pack_notice WHERE settled_at < now() - p_age AND status NOT IN ('pending', 'sending');
		GET DIAGNOSTICS n = ROW_COUNT;
		RETURN n;
	END
	$$;

REVOKE ALL ON FUNCTION app_pack_notice_queue(uuid, text), app_pack_notice_claim(integer, interval),
	app_pack_notice_finish(uuid, uuid, text, text, text), app_purge_pack_notices(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_pack_notice_queue(uuid, text), app_pack_notice_claim(integer, interval),
	app_pack_notice_finish(uuid, uuid, text, text, text), app_purge_pack_notices(interval) TO water_app;
