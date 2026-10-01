-- 151_alert_feedback — "Was this useful?" on alert emails (issue #74;
-- docs/data-model.md § Alerts, docs/security.md § Alerts, docs/api.md §
-- Alerts).
--
-- Expand-only: one new table and three new functions; nothing existing is
-- changed.
--
-- Every alert email (and every digest) carries two links, "Yes" and "No",
-- to a small public page (/alerts/feedback) where the reader can confirm the
-- answer and add a short comment. Nothing is recorded by opening the email
-- or following the link: the page asks first, and only pressing Send stores
-- the answer. No open or click tracking and no tracking pixel (Privacy §3).
--
--  1. alert_feedback: one row per alert email a person got, made when the
--     worker builds the mail (app_alert_answer_slot, as the recipient), so
--     the link has a token to look up. The row holds what alert_delivery
--     already does (who got which alert) until the person answers; then
--     `useful` and an optional `comment` (≤ 500 characters), and when.
--       * The token is HMAC-SHA256(ALERTS_TOKEN_SECRET,
--         "wm-alert-feedback/v1/" + nonce) (alerts/tokens.ts), single-purpose:
--         its own label, so an unsubscribe token can't answer feedback or the
--         reverse; only its SHA-256 is stored, and only the worker holds the
--         secret (the API looks a token up by its hash, as for unsubscribe).
--       * One row per person and event (UNIQUE (user_id, event_id)): a
--         retried send reuses the row's nonce, so the link stays the same. A
--         digest's row hangs off its first alert, with kind 'digest'.
--       * Retention: an unanswered row goes 30 days after the mail (the
--         link stops working then); an answer is kept 365 days after it was
--         given (app_purge_alert_answers, called by the tick). It goes with
--         the account (cascade) and is in the person's data export.
--       * event_id is SET NULL when the alert is purged (180 days after it
--         cleared), so an answer outlives its event for the rest of its year;
--         kind keeps what it was about.
--  2. RLS: a person reads their own rows; the project's editors and owners
--     read the project's rows (the API shows them counts and comments, never
--     who gave them). No INSERT, UPDATE or DELETE policy: water_app writes
--     only through the SECURITY DEFINER functions below, so no caller picks
--     a project, a person or an answer for someone else.
--  3. app_alert_answer_slot(event, digest, nonce, hash): as the
--     recipient, only for an alert delivery of theirs (the row the worker is
--     sending); returns the stored nonce (the existing one on a retry).
--     app_alert_answer(hash, useful, comment): no session, the token is the
--     credential; refuses (returns nothing) an unknown or expired link, or a
--     person who can no longer open the project. Answering again overwrites.
--     app_purge_alert_answers(): the worker's own context only.
--
-- Every function pins search_path; the SECURITY DEFINER ones are revoked
-- from PUBLIC and granted to water_app (028).

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------
CREATE TABLE alert_feedback (
	id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id  uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
	-- The alert the mail was about (a digest: its first line); NULL once the alert is purged.
	event_id    uuid REFERENCES alert_event(id) ON DELETE SET NULL,
	kind        text NOT NULL CHECK (kind IN ('dam_below', 'ewr_forecast_fail', 'data_stale', 'restriction_published', 'job_dead', 'feed_failing', 'farms_short', 'digest')),
	nonce       bytea NOT NULL CHECK (octet_length(nonce) = 32),
	token_hash  bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
	sent_at     timestamptz NOT NULL DEFAULT now(),
	useful      boolean,
	comment     text CHECK (comment IS NULL OR (char_length(comment) BETWEEN 1 AND 500)),
	answered_at timestamptz,
	CHECK ((useful IS NULL) = (answered_at IS NULL)),
	CHECK (comment IS NULL OR useful IS NOT NULL),
	UNIQUE (user_id, event_id)
);
-- user_id is covered by the unique (user_id, event_id).
CREATE INDEX alert_feedback_project_idx ON alert_feedback (project_id, answered_at);
CREATE INDEX alert_feedback_event_idx ON alert_feedback (event_id);
CREATE INDEX alert_feedback_sent_idx ON alert_feedback (sent_at) WHERE answered_at IS NULL;

COMMENT ON TABLE alert_feedback IS
	'"Was this useful?" on an alert email (151_alert_feedback, issue #74): one row per mail, answered or not. Own rows and editors read; written only by the SECURITY DEFINER slot / answer / purge functions. Unanswered: 30 days; answered: 365 days.';
COMMENT ON COLUMN alert_feedback.token_hash IS
	'SHA-256 of the feedback token HMAC(ALERTS_TOKEN_SECRET, "wm-alert-feedback/v1/" + nonce). Looked up by POST /alerts/feedback through app_alert_answer.';

ALTER TABLE alert_feedback ENABLE ROW LEVEL SECURITY;
-- Reading only: no INSERT, UPDATE or DELETE policy.
CREATE POLICY alert_feedback_select ON alert_feedback FOR SELECT
	USING (user_id = app_current_user_id() OR app_has_role(project_id, 'editor'));
GRANT SELECT ON alert_feedback TO water_app;

-- ---------------------------------------------------------------------------
-- 2. The worker's slot (as the recipient)
-- ---------------------------------------------------------------------------
-- The feedback row for the mail about p_event the caller is being sent (a
-- digest when p_digest), made with p_nonce / p_hash the first time; returns
-- the row's nonce, so a retried mail carries the same link. Only for an
-- alert delivery of the caller's that is being sent: nobody else's, and no
-- event they weren't mailed.
CREATE FUNCTION app_alert_answer_slot(p_event uuid, p_digest boolean, p_nonce bytea, p_hash bytea) RETURNS bytea
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_user uuid := app_current_user_id();
		v_project uuid;
		v_kind text;
		v_nonce bytea;
	BEGIN
		IF v_user IS NULL THEN
			RAISE EXCEPTION 'feedback links are made as their recipient' USING ERRCODE = 'insufficient_privilege';
		END IF;
		SELECT d.project_id, e.kind INTO v_project, v_kind
		FROM alert_delivery d JOIN alert_event e ON e.id = d.event_id
		WHERE d.event_id = p_event AND d.user_id = v_user AND d.status = 'sending';
		IF v_project IS NULL THEN
			RAISE EXCEPTION 'no alert of yours is being sent' USING ERRCODE = 'insufficient_privilege';
		END IF;
		INSERT INTO alert_feedback (project_id, user_id, event_id, kind, nonce, token_hash)
		VALUES (v_project, v_user, p_event, CASE WHEN p_digest THEN 'digest' ELSE v_kind END, p_nonce, p_hash)
		ON CONFLICT (user_id, event_id) DO NOTHING;
		SELECT f.nonce INTO v_nonce FROM alert_feedback f WHERE f.user_id = v_user AND f.event_id = p_event;
		RETURN v_nonce;
	END
	$$;

-- ---------------------------------------------------------------------------
-- 3. The answer (no session: the token is the credential)
-- ---------------------------------------------------------------------------
-- Record the answer on the feedback row whose token hashes to p_hash, and say
-- what it was about (for the page). Nothing for an unknown hash, a link more
-- than 30 days old (the row may be purged any time after), or a person who
-- can no longer open the project. A second answer replaces the first.
CREATE FUNCTION app_alert_answer(p_hash bytea, p_useful boolean, p_comment text)
	RETURNS TABLE (kind text, project_name text)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	DECLARE
		f alert_feedback;
		v_role project_role;
		v_comment text := nullif(btrim(p_comment), '');
	BEGIN
		IF p_hash IS NULL OR p_useful IS NULL THEN
			RETURN;
		END IF;
		SELECT * INTO f FROM alert_feedback a WHERE a.token_hash = p_hash;
		IF f.id IS NULL OR f.sent_at < now() - interval '30 days' THEN
			RETURN;
		END IF;
		v_role := alert_user_role(f.project_id, f.user_id);
		IF v_role IS NULL OR v_role = 'contributor' THEN
			RETURN;
		END IF;
		UPDATE alert_feedback a SET useful = p_useful, comment = left(v_comment, 500), answered_at = now() WHERE a.id = f.id;
		RETURN QUERY SELECT f.kind, p.name::text FROM project p WHERE p.id = f.project_id;
	END
	$$;

-- ---------------------------------------------------------------------------
-- 4. Retention (the tick)
-- ---------------------------------------------------------------------------
-- Unanswered rows 30 days after the mail, answers 365 days after they were
-- given. Returns how many went.
CREATE FUNCTION app_purge_alert_answers() RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		n integer;
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker purges alert feedback' USING ERRCODE = 'insufficient_privilege';
		END IF;
		DELETE FROM alert_feedback
		WHERE (answered_at IS NULL AND sent_at < now() - interval '30 days')
		   OR answered_at < now() - interval '365 days';
		GET DIAGNOSTICS n = ROW_COUNT;
		RETURN n;
	END
	$$;

REVOKE ALL ON FUNCTION app_alert_answer_slot(uuid, boolean, bytea, bytea), app_alert_answer(bytea, boolean, text), app_purge_alert_answers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_alert_answer_slot(uuid, boolean, bytea, bytea), app_alert_answer(bytea, boolean, text), app_purge_alert_answers() TO water_app;
