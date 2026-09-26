-- 054_alert_followups — the WP-2.13 alert follow-ups (docs/followups.md
-- § Alerts; docs/data-model.md § Alerts, docs/security.md § Alerts).
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
	'SES reported a permanent bounce or a complaint for this address (054): alert emails pause until the person turns mail back on (POST /me/alerts/resume).';

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
