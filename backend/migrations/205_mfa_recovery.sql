-- 205_mfa_recovery — recovering a lost second factor without the operator
-- (docs/security.md § Two-step sign-in → Recovery; docs/data-model.md
-- § Two-step sign-in). Before this, a person who lost their phone and their
-- recovery codes had to ask the operator to delete their user_totp and
-- user_recovery_code rows by hand.
--
-- Two ways now:
--
--   1. Self-service, with a wait. At the sign-in's code step (the password
--      just proved, the `wm_mfa` challenge live) the person asks for a reset.
--      Nothing changes yet: a confirmation link goes to the account's
--      address. Following it (single use, 1 hour) starts a 3-day wait: the
--      factor keeps working, and the start, a daily reminder and the end are
--      emailed, each with a cancel link that needs no sign-in. Any right
--      code cancels it (a sign-in, a step-up, or turning a factor off). At the end
--      the tick removes every second factor of the account and signs every
--      session out. So a thief with the password and the inbox still has to
--      get past three days of emails to the owner.
--   2. A team admin, at once, for a member of their team below admin (with a
--      code from the last 10 minutes; never themselves, never another admin).
--
-- mfa_reset is the person's own to read and nobody's to write: a person who
-- could UPDATE their row could move effective_at to now and skip the wait.
-- Every write goes through the SECURITY DEFINER functions below, each of
-- which checks the state it moves from. The cancel links' hashes and the
-- request cap are reachable only through those functions (owner-only
-- tables). mfa_remove_factors is the one place every second factor is
-- removed, whoever removes them (a completed reset, a team admin, the
-- operator, or the owner turning off their last one), and mfa_remove_factor
-- the one place the owner turns off one of several (206 adds the emailed
-- code to all three functions here).

-- ---------------------------------------------------------------------------
-- One place for "every second factor of the account"
-- ---------------------------------------------------------------------------
-- Whether the account has a second factor that signs in (a confirmed
-- authenticator; 206 adds a confirmed emailed code). A new kind of factor is
-- added here, in mfa_remove_factors and in mfa_remove_factor, nowhere else.
-- Invoker's rights: the API's hasConfirmedFactor (auth/stepUp.ts) calls it as
-- water_app, where RLS shows only the caller's own factor rows, and the
-- definer functions below call it as the owner, for any account. So the two
-- can't disagree.
CREATE FUNCTION mfa_has_factor(p_user uuid) RETURNS boolean
	LANGUAGE sql STABLE SET search_path = public
	AS $$
		SELECT EXISTS (SELECT 1 FROM user_totp WHERE user_id = p_user AND confirmed_at IS NOT NULL)
	$$;

-- Remove every second factor of the account (the authenticator and the
-- recovery codes), end a reset that was waiting, since nothing is left for
-- it to remove, and sign out every session (p_watermark, from the API's
-- clock as every watermark; 067's trigger keeps the later one). Not granted
-- to water_app: only the SECURITY DEFINER functions here call it, each after
-- its own check (the person themselves, a reset that came due, a team
-- admin), and the operator as the schema owner (deployment.md § Runbooks 14).
-- Defined after mfa_reset below.

-- ---------------------------------------------------------------------------
-- A reset of the second factor, asked for by the person
-- ---------------------------------------------------------------------------
CREATE TABLE mfa_reset (
	id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id            uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
	requested_at       timestamptz NOT NULL DEFAULT now(),
	-- SHA-256 of the emailed confirmation token (auth/tokens.ts); cleared once
	-- used, so the link works once.
	confirm_hash       bytea UNIQUE CHECK (octet_length(confirm_hash) = 32),
	confirm_expires_at timestamptz NOT NULL,
	-- The link was followed: the wait started, and ends at effective_at.
	confirmed_at       timestamptz,
	effective_at       timestamptz,
	-- When the last notice (the start, or a daily reminder) was sent; null when
	-- the start email failed, so the next tick sends one at once.
	notified_at        timestamptz,
	ended_at           timestamptz,
	-- completed: the factors were removed. cancel_link: the emailed cancel link.
	-- code_used: a sign-in or step-up with a code. factor_removed: the factor was
	-- turned off, or a team admin removed it. unconfirmed: the confirmation link
	-- expired unused, or a new one replaced it.
	end_reason         text CHECK (end_reason IN ('completed', 'cancel_link', 'code_used', 'factor_removed', 'unconfirmed')),
	CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
	CHECK ((confirmed_at IS NULL) = (effective_at IS NULL)),
	CHECK (confirmed_at IS NULL OR confirm_hash IS NULL),
	CHECK (ended_at IS NULL OR confirm_hash IS NULL)
);
COMMENT ON TABLE mfa_reset IS
	'A person''s request to remove their lost second factor (205): confirmed by email, then a 3-day wait. Own rows read only; written only by its SECURITY DEFINER functions.';
-- Covers the foreign key, and the person's own list.
CREATE INDEX mfa_reset_user_idx ON mfa_reset (user_id, requested_at DESC);
-- One reset at a time per account.
CREATE UNIQUE INDEX mfa_reset_one_pending_idx ON mfa_reset (user_id) WHERE ended_at IS NULL;
-- The tick's look for what is due, and its purge of ended rows.
CREATE INDEX mfa_reset_due_idx ON mfa_reset (effective_at) WHERE ended_at IS NULL AND confirmed_at IS NOT NULL;
CREATE INDEX mfa_reset_ended_idx ON mfa_reset (ended_at) WHERE ended_at IS NOT NULL;

ALTER TABLE mfa_reset ENABLE ROW LEVEL SECURITY;
CREATE POLICY mfa_reset_own_select ON mfa_reset FOR SELECT USING (user_id = app_current_user_id());
GRANT SELECT ON mfa_reset TO water_app;

-- The cancel links: one per email sent while the reset waits (the start and
-- each reminder), each the SHA-256 of its token, all valid until the reset
-- ends (then deleted). Owner-only: read and written by the functions below.
CREATE TABLE mfa_reset_cancel (
	token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
	reset_id   uuid NOT NULL REFERENCES mfa_reset (id) ON DELETE CASCADE,
	created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mfa_reset_cancel_reset_idx ON mfa_reset_cancel (reset_id);
ALTER TABLE mfa_reset_cancel ENABLE ROW LEVEL SECURITY;

-- The cap on asking: each request sends an email (SES bills it), so an
-- account may ask p_cap times in p_window. Owner-only, like the reset-mail
-- quota (078); rows go after the window.
CREATE TABLE mfa_reset_quota (
	user_id uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
	sent_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mfa_reset_quota_user_idx ON mfa_reset_quota (user_id, sent_at);
CREATE INDEX mfa_reset_quota_sent_idx ON mfa_reset_quota (sent_at);
ALTER TABLE mfa_reset_quota ENABLE ROW LEVEL SECURITY;

-- The account's own security log learns the reset's steps.
ALTER TABLE account_security_event DROP CONSTRAINT account_security_event_kind_check;
ALTER TABLE account_security_event ADD CONSTRAINT account_security_event_kind_check CHECK (kind IN (
	'mfa.enrolled',
	'mfa.disabled',
	'mfa.recovery_used',
	'mfa.recovery_regenerated',
	'mfa.reset_requested',      -- asked for a reset at the sign-in's code step (a link emailed)
	'mfa.reset_confirmed',      -- followed the link: the 3-day wait started
	'mfa.reset_cancelled',      -- a wait ended without a reset (the cancel link, a code, the factor turned off)
	'mfa.reset_completed',      -- the wait ended: every second factor removed, every session signed out
	'mfa.reset_by_admin',       -- a team admin removed the second factor
	'mfa.reset_by_operator'     -- the operator removed it, as the schema owner (deployment.md § Runbooks 14)
));

CREATE FUNCTION mfa_remove_factors(p_user uuid, p_watermark timestamptz) RETURNS void
	LANGUAGE plpgsql SET search_path = public
	AS $$
	DECLARE
		v_ended integer;
	BEGIN
		IF p_watermark IS NULL THEN
			RAISE EXCEPTION 'mfa_remove_factors: a watermark is required' USING ERRCODE = '22023';
		END IF;
		DELETE FROM user_recovery_code WHERE user_id = p_user;
		DELETE FROM user_totp WHERE user_id = p_user;
		DELETE FROM mfa_reset_cancel c USING mfa_reset r WHERE c.reset_id = r.id AND r.user_id = p_user AND r.ended_at IS NULL;
		UPDATE mfa_reset SET ended_at = now(), end_reason = 'factor_removed', confirm_hash = NULL
		WHERE user_id = p_user AND ended_at IS NULL;
		GET DIAGNOSTICS v_ended = ROW_COUNT;
		IF v_ended > 0 THEN
			INSERT INTO account_security_event (user_id, kind) VALUES (p_user, 'mfa.reset_cancelled');
		END IF;
		UPDATE app_user SET sessions_revoked_at = p_watermark WHERE id = p_user;
	END
	$$;

-- The owner turns off one factor (p_method: 'totp'; 206 adds 'email'). While
-- another is still on, only that one goes: the recovery codes stand in for any
-- factor, so they stay, and a waiting reset stays too (the route that called
-- this took a right code first, and a right code ends a waiting reset on its
-- own: app_mfa_reset_cancel_own). With the last one, everything goes through
-- mfa_remove_factors. Every session is signed out either way, so none that
-- signed in with the factor outlives it. True while a factor is still on.
CREATE FUNCTION mfa_remove_factor(p_user uuid, p_method text, p_watermark timestamptz) RETURNS boolean
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF p_watermark IS NULL THEN
			RAISE EXCEPTION 'mfa_remove_factor: a watermark is required' USING ERRCODE = '22023';
		END IF;
		IF p_method = 'totp' THEN
			DELETE FROM user_totp WHERE user_id = p_user;
		ELSE
			RAISE EXCEPTION 'mfa_remove_factor: unknown factor %', p_method USING ERRCODE = '22023';
		END IF;
		IF NOT mfa_has_factor(p_user) THEN
			PERFORM mfa_remove_factors(p_user, p_watermark);
			RETURN false;
		END IF;
		UPDATE app_user SET sessions_revoked_at = p_watermark WHERE id = p_user;
		RETURN true;
	END
	$$;
REVOKE ALL ON FUNCTION mfa_has_factor(uuid), mfa_remove_factors(uuid, timestamptz), mfa_remove_factor(uuid, text, timestamptz) FROM PUBLIC;
-- The one test the API makes (hasConfirmedFactor): invoker's rights, so RLS limits it to the caller's own rows.
GRANT EXECUTE ON FUNCTION mfa_has_factor(uuid) TO water_app;

-- End the account's waiting reset, if any, without removing anything: its
-- cancel links go, and the log says so. Not granted; the functions below call it.
CREATE FUNCTION mfa_reset_end(p_user uuid, p_reason text) RETURNS boolean
	LANGUAGE plpgsql SET search_path = public
	AS $$
	DECLARE
		v_ended integer;
	BEGIN
		DELETE FROM mfa_reset_cancel c USING mfa_reset r WHERE c.reset_id = r.id AND r.user_id = p_user AND r.ended_at IS NULL;
		UPDATE mfa_reset SET ended_at = now(), end_reason = p_reason, confirm_hash = NULL
		WHERE user_id = p_user AND ended_at IS NULL;
		GET DIAGNOSTICS v_ended = ROW_COUNT;
		IF v_ended > 0 AND p_reason <> 'unconfirmed' THEN
			INSERT INTO account_security_event (user_id, kind) VALUES (p_user, 'mfa.reset_cancelled');
		END IF;
		RETURN v_ended > 0;
	END
	$$;
REVOKE ALL ON FUNCTION mfa_reset_end(uuid, text) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- The person's own steps (as the account: app.current_user_id)
-- ---------------------------------------------------------------------------
-- Turn one of the person's own factors off (DELETE /auth/mfa/totp, 206's
-- DELETE /auth/mfa/email, after a right code): mfa_remove_factor. True while
-- another factor is still on.
CREATE FUNCTION app_mfa_remove_own_factor(p_method text, p_watermark timestamptz) RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF app_current_user_id() IS NULL THEN
			RAISE EXCEPTION 'app_mfa_remove_own_factor: not allowed' USING ERRCODE = '42501';
		END IF;
		RETURN mfa_remove_factor(app_current_user_id(), p_method, p_watermark);
	END
	$$;

-- A code just signed the account in (or stepped a session up): the owner has
-- their factor, so a waiting reset is cancelled. True when one was.
CREATE FUNCTION app_mfa_reset_cancel_own() RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF app_current_user_id() IS NULL THEN
			RAISE EXCEPTION 'app_mfa_reset_cancel_own: not allowed' USING ERRCODE = '42501';
		END IF;
		RETURN mfa_reset_end(app_current_user_id(), 'code_used');
	END
	$$;

-- Ask for a reset (POST /auth/mfa/reset, as the account a live sign-in
-- challenge proved). Returns one row:
--   'issued'       a new confirmation link (p_hash), valid p_ttl; any earlier unused link is void
--   'pending'      a confirmed reset is already waiting (effective_at says until when); nothing sent
--   'capped'       p_cap requests in the last p_window; nothing sent
--   'not_enrolled' no second factor to reset; nothing sent
CREATE FUNCTION app_mfa_reset_request(p_hash bytea, p_ttl interval, p_cap integer, p_window interval)
	RETURNS TABLE (status text, effective_at timestamptz)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
		v_pending mfa_reset%ROWTYPE;
	BEGIN
		IF uid IS NULL THEN
			RAISE EXCEPTION 'app_mfa_reset_request: not allowed' USING ERRCODE = '42501';
		END IF;
		-- Two requests at once queue here, so neither passes the cap or the one-pending check alone.
		PERFORM pg_advisory_xact_lock(hashtext('mfa_reset:' || uid::text));
		IF NOT mfa_has_factor(uid) THEN
			RETURN QUERY SELECT 'not_enrolled'::text, NULL::timestamptz;
			RETURN;
		END IF;
		SELECT * INTO v_pending FROM mfa_reset r WHERE r.user_id = uid AND r.ended_at IS NULL FOR UPDATE;
		IF v_pending.id IS NOT NULL AND v_pending.confirmed_at IS NOT NULL THEN
			RETURN QUERY SELECT 'pending'::text, v_pending.effective_at;
			RETURN;
		END IF;
		DELETE FROM mfa_reset_quota q WHERE q.sent_at <= now() - p_window;
		IF (SELECT count(*) FROM mfa_reset_quota q WHERE q.user_id = uid) >= p_cap THEN
			RETURN QUERY SELECT 'capped'::text, NULL::timestamptz;
			RETURN;
		END IF;
		-- An unconfirmed request (live or lapsed) gives way to the new one: one link at a time.
		IF v_pending.id IS NOT NULL THEN
			PERFORM mfa_reset_end(uid, 'unconfirmed');
		END IF;
		INSERT INTO mfa_reset (user_id, confirm_hash, confirm_expires_at) VALUES (uid, p_hash, now() + p_ttl);
		INSERT INTO mfa_reset_quota (user_id) VALUES (uid);
		INSERT INTO account_security_event (user_id, kind) VALUES (uid, 'mfa.reset_requested');
		RETURN QUERY SELECT 'issued'::text, NULL::timestamptz;
	END
	$$;

-- ---------------------------------------------------------------------------
-- The emailed links (no one signed in: the token is the credential)
-- ---------------------------------------------------------------------------
-- Follow the confirmation link: the wait starts (p_wait), and p_cancel_hash is
-- the first cancel link (in the "started" email). The account's address and
-- language for that email, or no row: an unknown, used or expired link, or an
-- account with no factor left.
CREATE FUNCTION app_mfa_reset_confirm(p_hash bytea, p_wait interval, p_cancel_hash bytea)
	RETURNS TABLE (user_id uuid, email citext, locale text, effective_at timestamptz)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v mfa_reset%ROWTYPE;
	BEGIN
		SELECT * INTO v FROM mfa_reset r
		WHERE r.confirm_hash = p_hash AND r.ended_at IS NULL AND r.confirmed_at IS NULL AND r.confirm_expires_at > now()
		FOR UPDATE;
		IF v.id IS NULL THEN
			RETURN;
		END IF;
		IF NOT mfa_has_factor(v.user_id) THEN
			PERFORM mfa_reset_end(v.user_id, 'factor_removed');
			RETURN;
		END IF;
		UPDATE mfa_reset r SET confirm_hash = NULL, confirmed_at = now(), effective_at = now() + p_wait, notified_at = now()
		WHERE r.id = v.id;
		INSERT INTO mfa_reset_cancel (token_hash, reset_id) VALUES (p_cancel_hash, v.id);
		INSERT INTO account_security_event (user_id, kind) VALUES (v.user_id, 'mfa.reset_confirmed');
		RETURN QUERY
			SELECT u.id, u.email, u.locale::text, r.effective_at
			FROM app_user u JOIN mfa_reset r ON r.user_id = u.id
			WHERE r.id = v.id;
	END
	$$;

-- Follow a cancel link: the waiting reset ends and every one of its cancel
-- links goes. The account's id, or no row (unknown, or the reset already ended).
CREATE FUNCTION app_mfa_reset_cancel(p_hash bytea) RETURNS uuid
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_user uuid;
	BEGIN
		SELECT r.user_id INTO v_user FROM mfa_reset_cancel c JOIN mfa_reset r ON r.id = c.reset_id
		WHERE c.token_hash = p_hash AND r.ended_at IS NULL
		FOR UPDATE OF r;
		IF v_user IS NULL THEN
			RETURN NULL;
		END IF;
		PERFORM mfa_reset_end(v_user, 'cancel_link');
		RETURN v_user;
	END
	$$;

-- ---------------------------------------------------------------------------
-- The tick (no one signed in): reminders and completion
-- ---------------------------------------------------------------------------
-- The waiting resets that need the tick: 'complete' once effective_at has
-- passed; 'remind' when the last notice is p_gap old and the end is more than
-- p_margin away (the completion email says it then). Read only: each is
-- handed out by app_mfa_reset_remind / app_mfa_reset_complete, which check again.
CREATE FUNCTION app_mfa_reset_due(p_limit integer, p_gap interval, p_margin interval)
	RETURNS TABLE (id uuid, action text)
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT r.id, CASE WHEN r.effective_at <= now() THEN 'complete' ELSE 'remind' END
		FROM mfa_reset r
		WHERE r.ended_at IS NULL AND r.confirmed_at IS NOT NULL
		  AND (r.effective_at <= now() OR ((r.notified_at IS NULL OR r.notified_at <= now() - p_gap) AND r.effective_at > now() + p_margin))
		ORDER BY r.effective_at
		LIMIT p_limit
	$$;

-- The "started" email (sent by the confirm route after this commits) could not
-- be sent: mark the reset as never notified, so the next tick sends a
-- reminder with a cancel link at once instead of a day later. Names the reset
-- by the cancel link that email carried; true when it did.
CREATE FUNCTION app_mfa_reset_notice_failed(p_cancel_hash bytea) RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_n integer;
	BEGIN
		UPDATE mfa_reset r SET notified_at = NULL
		FROM mfa_reset_cancel c
		WHERE c.token_hash = p_cancel_hash AND c.reset_id = r.id AND r.ended_at IS NULL;
		GET DIAGNOSTICS v_n = ROW_COUNT;
		RETURN v_n > 0;
	END
	$$;

-- Mark one reminder sent (at most once per p_gap) and add its cancel link:
-- the address, language and end for its email, or no row when it isn't due.
CREATE FUNCTION app_mfa_reset_remind(p_id uuid, p_cancel_hash bytea, p_gap interval, p_margin interval)
	RETURNS TABLE (email citext, locale text, effective_at timestamptz)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_user uuid;
	BEGIN
		UPDATE mfa_reset r SET notified_at = now()
		WHERE r.id = p_id AND r.ended_at IS NULL AND r.confirmed_at IS NOT NULL
		  AND (r.notified_at IS NULL OR r.notified_at <= now() - p_gap) AND r.effective_at > now() + p_margin
		RETURNING r.user_id INTO v_user;
		IF v_user IS NULL THEN
			RETURN;
		END IF;
		INSERT INTO mfa_reset_cancel (token_hash, reset_id) VALUES (p_cancel_hash, p_id);
		RETURN QUERY SELECT u.email, u.locale::text, r.effective_at FROM app_user u JOIN mfa_reset r ON r.user_id = u.id WHERE r.id = p_id;
	END
	$$;

-- Complete one reset whose wait is over: every second factor goes, every
-- session is signed out (the watermark, p_watermark from the API's clock, as
-- every other watermark), and the log says so. The address and language for
-- the completion email, or no row when it isn't due (cancelled meanwhile).
CREATE FUNCTION app_mfa_reset_complete(p_id uuid, p_watermark timestamptz)
	RETURNS TABLE (email citext, locale text)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_user uuid;
	BEGIN
		UPDATE mfa_reset r SET ended_at = now(), end_reason = 'completed'
		WHERE r.id = p_id AND r.ended_at IS NULL AND r.confirmed_at IS NOT NULL AND r.effective_at <= now()
		RETURNING r.user_id INTO v_user;
		IF v_user IS NULL THEN
			RETURN;
		END IF;
		DELETE FROM mfa_reset_cancel c WHERE c.reset_id = p_id;
		-- Every factor, and the watermark (067's trigger keeps the later one).
		PERFORM mfa_remove_factors(v_user, p_watermark);
		INSERT INTO account_security_event (user_id, kind) VALUES (v_user, 'mfa.reset_completed');
		RETURN QUERY SELECT u.email, u.locale::text FROM app_user u WHERE u.id = v_user;
	END
	$$;

-- Housekeeping: a confirmation link that lapsed unused ends its request, and
-- an ended request is deleted p_keep after it ended (the account's security
-- log keeps that it happened). The number of rows deleted.
CREATE FUNCTION app_mfa_reset_purge(p_keep interval) RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_deleted integer;
	BEGIN
		UPDATE mfa_reset SET ended_at = now(), end_reason = 'unconfirmed', confirm_hash = NULL
		WHERE ended_at IS NULL AND confirmed_at IS NULL AND confirm_expires_at <= now();
		DELETE FROM mfa_reset WHERE ended_at < now() - p_keep;
		GET DIAGNOSTICS v_deleted = ROW_COUNT;
		DELETE FROM mfa_reset_quota WHERE sent_at < now() - interval '1 day';
		RETURN v_deleted;
	END
	$$;

-- ---------------------------------------------------------------------------
-- A team admin removes a member's second factor (as the admin)
-- ---------------------------------------------------------------------------
-- The route checked team admin, two-step sign-in and a fresh code first
-- (requireTeamRole, requireFreshCode); this checks the facts again, as the
-- database sees them. Returns one row:
--   'not_found'    the caller isn't the team's admin, or the person isn't in the team
--   'self'         the caller named themselves (they use the self-service reset)
--   'admin'        the member is an admin of the team too: an admin's factor is
--                  never reset by another admin (operator decision, 2026-10-08),
--                  only by the self-service reset or the operator
--   'not_enrolled' the member has no second factor
--   'done'         removed, the member's sessions signed out; their address and language for the email
CREATE FUNCTION app_mfa_team_reset(p_team uuid, p_user uuid, p_watermark timestamptz)
	RETURNS TABLE (status text, email citext, locale text)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
	BEGIN
		IF uid IS NULL THEN
			RAISE EXCEPTION 'app_mfa_team_reset: not allowed' USING ERRCODE = '42501';
		END IF;
		IF app_team_role(p_team) IS DISTINCT FROM 'admin'
			OR NOT EXISTS (SELECT 1 FROM team_member m WHERE m.team_id = p_team AND m.user_id = p_user) THEN
			RETURN QUERY SELECT 'not_found'::text, NULL::citext, NULL::text;
			RETURN;
		END IF;
		IF p_user = uid THEN
			RETURN QUERY SELECT 'self'::text, NULL::citext, NULL::text;
			RETURN;
		END IF;
		IF EXISTS (SELECT 1 FROM team_member m WHERE m.team_id = p_team AND m.user_id = p_user AND m.role = 'admin') THEN
			RETURN QUERY SELECT 'admin'::text, NULL::citext, NULL::text;
			RETURN;
		END IF;
		IF NOT mfa_has_factor(p_user) THEN
			RETURN QUERY SELECT 'not_enrolled'::text, NULL::citext, NULL::text;
			RETURN;
		END IF;
		PERFORM mfa_remove_factors(p_user, p_watermark);
		INSERT INTO account_security_event (user_id, kind) VALUES (p_user, 'mfa.reset_by_admin');
		RETURN QUERY SELECT 'done'::text, u.email, u.locale::text FROM app_user u WHERE u.id = p_user;
	END
	$$;

REVOKE ALL ON FUNCTION
	app_mfa_remove_own_factor(text, timestamptz),
	app_mfa_reset_cancel_own(),
	app_mfa_reset_request(bytea, interval, integer, interval),
	app_mfa_reset_confirm(bytea, interval, bytea),
	app_mfa_reset_cancel(bytea),
	app_mfa_reset_due(integer, interval, interval),
	app_mfa_reset_remind(uuid, bytea, interval, interval),
	app_mfa_reset_notice_failed(bytea),
	app_mfa_reset_complete(uuid, timestamptz),
	app_mfa_reset_purge(interval),
	app_mfa_team_reset(uuid, uuid, timestamptz)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
	app_mfa_remove_own_factor(text, timestamptz),
	app_mfa_reset_cancel_own(),
	app_mfa_reset_request(bytea, interval, integer, interval),
	app_mfa_reset_confirm(bytea, interval, bytea),
	app_mfa_reset_cancel(bytea),
	app_mfa_reset_due(integer, interval, interval),
	app_mfa_reset_remind(uuid, bytea, interval, interval),
	app_mfa_reset_notice_failed(bytea),
	app_mfa_reset_complete(uuid, timestamptz),
	app_mfa_reset_purge(interval),
	app_mfa_team_reset(uuid, uuid, timestamptz)
TO water_app;
