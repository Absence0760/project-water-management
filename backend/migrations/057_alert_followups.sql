-- 057_alert_followups — the WP-2.13 alert follow-ups (docs/followups.md
-- § Alerts; docs/data-model.md § Alerts, docs/security.md § Alerts): mail
-- suppression (below) and per-feed staleness levels (at the end).
--
-- Mail suppression: SES reports a hard bounce or a complaint for an address
-- (the configuration set's BOUNCE / COMPLAINT event destination → SNS → the
-- mail-events queue → the worker, infra/ses.tf, backend/src/mail/suppression.ts;
-- locally `pnpm dev:mail:bounce <email>`). The address's person gets a flag
-- on app_user, their alert emails pause (their choices are kept, so turning
-- mail back on restores them as they were), and the account and alert pages
-- show a banner that lets them turn mail back on once the address is fixed
-- (POST /me/alerts/resume).
--
--   app_user.mail_suppressed_at      when SES first reported the address in
--                                    this suppression (NULL: mail flows)
--   app_user.mail_suppressed_reason  'bounce' (a permanent bounce) or 'complaint'
--   app_user.mail_resumed_at         when the person last turned mail back on:
--                                    an SES event about a mail sent before
--                                    then is stale and suppresses nothing
--
-- app_user has no RLS (001: it is read before sign-in); the worker sets the
-- flag only through app_mail_suppress, in its own context, and a person
-- clears only their own (the route, by their session's id).

ALTER TABLE app_user
	ADD COLUMN mail_suppressed_at timestamptz,
	ADD COLUMN mail_suppressed_reason text CHECK (mail_suppressed_reason IN ('bounce', 'complaint')),
	ADD COLUMN mail_resumed_at timestamptz,
	ADD CONSTRAINT app_user_mail_suppressed_pair CHECK ((mail_suppressed_at IS NULL) = (mail_suppressed_reason IS NULL));

COMMENT ON COLUMN app_user.mail_suppressed_at IS
	'SES reported a permanent bounce or a complaint for this address (057): alert emails pause until the person turns mail back on (POST /me/alerts/resume).';

-- The worker's context only (no user, no API key): the SES bounce/complaint
-- handler. Flags the person with that address (case-insensitive, citext),
-- unless the event is about a mail sent before they last turned mail back on
-- (p_sent_at: SES's mail.timestamp; stale), and skips the alert deliveries
-- waiting for them, so nothing queued goes out to a dead address. A person
-- already flagged keeps their first date. Returns 1 when it flagged someone,
-- else 0 (no such address, already flagged, or stale).
CREATE FUNCTION app_mail_suppress(p_email text, p_reason text, p_sent_at timestamptz) RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_user uuid;
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker records mail suppression' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_reason IS NULL OR p_reason NOT IN ('bounce', 'complaint') THEN
			RAISE EXCEPTION 'a suppression is a bounce or a complaint' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		IF p_email IS NULL OR char_length(p_email) > 320 THEN
			RETURN 0;
		END IF;
		UPDATE app_user u SET mail_suppressed_at = now(), mail_suppressed_reason = p_reason
		WHERE u.email = p_email::citext
		  AND u.mail_suppressed_at IS NULL
		  AND (u.mail_resumed_at IS NULL OR p_sent_at IS NULL OR p_sent_at > u.mail_resumed_at)
		RETURNING u.id INTO v_user;
		IF v_user IS NULL THEN
			RETURN 0;
		END IF;
		UPDATE alert_delivery SET status = 'skipped', locked_until = NULL,
			reason = 'the address is suppressed (' || p_reason || ')'
		WHERE user_id = v_user AND status IN ('pending', 'digest');
		RETURN 1;
	END
	$$;

REVOKE ALL ON FUNCTION app_mail_suppress(text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_mail_suppress(text, text, timestamptz) TO water_app;

-- app_alert_recipients, from its latest definition (051): a suppressed
-- address gets no alerts (its deliveries aren't even made).
CREATE OR REPLACE FUNCTION app_alert_recipients(p_project uuid, p_kind text, p_node uuid)
	RETURNS TABLE (user_id uuid, email text, locale text, volume_unit text, role text, mode text)
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT a.user_id, u.email::text, u.locale, u.volume_unit, a.role::text, a.mode
		FROM alert_audience(p_project, p_kind, p_node) a
		JOIN app_user u ON u.id = a.user_id
		WHERE a.mode <> 'off' AND u.email_verified_at IS NOT NULL AND u.mail_suppressed_at IS NULL
		  AND (app_has_role(p_project, 'editor') OR (app_current_user_id() IS NULL AND app_current_api_key_id() IS NULL))
	$$;

-- ---------------------------------------------------------------------------
-- Per-feed staleness levels
-- ---------------------------------------------------------------------------
-- data_stale was one rule per catchment, one level for every feed; each feed
-- now has its own rule and level (alert_rule.feed_id), still measured past
-- that feed's own usual delay (feeds/config.ts staleAfterDays, or the feed's
-- config), with a default per source (SOURCES[source].staleAlertDays). An
-- editor sets each on the rule editor; once data_stale is on for any feed, a
-- feed added later gets its rule at its source's default
-- (alerts/evaluate.ts ensureFeedRules).
--
-- 051's catchment-wide rules are converted IN PLACE, so their history stays
-- (docs/security.md keeps events 180 days after clearing, and a person's
-- deliveries are in their data export):
--   * a project with feeds: the old rule becomes the first feed's rule (in
--     the feeds page's order), its events and deliveries with it, and each
--     other feed gets a new rule at the same level, switch and creator;
--   * a project with no feed yet: the old rule stays, with no feed, as that
--     catchment's pending choice (on or off, and its level). ensureFeedRules
--     adopts it for the first feed added (feed_id set once, from NULL: the
--     only change a rule's feed may make), and provisions the rest if it is
--     on. A feed-less rule has no value, so it never fires; the rule editor
--     lists feeds, so it isn't shown, and the API never makes one.

ALTER TABLE alert_rule ADD COLUMN feed_id uuid REFERENCES data_feed(id) ON DELETE CASCADE;
CREATE INDEX alert_rule_feed_idx ON alert_rule (feed_id);
COMMENT ON COLUMN alert_rule.feed_id IS
	'The data feed a data_stale rule watches (057); NULL for every other kind.';

-- One rule per kind, farm and feed per project; also covers project_id.
DROP INDEX alert_rule_key_idx;
CREATE UNIQUE INDEX alert_rule_key_idx ON alert_rule (project_id, kind, node_id, feed_id) NULLS NOT DISTINCT;

-- alert_rule_check, from its latest definition (051): a data_stale rule's
-- feed is one of the project's (SECURITY DEFINER, as for the farm: the
-- caller is an editor, who reads the feeds anyway), and a rule's feed never
-- changes either, except once from NULL (a pending rule adopted, above).
CREATE OR REPLACE FUNCTION alert_rule_check() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NEW.node_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM node WHERE id = NEW.node_id AND kind = 'farm') THEN
			RAISE EXCEPTION 'node % is not a farm', NEW.node_id USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.feed_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM data_feed WHERE id = NEW.feed_id AND project_id = NEW.project_id) THEN
			RAISE EXCEPTION 'feed % belongs to a different project', NEW.feed_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		NEW.updated_at := now();
		IF TG_OP = 'INSERT' THEN
			NEW.created_by := app_current_user_id();
			NEW.created_at := now();
		ELSE
			NEW.created_by := OLD.created_by;
			NEW.created_at := OLD.created_at;
			-- A feed-less data_stale rule (057's conversion) may be given its feed once.
			IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.node_id IS DISTINCT FROM OLD.node_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
				OR (NEW.feed_id IS DISTINCT FROM OLD.feed_id AND OLD.feed_id IS NOT NULL) THEN
				RAISE EXCEPTION 'a rule''s kind, farm and feed never change' USING ERRCODE = 'check_violation';
			END IF;
		END IF;
		RETURN NEW;
	END
	$$;

-- The conversion (see above). The trigger is off so each rule keeps its
-- creator and dates (it would stamp the migration's none).
ALTER TABLE alert_rule DISABLE TRIGGER alert_rule_check;
WITH first_feed AS (
	SELECT DISTINCT ON (r.id) r.id AS rule_id, f.id AS feed_id
	FROM alert_rule r JOIN data_feed f ON f.project_id = r.project_id
	WHERE r.kind = 'data_stale' AND r.feed_id IS NULL
	ORDER BY r.id, f.source, f.target_kind, f.target_name, f.id
), others AS (
	SELECT r.project_id, f.id AS feed_id, r.threshold, r.enabled, r.created_by, r.created_at
	FROM alert_rule r JOIN first_feed ff ON ff.rule_id = r.id
	JOIN data_feed f ON f.project_id = r.project_id AND f.id <> ff.feed_id
), converted AS (
	UPDATE alert_rule r SET feed_id = ff.feed_id FROM first_feed ff WHERE r.id = ff.rule_id RETURNING r.id
)
INSERT INTO alert_rule (project_id, kind, feed_id, threshold, enabled, created_by, created_at, updated_at)
	SELECT o.project_id, 'data_stale', o.feed_id, o.threshold, o.enabled, o.created_by, o.created_at, now() FROM others o;
ALTER TABLE alert_rule ENABLE TRIGGER alert_rule_check;

-- A feed only on a data_stale rule; a data_stale rule without one is a
-- feed-less catchment's pending choice (above).
ALTER TABLE alert_rule ADD CONSTRAINT alert_rule_feed_kind CHECK (feed_id IS NULL OR kind = 'data_stale');
