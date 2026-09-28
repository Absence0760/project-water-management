-- 078_account_mail_cap — a daily cap on reset and verification emails per
-- address, with a trusted device's own allowance (docs/security.md § Password
-- reset, email verification and invites).
--
-- Before, the only limit on POST /auth/forgot-password (and the verification
-- emails: sign-up, resend, an invite to an unverified account) was
-- app_issue_email_token's one-per-minute cooldown (004), so a distributed
-- sender could have one address mailed about 1440 times a day.
--
-- Now app_issue_email_token also counts the address's reset and verification
-- emails of the last p_window (24 hours) and refuses once p_cap (10) went out.
-- Since anyone can fill the shared count, a request from a browser holding a
-- valid `wm_device` cookie for the address (auth/device.ts, 070) counts on
-- that device's own allowance instead (the same cap, per device), so a
-- stranger who used up the shared count can't block the owner's own browser.
-- The route's response doesn't change when the cap refuses (forgot-password
-- stays 202, the same body, known address or not).
--
-- The count is kept per account (one per address: app_user.email is unique
-- and never changes), so it holds no copy of the address and goes with the
-- account (ON DELETE CASCADE); rows also go once older than the window. The
-- per-user advisory lock now covers both purposes, so a reset and a
-- verification issued at once can't both pass the count.

CREATE TABLE account_mail_quota (
	user_id uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
	-- NULL: the shared count. Else the `wm_device` cookie's random id (its MAC
	-- is never stored), whose own allowance this email used.
	device  text CHECK (device ~ '^[A-Za-z0-9_-]{22}$'),
	sent_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE account_mail_quota IS
	'Reset and verification emails per account (and trusted device) for the daily cap (078). SECURITY DEFINER access only; rows go after the window.';
-- Covers the foreign key, and the count.
CREATE INDEX account_mail_quota_user_idx ON account_mail_quota (user_id, sent_at);
-- Housekeeping deletes rows by age.
CREATE INDEX account_mail_quota_sent_idx ON account_mail_quota (sent_at);

-- As login_throttle: the app touches it only through the function below.
ALTER TABLE account_mail_quota ENABLE ROW LEVEL SECURITY;
CREATE POLICY account_mail_quota_none ON account_mail_quota USING (false) WITH CHECK (false);
GRANT SELECT, INSERT, UPDATE, DELETE ON account_mail_quota TO water_app;

-- From 004 (its only definition): the cooldown as before, then the cap.
-- Returns 'issued', 'cooldown' or 'capped'.
DROP FUNCTION app_issue_email_token(uuid, email_token_purpose, bytea, interval, interval);
CREATE FUNCTION app_issue_email_token(
	p_user uuid, p_purpose email_token_purpose, p_hash bytea, p_ttl interval, p_cooldown interval,
	p_device text, p_cap integer, p_window interval
) RETURNS text
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		-- Serialise concurrent requests for the same user (either purpose: the
		-- cap counts both) so two simultaneous calls can't both pass a check.
		PERFORM pg_advisory_xact_lock(hashtext('account_mail:' || p_user::text));
		IF EXISTS (
			SELECT 1 FROM email_token
			WHERE user_id = p_user AND purpose = p_purpose AND created_at > now() - p_cooldown
		) THEN
			RETURN 'cooldown';
		END IF;
		DELETE FROM account_mail_quota WHERE sent_at <= now() - p_window;
		IF (SELECT count(*) FROM account_mail_quota
			WHERE user_id = p_user AND device IS NOT DISTINCT FROM p_device AND sent_at > now() - p_window) >= p_cap THEN
			RETURN 'capped';
		END IF;
		DELETE FROM email_token WHERE user_id = p_user AND purpose = p_purpose;
		INSERT INTO email_token (user_id, purpose, token_hash, expires_at)
		VALUES (p_user, p_purpose, p_hash, now() + p_ttl);
		INSERT INTO account_mail_quota (user_id, device) VALUES (p_user, p_device);
		RETURN 'issued';
	END
	$$;

REVOKE ALL ON FUNCTION app_issue_email_token(uuid, email_token_purpose, bytea, interval, interval, text, integer, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_issue_email_token(uuid, email_token_purpose, bytea, interval, interval, text, integer, interval) TO water_app;
