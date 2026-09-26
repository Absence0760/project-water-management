-- 051_alerts — email alerts with preferences, one-click unsubscribe and rate
-- limits (roadmap WP-2.13; docs/data-model.md § Alerts, docs/security.md
-- § Alerts, docs/architecture.md § Background work).
--
-- Four tables:
--
--   alert_rule          what to watch, per project (a threshold per kind, and
--                       per farm for dam_below). Alerts are opt-in per
--                       project: an editor switches kinds on (PUT
--                       /projects/:id/alert-rules), and until then nothing is
--                       evaluated or sent (backend/src/alerts/rules.ts).
--   alert_event         one row per time a rule fired: 'firing' until the value
--                       recovers past the threshold plus a margin (hysteresis,
--                       alerts/rules.ts), then 'cleared'. At most one firing
--                       event per rule (alert_event_firing_idx), so a value
--                       hovering at the threshold can't send a mail a day.
--   alert_subscription  a person's choice per project and kind (and farm):
--                       immediate, daily digest or off, with the hash of the
--                       unsubscribe token their alert mails carry.
--   alert_delivery      one row per event and recipient: the outbox the
--                       worker sends from, and the record of what was sent.
--                       UNIQUE (event_id, user_id): one mail per event per
--                       person, ever. Kept 180 days.
--
-- Who can do what (RLS):
--   * alert_rule: viewers and above read every rule, a farmer the rules on
--     their own farms and the restriction-notice rule; editors write.
--   * alert_event: viewers and above read every event; a farmer reads the
--     events on their own farms and the restriction-notice events (they read
--     the publication those come from already). Editors write (the alert_eval
--     job runs as an editor); only state, cleared_at, value and detail ever
--     change, and a cleared event never fires again (alert_event_guard).
--   * alert_subscription: a person reads and changes only their own rows, and
--     only for projects they can still open; a farmer's farm (node_id) must be
--     one of theirs.
--   * alert_delivery: a person reads their own rows. Nobody writes through
--     RLS: fan-out, claiming, finishing and purging are SECURITY DEFINER
--     functions below.
--
-- Recipients are decided by app_alert_recipients at fan-out, and each one's
-- access is checked again when their mail is built (app_alert_my_mode, as
-- that recipient, under RLS): a member removed in between gets nothing.

-- ---------------------------------------------------------------------------
-- alert_rule
-- ---------------------------------------------------------------------------
CREATE TABLE alert_rule (
	id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	kind       text NOT NULL CHECK (kind IN ('dam_below', 'ewr_forecast_fail', 'data_stale', 'restriction_published', 'job_dead', 'feed_failing')),
	-- The farm a dam_below rule watches; NULL for every other kind.
	node_id    uuid REFERENCES node(id) ON DELETE CASCADE,
	-- dam_below: a fraction of the dam's capacity (0.3 = 30 %); the others a
	-- whole number of days (EWR days at risk, days without data), failures in
	-- a row, or dead jobs; restriction_published has none (0).
	threshold  double precision NOT NULL,
	enabled    boolean NOT NULL DEFAULT true,
	created_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CHECK ((kind = 'dam_below') = (node_id IS NOT NULL)),
	CHECK (CASE kind
		WHEN 'dam_below' THEN threshold > 0 AND threshold < 1
		WHEN 'ewr_forecast_fail' THEN threshold BETWEEN 1 AND 60 AND threshold = trunc(threshold)
		WHEN 'data_stale' THEN threshold BETWEEN 1 AND 60 AND threshold = trunc(threshold)
		WHEN 'feed_failing' THEN threshold BETWEEN 1 AND 20 AND threshold = trunc(threshold)
		WHEN 'job_dead' THEN threshold BETWEEN 1 AND 100 AND threshold = trunc(threshold)
		ELSE threshold = 0
	END)
);
-- One rule per kind (and farm) per project; also covers project_id.
CREATE UNIQUE INDEX alert_rule_key_idx ON alert_rule (project_id, kind, node_id) NULLS NOT DISTINCT;
CREATE INDEX alert_rule_node_idx ON alert_rule (node_id);
CREATE INDEX alert_rule_created_by_idx ON alert_rule (created_by);
CREATE TRIGGER alert_rule_same_project BEFORE INSERT OR UPDATE ON alert_rule
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('node_id');

COMMENT ON TABLE alert_rule IS
	'What to alert on, per project (051_alerts, WP-2.13). Viewers read, a farmer the rules on their farms, editors write.';

-- A dam_below rule watches a farm. SECURITY DEFINER so the check sees the
-- node past RLS (the caller is an editor, who sees it anyway). Stamps
-- updated_at, and keeps the creator on an update.
CREATE FUNCTION alert_rule_check() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NEW.node_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM node WHERE id = NEW.node_id AND kind = 'farm') THEN
			RAISE EXCEPTION 'node % is not a farm', NEW.node_id USING ERRCODE = 'check_violation';
		END IF;
		NEW.updated_at := now();
		IF TG_OP = 'INSERT' THEN
			NEW.created_by := app_current_user_id();
			NEW.created_at := now();
		ELSE
			NEW.created_by := OLD.created_by;
			NEW.created_at := OLD.created_at;
			IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.node_id IS DISTINCT FROM OLD.node_id OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
				RAISE EXCEPTION 'a rule''s kind and farm never change' USING ERRCODE = 'check_violation';
			END IF;
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER alert_rule_check BEFORE INSERT OR UPDATE ON alert_rule
	FOR EACH ROW EXECUTE FUNCTION alert_rule_check();

-- ---------------------------------------------------------------------------
-- alert_event
-- ---------------------------------------------------------------------------
CREATE TABLE alert_event (
	id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	rule_id    uuid NOT NULL REFERENCES alert_rule(id) ON DELETE CASCADE,
	project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- Copied from the rule by alert_event_guard, for the policies.
	kind       text NOT NULL,
	node_id    uuid REFERENCES node(id) ON DELETE CASCADE,
	state      text NOT NULL DEFAULT 'firing' CHECK (state IN ('firing', 'cleared')),
	-- The watched value when it fired (dam fraction, days, count); NULL for a restriction notice.
	value      double precision,
	-- What the mail says, from the recipient's scope only: for dam_below that
	-- farm's own projection figures, never another farm's. Small.
	detail     jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 8192),
	-- The run the value came from, while it's kept.
	run_id     uuid REFERENCES model_run(id) ON DELETE SET NULL,
	opened_at  timestamptz NOT NULL DEFAULT now(),
	cleared_at timestamptz,
	CHECK ((state = 'cleared') = (cleared_at IS NOT NULL))
);
-- At most one firing event per rule: the hysteresis, in the schema.
CREATE UNIQUE INDEX alert_event_firing_idx ON alert_event (rule_id) WHERE state = 'firing';
CREATE INDEX alert_event_rule_idx ON alert_event (rule_id, opened_at DESC);
-- The portfolio's and the Overview's firing count per project; covers project_id.
CREATE INDEX alert_event_project_idx ON alert_event (project_id, state);
CREATE INDEX alert_event_node_idx ON alert_event (node_id);
CREATE INDEX alert_event_run_idx ON alert_event (run_id);
CREATE INDEX alert_event_cleared_idx ON alert_event (cleared_at) WHERE cleared_at IS NOT NULL;

COMMENT ON TABLE alert_event IS
	'Each time an alert rule fired (051_alerts, WP-2.13): firing until the value recovers past threshold + margin, then cleared. At most one firing event per rule.';

-- Insert: the kind, farm and project come from the rule, opened now. Update:
-- only state, cleared_at, value and detail change, and firing → cleared is
-- the only move (a cleared event never fires again: a new crossing is a new
-- event, so it gets its own mail).
CREATE FUNCTION alert_event_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		r alert_rule;
	BEGIN
		IF TG_OP = 'INSERT' THEN
			SELECT * INTO r FROM alert_rule WHERE id = NEW.rule_id;
			IF r.id IS NULL OR r.project_id IS DISTINCT FROM NEW.project_id THEN
				RAISE EXCEPTION 'rule % belongs to a different project', NEW.rule_id USING ERRCODE = 'foreign_key_violation';
			END IF;
			NEW.kind := r.kind;
			NEW.node_id := r.node_id;
			NEW.opened_at := now();
			NEW.cleared_at := CASE WHEN NEW.state = 'cleared' THEN now() END;
			RETURN NEW;
		END IF;
		IF NEW.rule_id IS DISTINCT FROM OLD.rule_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
			OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.node_id IS DISTINCT FROM OLD.node_id
			OR NEW.opened_at IS DISTINCT FROM OLD.opened_at OR NEW.run_id IS DISTINCT FROM OLD.run_id AND NEW.run_id IS NOT NULL THEN
			RAISE EXCEPTION 'only an alert event''s state, value and detail change' USING ERRCODE = 'check_violation';
		END IF;
		IF OLD.state = 'cleared' AND NEW.state = 'firing' THEN
			RAISE EXCEPTION 'a cleared alert event never fires again' USING ERRCODE = 'check_violation';
		END IF;
		IF OLD.state = 'firing' AND NEW.state = 'cleared' THEN
			NEW.cleared_at := now();
		ELSIF NEW.state = OLD.state THEN
			NEW.cleared_at := OLD.cleared_at;
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER alert_event_guard BEFORE INSERT OR UPDATE ON alert_event
	FOR EACH ROW EXECUTE FUNCTION alert_event_guard();

-- ---------------------------------------------------------------------------
-- alert_subscription
-- ---------------------------------------------------------------------------
CREATE TABLE alert_subscription (
	id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id           uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
	project_id        uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- 'all' is the project-wide switch a digest's one-click unsubscribe turns
	-- off (a digest covers several kinds): mode 'off' mutes every kind.
	kind              text NOT NULL CHECK (kind IN ('dam_below', 'ewr_forecast_fail', 'data_stale', 'restriction_published', 'job_dead', 'feed_failing', 'all')),
	-- A dam_below choice for one farm; NULL = every farm the person gets dam alerts for.
	node_id           uuid REFERENCES node(id) ON DELETE CASCADE,
	-- Room for WhatsApp / SMS later (roadmap WP-2.13); email only for now.
	channel           text NOT NULL DEFAULT 'email' CHECK (channel IN ('email')),
	mode              text NOT NULL CHECK (mode IN ('immediate', 'daily_digest', 'off')),
	-- The unsubscribe token is HMAC-SHA256(ALERTS_TOKEN_SECRET, nonce)
	-- (alerts/tokens.ts): the worker derives it for every mail, so links in
	-- old mails keep working, and only its SHA-256 is looked up. Neither the
	-- nonce alone (a database leak) nor the secret alone makes a token.
	-- Turning a subscription back on draws a new nonce, so an old link can't
	-- turn off what the person chose again. The hash is NULL until the worker
	-- (the only holder of the secret) first mails with this nonce: a row the
	-- preferences page wrote has no live token yet.
	unsubscribe_nonce bytea NOT NULL CHECK (octet_length(unsubscribe_nonce) = 32),
	unsubscribe_hash  bytea UNIQUE CHECK (unsubscribe_hash IS NULL OR octet_length(unsubscribe_hash) = 32),
	created_at        timestamptz NOT NULL DEFAULT now(),
	updated_at        timestamptz NOT NULL DEFAULT now(),
	CHECK (node_id IS NULL OR kind = 'dam_below'),
	CHECK (kind <> 'all' OR mode IN ('immediate', 'off'))
);
-- One choice per person, project, kind and farm; also covers user_id.
CREATE UNIQUE INDEX alert_subscription_key_idx ON alert_subscription (user_id, project_id, kind, node_id) NULLS NOT DISTINCT;
CREATE INDEX alert_subscription_project_idx ON alert_subscription (project_id);
CREATE INDEX alert_subscription_node_idx ON alert_subscription (node_id);
CREATE TRIGGER alert_subscription_same_project BEFORE INSERT OR UPDATE ON alert_subscription
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('node_id');

COMMENT ON TABLE alert_subscription IS
	'A person''s alert choice per project, kind and farm: immediate, daily_digest or off (051_alerts, WP-2.13). Own rows only.';
COMMENT ON COLUMN alert_subscription.unsubscribe_hash IS
	'SHA-256 of the one-click unsubscribe token HMAC(ALERTS_TOKEN_SECRET, unsubscribe_nonce). Looked up by POST /alerts/unsubscribe through app_alert_unsubscribe.';

CREATE FUNCTION alert_subscription_stamp() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		NEW.updated_at := now();
		IF TG_OP = 'UPDATE' AND (NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
			OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.node_id IS DISTINCT FROM OLD.node_id) THEN
			RAISE EXCEPTION 'a subscription''s person, project, kind and farm never change' USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER alert_subscription_stamp BEFORE INSERT OR UPDATE ON alert_subscription
	FOR EACH ROW EXECUTE FUNCTION alert_subscription_stamp();

-- ---------------------------------------------------------------------------
-- alert_delivery
-- ---------------------------------------------------------------------------
CREATE TABLE alert_delivery (
	event_id   uuid NOT NULL REFERENCES alert_event(id) ON DELETE CASCADE,
	user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
	project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- What the recipient had chosen at fan-out.
	mode       text NOT NULL CHECK (mode IN ('immediate', 'daily_digest')),
	-- pending (to send now) | digest (waiting for the 06:00 SAST digest: chosen,
	-- or over the daily cap) → sending (claimed, leased) → sent | skipped (the
	-- recipient lost access or turned the alert off since, or the kill switch
	-- was on) | failed (the transport kept failing, or the worker stopped
	-- mid-send: never re-sent, so a crash can't double-mail).
	status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'digest', 'sending', 'sent', 'skipped', 'failed')),
	-- How it went out: its own mail, or a line of a digest.
	via        text CHECK (via IN ('immediate', 'digest')),
	attempts   integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
	created_at timestamptz NOT NULL DEFAULT now(),
	claimed_at timestamptz,
	locked_until timestamptz,
	sent_at    timestamptz,
	reason     text CHECK (reason IS NULL OR char_length(reason) <= 200),
	PRIMARY KEY (event_id, user_id)
);
-- The daily cap counts a person's immediate mails since the last digest.
CREATE INDEX alert_delivery_user_idx ON alert_delivery (user_id, claimed_at);
CREATE INDEX alert_delivery_project_idx ON alert_delivery (project_id);
CREATE INDEX alert_delivery_open_idx ON alert_delivery (status, created_at) WHERE status IN ('pending', 'digest', 'sending');
CREATE INDEX alert_delivery_created_idx ON alert_delivery (created_at);

COMMENT ON TABLE alert_delivery IS
	'One alert mail (or digest line) per event and recipient, ever (051_alerts, WP-2.13). Own rows readable; written only by the SECURITY DEFINER fan-out / claim / finish / purge functions. Kept 180 days.';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE alert_rule ENABLE ROW LEVEL SECURITY;
CREATE POLICY alert_rule_select ON alert_rule FOR SELECT
	USING (
		app_has_role(project_id, 'viewer')
		OR node_id IN (SELECT app_farm_nodes(project_id))
		OR (kind = 'restriction_published' AND app_has_role(project_id, 'farmer') AND NOT app_is_contributor(project_id))
	);
CREATE POLICY alert_rule_insert ON alert_rule FOR INSERT WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY alert_rule_update ON alert_rule FOR UPDATE
	USING (app_has_role(project_id, 'editor')) WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY alert_rule_delete ON alert_rule FOR DELETE USING (app_has_role(project_id, 'editor'));

ALTER TABLE alert_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY alert_event_select ON alert_event FOR SELECT
	USING (
		app_has_role(project_id, 'viewer')
		OR node_id IN (SELECT app_farm_nodes(project_id))
		OR (kind = 'restriction_published' AND app_has_role(project_id, 'farmer') AND NOT app_is_contributor(project_id))
	);
CREATE POLICY alert_event_insert ON alert_event FOR INSERT WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY alert_event_update ON alert_event FOR UPDATE
	USING (app_has_role(project_id, 'editor')) WITH CHECK (app_has_role(project_id, 'editor'));

ALTER TABLE alert_subscription ENABLE ROW LEVEL SECURITY;
CREATE POLICY alert_subscription_own ON alert_subscription FOR ALL
	USING (
		user_id = app_current_user_id() AND app_has_role(project_id, 'farmer') AND NOT app_is_contributor(project_id)
		AND (node_id IS NULL OR app_has_role(project_id, 'viewer') OR node_id IN (SELECT app_farm_nodes(project_id)))
	)
	WITH CHECK (
		user_id = app_current_user_id() AND app_has_role(project_id, 'farmer') AND NOT app_is_contributor(project_id)
		AND (node_id IS NULL OR app_has_role(project_id, 'viewer') OR node_id IN (SELECT app_farm_nodes(project_id)))
	);

ALTER TABLE alert_delivery ENABLE ROW LEVEL SECURITY;
-- Reading only: no INSERT, UPDATE or DELETE policy, so writes go through the
-- SECURITY DEFINER functions below.
CREATE POLICY alert_delivery_own ON alert_delivery FOR SELECT USING (user_id = app_current_user_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON alert_rule TO water_app;
-- An event is inserted, and only its state, value and detail change; it is
-- deleted only with its rule or project, or by app_purge_alerts.
GRANT SELECT, INSERT, DELETE ON alert_event TO water_app;
GRANT UPDATE (state, cleared_at, value, detail) ON alert_event TO water_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON alert_subscription TO water_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON alert_delivery TO water_app;

-- ---------------------------------------------------------------------------
-- Who gets an alert
-- ---------------------------------------------------------------------------

-- The audience of a kind (and farm) in a project, with each person's
-- effective mode: their farm-level choice, else their kind-level choice, else
-- the kind's default for their role (NULL = the role never gets this kind).
-- A project-wide 'all' = 'off' mutes everything. Contributors (applicants)
-- never get alerts; a farmer gets dam alerts only for farms linked to them,
-- and restriction notices, and nothing else.
--
--   kind                   default immediate          may opt in
--   dam_below              that farm's farmers,       viewers
--                          editors, owners
--   ewr_forecast_fail      editors, owners            viewers
--   data_stale             editors, owners            —
--   restriction_published  farmers, viewers and up    —
--   job_dead, feed_failing owners                     editors
--
-- Not SECURITY DEFINER and not granted to water_app: it runs only inside the
-- definer functions below (as the schema owner, so it sees every member).
CREATE FUNCTION alert_audience(p_project uuid, p_kind text, p_node uuid)
	RETURNS TABLE (user_id uuid, role project_role, mode text)
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
		), eligible AS (
			SELECT r.user_id, r.role,
				CASE
					WHEN r.role = 'contributor' THEN NULL
					WHEN p_kind = 'dam_below' THEN CASE
						WHEN r.role = 'farmer' THEN CASE WHEN EXISTS (
							SELECT 1 FROM farm_link fl WHERE fl.project_id = p_project AND fl.node_id = p_node AND fl.user_id = r.user_id
						) THEN 'immediate' END
						WHEN r.role >= 'editor' THEN 'immediate'
						ELSE 'off' END
					WHEN p_kind = 'ewr_forecast_fail' THEN CASE WHEN r.role >= 'editor' THEN 'immediate' WHEN r.role = 'viewer' THEN 'off' END
					WHEN p_kind = 'data_stale' THEN CASE WHEN r.role >= 'editor' THEN 'immediate' END
					WHEN p_kind = 'restriction_published' THEN 'immediate'
					WHEN p_kind IN ('job_dead', 'feed_failing') THEN CASE WHEN r.role = 'owner' THEN 'immediate' WHEN r.role = 'editor' THEN 'off' END
				END AS default_mode
			FROM roles r
		)
		SELECT e.user_id, e.role, COALESCE(sn.mode, sk.mode, e.default_mode)
		FROM eligible e
		LEFT JOIN alert_subscription sn ON p_node IS NOT NULL AND sn.user_id = e.user_id AND sn.project_id = p_project
			AND sn.kind = p_kind AND sn.node_id = p_node
		LEFT JOIN alert_subscription sk ON sk.user_id = e.user_id AND sk.project_id = p_project AND sk.kind = p_kind AND sk.node_id IS NULL
		WHERE e.default_mode IS NOT NULL
		  AND NOT EXISTS (
			SELECT 1 FROM alert_subscription sa
			WHERE sa.user_id = e.user_id AND sa.project_id = p_project AND sa.kind = 'all' AND sa.mode = 'off'
		  )
	$$;
REVOKE ALL ON FUNCTION alert_audience(uuid, text, uuid) FROM PUBLIC, water_app;

-- Who gets an alert of this kind (and farm) now: verified addresses whose
-- effective mode isn't off, with what their mail needs (address, language,
-- volume unit, role). Callable by an editor of the project (the alert_eval
-- job's acting user, at fan-out), or with no user and no API key at all (the
-- worker's own context); anyone else gets no rows.
CREATE FUNCTION app_alert_recipients(p_project uuid, p_kind text, p_node uuid)
	RETURNS TABLE (user_id uuid, email text, locale text, volume_unit text, role text, mode text)
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT a.user_id, u.email::text, u.locale, u.volume_unit, a.role::text, a.mode
		FROM alert_audience(p_project, p_kind, p_node) a
		JOIN app_user u ON u.id = a.user_id
		WHERE a.mode <> 'off' AND u.email_verified_at IS NOT NULL
		  AND (app_has_role(p_project, 'editor') OR (app_current_user_id() IS NULL AND app_current_api_key_id() IS NULL))
	$$;

-- The signed-in person's own effective mode for a kind (and farm), or NULL
-- when they don't get it at all (lost access, a role that never does, or a
-- farm that isn't theirs). The worker asks as the recipient, right before it
-- builds their mail, and also the preferences page.
CREATE FUNCTION app_alert_my_mode(p_project uuid, p_kind text, p_node uuid) RETURNS text
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT a.mode FROM alert_audience(p_project, p_kind, p_node) a
		WHERE a.user_id = app_current_user_id() AND app_current_user_id() IS NOT NULL
	$$;

-- ---------------------------------------------------------------------------
-- Fan-out, sending, digest (the worker)
-- ---------------------------------------------------------------------------

-- An event just opened: one delivery per recipient (app_alert_recipients),
-- 'pending' for immediate, 'digest' for daily digest. Only an editor of the
-- project, and only for an event opened within the hour (the job opens and
-- fans out in one transaction), so an old event can't be mailed out again.
-- Returns how many deliveries it made.
CREATE FUNCTION app_alert_fan_out(p_event uuid) RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		e alert_event;
		n integer;
	BEGIN
		SELECT * INTO e FROM alert_event WHERE id = p_event;
		IF e.id IS NULL OR NOT app_has_role(e.project_id, 'editor') THEN
			RAISE EXCEPTION 'only an editor of the project can send its alerts' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF e.opened_at < now() - interval '1 hour' THEN
			RAISE EXCEPTION 'an alert is sent only when it opens' USING ERRCODE = 'check_violation';
		END IF;
		INSERT INTO alert_delivery (event_id, user_id, project_id, mode, status)
			SELECT e.id, r.user_id, e.project_id, r.mode, CASE r.mode WHEN 'immediate' THEN 'pending' ELSE 'digest' END
			FROM app_alert_recipients(e.project_id, e.kind, e.node_id) r
			ON CONFLICT (event_id, user_id) DO NOTHING;
		GET DIAGNOSTICS n = ROW_COUNT;
		RETURN n;
	END
	$$;

-- True in the worker's own context: no signed-in user, no API key.
CREATE FUNCTION alert_worker_context() RETURNS boolean
	LANGUAGE sql STABLE SET search_path = public
	AS $$ SELECT app_current_user_id() IS NULL AND app_current_api_key_id() IS NULL $$;
REVOKE ALL ON FUNCTION alert_worker_context() FROM PUBLIC, water_app;

-- Claim up to p_limit pending deliveries to send now, applying the daily cap:
-- a person who has had p_cap immediate alert mails since p_since (the last
-- 06:00 SAST, alerts/digest.ts) gets the rest in the next digest instead. One
-- person at a time under an advisory lock, so two workers can't both send
-- the fifth mail. A delivery left 'sending' past its lease (the worker died
-- mid-send) is marked failed, never re-sent: a crash can't double-mail.
CREATE FUNCTION app_alert_claim(p_limit integer, p_since timestamptz, p_cap integer, p_lease interval)
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
		IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 OR p_cap IS NULL OR p_cap < 0 OR p_since IS NULL
			OR p_lease IS NULL OR p_lease < interval '10 seconds' OR p_lease > interval '1 hour' THEN
			RAISE EXCEPTION 'claim 1–500 deliveries, a cap ≥ 0 and a lease of 10 s to 1 h' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		UPDATE alert_delivery a SET status = 'failed', locked_until = NULL, reason = 'the worker stopped while sending'
		WHERE a.status = 'sending' AND a.locked_until < now();
		FOR d IN
			SELECT a.event_id, a.user_id FROM alert_delivery a
			WHERE a.status = 'pending'
			ORDER BY a.created_at, a.event_id
			LIMIT p_limit
			FOR UPDATE SKIP LOCKED
		LOOP
			PERFORM pg_advisory_xact_lock(hashtextextended('alert_cap:' || d.user_id::text, 0));
			SELECT count(*) INTO sent FROM alert_delivery a
			WHERE a.user_id = d.user_id AND a.via = 'immediate' AND a.status IN ('sending', 'sent') AND a.claimed_at >= p_since;
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

-- Claim the digest lines queued before p_before (the latest 06:00 SAST) for
-- up to p_people people at once, marked sending: each person's newest
-- p_lines at most. Their older lines beyond that are marked skipped ("over
-- the digest limit"), so a flapping rule or a day of many crossings can
-- neither build an unbounded email nor pile up for the next digest. The
-- email itself shows fewer still (alerts/send.ts DIGEST_MAX_LINES, then
-- "and N more").
CREATE FUNCTION app_alert_claim_digest(p_before timestamptz, p_people integer, p_lines integer, p_lease interval)
	RETURNS TABLE (event_id uuid, user_id uuid, project_id uuid, kind text, node_id uuid)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	DECLARE
		v_people uuid[];
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker sends alerts' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_before IS NULL OR p_people IS NULL OR p_people < 1 OR p_people > 500 OR p_lines IS NULL OR p_lines < 1 OR p_lines > 1000
			OR p_lease IS NULL OR p_lease < interval '10 seconds' OR p_lease > interval '1 hour' THEN
			RAISE EXCEPTION 'claim digests for 1–500 people, 1–1000 lines each, with a lease of 10 s to 1 h' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		SELECT array_agg(x.user_id) INTO v_people FROM (
			SELECT DISTINCT a.user_id FROM alert_delivery a
			WHERE a.status = 'digest' AND a.created_at < p_before
			LIMIT p_people
		) x;
		IF v_people IS NULL THEN
			RETURN;
		END IF;
		-- Lines past each person's newest p_lines: handled, never sent.
		UPDATE alert_delivery a SET status = 'skipped', via = 'digest', locked_until = NULL, reason = 'over the digest limit'
		FROM (
			SELECT d.event_id, d.user_id, row_number() OVER (PARTITION BY d.user_id ORDER BY d.created_at DESC, d.event_id) AS rn
			FROM alert_delivery d
			WHERE d.status = 'digest' AND d.created_at < p_before AND d.user_id = ANY (v_people)
		) r
		WHERE a.event_id = r.event_id AND a.user_id = r.user_id AND r.rn > p_lines AND a.status = 'digest';
		RETURN QUERY
		WITH due AS (
			SELECT a.event_id, a.user_id FROM alert_delivery a
			WHERE a.status = 'digest' AND a.created_at < p_before AND a.user_id = ANY (v_people)
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

-- Record a claimed delivery's outcome: sent, skipped (with why), failed, or
-- 'retry' (a transport error with attempts left: back to pending, or to
-- digest for a digest line).
CREATE FUNCTION app_alert_finish(p_event uuid, p_user uuid, p_status text, p_reason text DEFAULT NULL) RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker sends alerts' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_status IS NULL OR p_status NOT IN ('sent', 'skipped', 'failed', 'retry') THEN
			RAISE EXCEPTION 'unknown delivery outcome' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		UPDATE alert_delivery a SET
			status = CASE
				WHEN p_status <> 'retry' THEN p_status
				WHEN a.attempts >= 3 THEN 'failed'
				WHEN a.via = 'digest' THEN 'digest'
				ELSE 'pending' END,
			-- A retried immediate mail doesn't count against the cap until it's claimed again.
			via = CASE WHEN p_status = 'retry' AND a.attempts < 3 AND a.via = 'immediate' THEN NULL ELSE a.via END,
			sent_at = CASE WHEN p_status = 'sent' THEN now() END,
			locked_until = NULL,
			reason = left(p_reason, 200)
		WHERE a.event_id = p_event AND a.user_id = p_user AND a.status = 'sending';
		RETURN FOUND;
	END
	$$;

-- The kill switch (ALERTS_ENABLED=false): every delivery waiting to go out is
-- skipped, so nothing floods out when the switch is turned back on. Returns
-- how many.
CREATE FUNCTION app_alert_skip_all(p_reason text) RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		n integer;
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker sends alerts' USING ERRCODE = 'insufficient_privilege';
		END IF;
		UPDATE alert_delivery SET status = 'skipped', locked_until = NULL, reason = left(coalesce(p_reason, 'skipped'), 200)
		WHERE status IN ('pending', 'digest');
		GET DIAGNOSTICS n = ROW_COUNT;
		RETURN n;
	END
	$$;

-- Deliveries older than p_age, and events cleared longer ago than that (with
-- their deliveries), go. At least 30 days; the tick passes 180.
CREATE FUNCTION app_purge_alerts(p_age interval) RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		n integer;
		m integer;
	BEGIN
		IF p_age IS NULL OR p_age < interval '30 days' THEN
			RAISE EXCEPTION 'purge only alerts at least 30 days old' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		DELETE FROM alert_delivery WHERE created_at < now() - p_age AND status NOT IN ('pending', 'digest', 'sending');
		GET DIAGNOSTICS n = ROW_COUNT;
		DELETE FROM alert_event WHERE state = 'cleared' AND cleared_at < now() - p_age;
		GET DIAGNOSTICS m = ROW_COUNT;
		RETURN n + m;
	END
	$$;

-- A person's current role on a project (the audience's rule), or NULL.
CREATE FUNCTION alert_user_role(p_project uuid, p_user uuid) RETURNS project_role
	LANGUAGE sql STABLE SET search_path = public
	AS $$
		SELECT max(r) FROM (
			SELECT m.role AS r FROM project_member m WHERE m.project_id = p_project AND m.user_id = p_user
			UNION ALL
			SELECT CASE tm.role::text WHEN 'admin' THEN 'owner'::project_role WHEN 'member' THEN 'editor'::project_role WHEN 'viewer' THEN 'viewer'::project_role END
			FROM project p JOIN team_member tm ON tm.team_id = p.team_id
			WHERE p.id = p_project AND tm.user_id = p_user
		) x
	$$;
REVOKE ALL ON FUNCTION alert_user_role(uuid, uuid) FROM PUBLIC, water_app;

-- ---------------------------------------------------------------------------
-- Unsubscribe (no session: the token is the credential)
-- ---------------------------------------------------------------------------

-- Turn off the one subscription whose token hashes to p_hash (never NULL: a
-- row with no hash has no live token), and say what it
-- was (for the landing page). Nothing when no subscription has that hash (a
-- tampered token, or one a re-subscribe replaced) or its person can no longer
-- open the project or that farm (a removed member's link expired with their
-- access). It only ever turns a subscription off; a repeat is harmless (a
-- mail client may send the one-click POST twice).
CREATE FUNCTION app_alert_unsubscribe(p_hash bytea)
	RETURNS TABLE (kind text, project_name text, node_name text)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	DECLARE
		s alert_subscription;
		v_role project_role;
	BEGIN
		IF p_hash IS NULL THEN
			RETURN;
		END IF;
		SELECT * INTO s FROM alert_subscription a WHERE a.unsubscribe_hash = p_hash;
		IF s.id IS NULL THEN
			RETURN;
		END IF;
		v_role := alert_user_role(s.project_id, s.user_id);
		IF v_role IS NULL OR v_role = 'contributor' OR (v_role = 'farmer' AND s.node_id IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM farm_link fl WHERE fl.node_id = s.node_id AND fl.user_id = s.user_id
		)) THEN
			RETURN;
		END IF;
		UPDATE alert_subscription a SET mode = 'off' WHERE a.id = s.id;
		RETURN QUERY
			SELECT s.kind, p.name::text, n.name::text
			FROM project p LEFT JOIN node n ON n.id = s.node_id
			WHERE p.id = s.project_id;
	END
	$$;

-- ---------------------------------------------------------------------------
-- Scheduled evaluation (the tick): data going stale, failing feeds and dead
-- jobs aren't caused by a run, so the tick queues an alert_eval for them.
-- ---------------------------------------------------------------------------


-- Queue an alert_eval (dedupe key 'alert_eval') for p_project, or, with
-- p_project NULL, for up to p_limit projects with an enabled data_stale,
-- feed_failing or job_dead rule and no alert_eval queued, or made in the last
-- p_gap. (Alerts are opt-in per project: a project with no enabled rule is
-- never checked.) It runs as an editor, the first of these who is an editor
-- or owner now: whoever made one of those rules, a data feed's acting user,
-- the longest-standing owner. A project with none is skipped. The worker's
-- context only (no user, no key). Returns how many it queued.
CREATE FUNCTION app_alert_schedule(p_project uuid, p_gap interval, p_limit integer) RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		n integer;
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker schedules alert checks' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_gap IS NULL OR p_gap < interval '0' OR p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
			RAISE EXCEPTION 'a gap ≥ 0 and 1–1000 projects' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		WITH due AS (
			SELECT p.id FROM project p
			WHERE (p_project IS NULL OR p.id = p_project)
			  AND EXISTS (SELECT 1 FROM alert_rule r WHERE r.project_id = p.id AND r.enabled
				AND (p_project IS NOT NULL OR r.kind IN ('data_stale', 'feed_failing', 'job_dead')))
			  AND NOT EXISTS (
				SELECT 1 FROM job j WHERE j.project_id = p.id AND j.kind = 'alert_eval'
				  AND (j.status IN ('queued', 'failed') OR j.created_at > now() - p_gap))
			ORDER BY p.id
			LIMIT p_limit
		), actor AS (
			SELECT d.id AS project_id, (
				SELECT c.uid FROM (
					SELECT r.created_by AS uid, 1 AS o, r.created_at AS at FROM alert_rule r
					WHERE r.project_id = d.id AND r.enabled AND r.created_by IS NOT NULL
					UNION ALL
					SELECT f.acting_user_id, 2, f.created_at FROM data_feed f WHERE f.project_id = d.id AND f.acting_user_id IS NOT NULL
					UNION ALL
					SELECT m.user_id, 3, m.added_at FROM project_member m WHERE m.project_id = d.id AND m.role = 'owner'
				) c
				WHERE alert_user_role(d.id, c.uid) >= 'editor'
				ORDER BY c.o, c.at
				LIMIT 1
			) AS uid
			FROM due d
		)
		INSERT INTO job (project_id, kind, payload, dedupe_key, acting_user_id)
			SELECT a.project_id, 'alert_eval', jsonb_build_object('cause', 'schedule'), 'alert_eval', a.uid
			FROM actor a WHERE a.uid IS NOT NULL
			ON CONFLICT (project_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'failed') DO NOTHING;
		GET DIAGNOSTICS n = ROW_COUNT;
		RETURN n;
	END
	$$;

REVOKE ALL ON FUNCTION app_alert_recipients(uuid, text, uuid), app_alert_my_mode(uuid, text, uuid), app_alert_fan_out(uuid),
	app_alert_claim(integer, timestamptz, integer, interval), app_alert_claim_digest(timestamptz, integer, integer, interval),
	app_alert_finish(uuid, uuid, text, text), app_alert_skip_all(text), app_purge_alerts(interval),
	app_alert_unsubscribe(bytea), app_alert_schedule(uuid, interval, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_alert_recipients(uuid, text, uuid), app_alert_my_mode(uuid, text, uuid), app_alert_fan_out(uuid),
	app_alert_claim(integer, timestamptz, integer, interval), app_alert_claim_digest(timestamptz, integer, integer, interval),
	app_alert_finish(uuid, uuid, text, text), app_alert_skip_all(text), app_purge_alerts(interval),
	app_alert_unsubscribe(bytea), app_alert_schedule(uuid, interval, integer) TO water_app;
