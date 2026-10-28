-- 264_assistant_reservation — a turn reserves its budget before it starts,
-- so nobody passes an assistant cap (issues #640, #641; docs/architecture.md
-- § Assistant, docs/security.md § Assistant). Starts from 262's definitions.
--
-- Before: app_assistant_begin (262) refused a turn only once a month was
-- already spent (used >= cap), and app_assistant_charge added the real tokens
-- after the turn. A turn's own ceiling was the fixed ASSISTANT_MAX_TURN_TOKENS,
-- not what was left, so a person one token under a cap could start a turn
-- that spent up to that ceiling more, and each turn in flight at once passed
-- begin before any was charged: the person's, the project's and the
-- deployment's caps could all be overshot, by a ceiling per turn in flight.
--
-- Now: begin reserves the turn's budget, the least of
--   p_max_turn_tokens (ASSISTANT_MAX_TURN_TOKENS),
--   the deployment's cap − its month's spend − every reservation of the month,
--   the person's cap − their spend − their reservations,
--   the project's cap − its spend − its reservations,
-- and refuses (the 262 outcomes) when that is below p_min_turn_tokens, what
-- the turn's first model call needs at most (orchestrator.ts turnFloor: the
-- conservative estimate of its input, plus a whole call's output weighted ×5).
-- The reservation is a row of assistant_reservation that counts as spent for
-- every later begin, and for the status (app_assistant_used). The turn keeps
-- its spend within that budget (orchestrator.ts), and app_assistant_charge
-- replaces the reservation with what was really spent in one transaction.
-- So the month's spend plus every reservation never passes any cap, however
-- many turns run at once.
--
-- Leaks: a reservation expires p_reservation_seconds after begin (the route
-- passes the turn's deadline plus a margin past the assistant Lambda's
-- timeout, usage.ts RESERVATION_MARGIN_SECONDS). One that expires unsettled
-- (its Lambda was killed before it could charge) is charged in full, as
-- input tokens: Bedrock may have billed every token of it, and charging less
-- could let the month pass its cap. begin converts every expired reservation
-- under the deployment's lock before it sums, and the tick's
-- app_purge_assistant does the same. A charge that arrives after its
-- reservation was converted (it can't on Lambda, whose timeout is before the
-- expiry) adds its tokens again: counted twice, never too little.
--
-- Concurrency: begin keeps 262's locks (the deployment's advisory lock, the
-- project's, then the person's rate row), so begins are counted one by one.
-- The month's spend and reservations are summed in one statement
-- (assistant_month_spent), so a charge committing at the same time (which
-- moves tokens from the reservation to the usage row in one transaction) is
-- seen wholly before or wholly after, never in neither place.
--
-- One turn per person at a time is not enforced: reservations make parallel
-- turns safe (the second's budget is what the first left), so it would only
-- refuse work the caps allow.
--
-- Personal data: a reservation names the person (user_id) for the minutes a
-- turn runs; it is deleted when the turn is charged, or converted into the
-- usage row when it expires. An account deletion clears the name
-- (ON DELETE SET NULL), so the tokens still count against the project and the
-- deployment until it settles. Nobody reads the table: it is owner-only (RLS
-- on, no policy, no grant); the definer functions below are its only path.
--
-- The functions' signatures change, so the old ones are dropped: the backend
-- of this release calls only the new ones (the assistant is off in
-- production, ASSISTANT_PROVIDER=off, when this lands).

CREATE TABLE assistant_reservation (
	id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
	-- NULL once the account is deleted: the tokens still count until it settles.
	user_id    uuid REFERENCES app_user (id) ON DELETE SET NULL,
	-- The first day of the UTC month the turn began in: the month it counts against, and is charged to.
	month      date NOT NULL CHECK (month = date_trunc('month', month)::date),
	-- Weighted tokens (input + 5 × output) the turn may spend: its budget.
	reserved   bigint NOT NULL CHECK (reserved > 0),
	created_at timestamptz NOT NULL DEFAULT now(),
	expires_at timestamptz NOT NULL,
	CHECK (expires_at > created_at)
);
-- Covers the project key, and the month's sum per project.
CREATE INDEX assistant_reservation_project_idx ON assistant_reservation (project_id);
-- Covers the user key.
CREATE INDEX assistant_reservation_user_idx ON assistant_reservation (user_id);
-- The month's sums, and the expiry sweep.
CREATE INDEX assistant_reservation_month_idx ON assistant_reservation (month);
CREATE INDEX assistant_reservation_expires_idx ON assistant_reservation (expires_at);
COMMENT ON TABLE assistant_reservation IS
	'A turn''s reserved assistant budget while it runs (264). Written only by app_assistant_begin, settled by app_assistant_charge, converted into assistant_usage in full once expired (app_assistant_begin, app_purge_assistant). Owner-only: no policy, no grant.';

-- Owner-only (as erasure_log): RLS on, no policy, no privilege for water_app.
ALTER TABLE assistant_reservation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON assistant_reservation FROM water_app;

-- This UTC month's weighted tokens, spent (assistant_usage) and reserved
-- (assistant_reservation, expired ones included: they will be charged in
-- full), for the project p_project, the person p_user and the deployment, in
-- one statement so a charge moving tokens from one table to the other is seen
-- once. Internal: runs as its caller, so only the definer functions below
-- (which run as the owner) can read both tables through it.
CREATE FUNCTION assistant_month_spent(p_month date, p_project uuid, p_user uuid)
	RETURNS TABLE (project_used bigint, user_used bigint, total_used bigint)
	LANGUAGE sql STABLE SET search_path = public
	AS $$
		SELECT
			coalesce(sum(s.w) FILTER (WHERE s.project_id = p_project), 0)::bigint,
			coalesce(sum(s.w) FILTER (WHERE s.user_id = p_user), 0)::bigint,
			coalesce(sum(s.w), 0)::bigint
		FROM (
			SELECT u.project_id, u.user_id, assistant_weighted(u.input_tokens, u.output_tokens) AS w FROM assistant_usage u WHERE u.month = p_month
			UNION ALL
			SELECT r.project_id, r.user_id, r.reserved FROM assistant_reservation r WHERE r.month = p_month
		) s
	$$;
REVOKE ALL ON FUNCTION assistant_month_spent(date, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION assistant_month_spent(date, uuid, uuid) FROM water_app;

-- Charge every expired reservation in full, as input tokens, to its person's
-- row for its month (a deleted account's to a row with no name), and delete
-- it. Returns how many it converted. Internal, as above.
CREATE FUNCTION assistant_settle_expired() RETURNS integer
	LANGUAGE plpgsql VOLATILE SET search_path = public
	AS $$
	DECLARE
		v_n integer;
	BEGIN
		WITH gone AS (
			DELETE FROM assistant_reservation WHERE expires_at <= now() RETURNING project_id, user_id, month, reserved
		), per_row AS (
			SELECT project_id, user_id, month, sum(reserved)::bigint AS reserved, count(*)::integer AS n FROM gone GROUP BY project_id, user_id, month
		), charged AS (
			-- Runs whether or not the query below reads it (a data-modifying WITH always runs to completion).
			INSERT INTO assistant_usage (project_id, user_id, month, input_tokens)
			SELECT project_id, user_id, month, reserved FROM per_row
			ON CONFLICT (project_id, month, user_id) DO UPDATE
				SET input_tokens = assistant_usage.input_tokens + EXCLUDED.input_tokens, updated_at = now()
		)
		SELECT coalesce(sum(n), 0)::integer INTO v_n FROM per_row;
		RETURN v_n;
	END
	$$;
REVOKE ALL ON FUNCTION assistant_settle_expired() FROM PUBLIC;
REVOKE ALL ON FUNCTION assistant_settle_expired() FROM water_app;

-- As 262, with every reservation of the month counted as spent: the status
-- (GET …/assistant) shows what is left for a new turn.
CREATE OR REPLACE FUNCTION app_assistant_used(p_project uuid) RETURNS TABLE (project_used bigint, user_used bigint, total_used bigint)
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_user uuid := app_current_user_id();
		v_month date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
	BEGIN
		IF v_user IS NULL OR p_project IS NULL OR NOT coalesce(app_has_role(p_project, 'viewer'), false) THEN
			RETURN QUERY SELECT NULL::bigint, NULL::bigint, NULL::bigint;
			RETURN;
		END IF;
		RETURN QUERY SELECT * FROM assistant_month_spent(v_month, p_project, v_user);
	END
	$$;

DROP FUNCTION app_assistant_begin(uuid, bigint, integer, bigint, bigint);

-- Begin one turn by the signed-in user on project p_project, where they are
-- at least a viewer, and reserve its budget. outcome:
--   'ok'           counted (one message in the hour and on this month's row)
--                  and reserved: reservation_id, and budget, the weighted
--                  tokens the turn may spend (at least p_min_turn_tokens, at
--                  most p_max_turn_tokens);
--   'rate'         the person has sent p_messages_per_hour messages this window;
--                  wait_seconds until it ends (nothing counted);
--   'total_budget' the deployment's month has less than p_min_turn_tokens left;
--   'user_budget'  the person's month has less than p_min_turn_tokens left;
--   'budget'       the project's month has less than p_min_turn_tokens left;
--                  each with wait_seconds until the month ends (nothing counted),
--                  checked in this order (the widest cap first).
-- "Left" is the cap less the month's spend and every reservation in it. The
-- *_used columns are those, before this turn's reservation. Anyone else, or
-- no user, is refused with an error, as 262.
CREATE FUNCTION app_assistant_begin(
	p_project uuid,
	p_tokens_per_month bigint,
	p_messages_per_hour integer,
	p_tokens_per_user_month bigint,
	p_tokens_total_per_month bigint,
	p_max_turn_tokens bigint,
	p_min_turn_tokens bigint,
	p_reservation_seconds integer
)
	RETURNS TABLE (outcome text, wait_seconds integer, project_used bigint, user_used bigint, total_used bigint, reservation_id uuid, budget bigint)
	LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_user uuid := app_current_user_id();
		v_month date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
		v_month_wait integer;
		v_project bigint;
		v_mine bigint;
		v_total bigint;
		v_budget bigint;
		v_id uuid;
		v_rate assistant_rate;
	BEGIN
		IF v_user IS NULL OR p_project IS NULL
			OR p_tokens_per_month IS NULL OR p_tokens_per_month < 1
			OR p_tokens_per_user_month IS NULL OR p_tokens_per_user_month < 1
			OR p_tokens_total_per_month IS NULL OR p_tokens_total_per_month < 1
			OR p_messages_per_hour IS NULL OR p_messages_per_hour < 1
			OR NOT coalesce(app_has_role(p_project, 'viewer'), false) THEN
			RAISE EXCEPTION 'app_assistant_begin: not allowed' USING ERRCODE = '42501';
		END IF;
		-- The route refuses a conversation whose first call alone needs more than a turn may take (413) first.
		IF p_max_turn_tokens IS NULL OR p_min_turn_tokens IS NULL OR p_min_turn_tokens < 1 OR p_max_turn_tokens < p_min_turn_tokens
			OR p_reservation_seconds IS NULL OR p_reservation_seconds < 1 OR p_reservation_seconds > 3600 THEN
			RAISE EXCEPTION 'app_assistant_begin: a turn needs 1 <= min <= max tokens and a reservation of 1 to 3600 seconds' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		-- Every turn's check one at a time (the deployment's cap spans projects), then the project's,
		-- then the person's row: always in this order, so no two begins wait on each other in a cycle.
		PERFORM pg_advisory_xact_lock(hashtext('assistant_usage:all'));
		PERFORM pg_advisory_xact_lock(hashtext('assistant_usage:' || p_project::text));
		-- A turn whose Lambda died never charged: its whole reservation is spent from here on.
		PERFORM assistant_settle_expired();
		-- The end of the person's window: their row goes (the tick purges the rest, app_purge_assistant).
		DELETE FROM assistant_rate WHERE user_id = v_user AND window_start <= now() - interval '1 hour';
		INSERT INTO assistant_rate (user_id) VALUES (v_user) ON CONFLICT (user_id) DO NOTHING;
		SELECT * INTO v_rate FROM assistant_rate WHERE user_id = v_user FOR UPDATE;
		SELECT s.project_used, s.user_used, s.total_used INTO v_project, v_mine, v_total
			FROM assistant_month_spent(v_month, p_project, v_user) s;
		IF v_rate.messages + 1 > p_messages_per_hour THEN
			RETURN QUERY SELECT 'rate'::text,
				greatest(1, ceil(extract(epoch FROM v_rate.window_start + interval '1 hour' - now())))::integer, v_project, v_mine, v_total, NULL::uuid, NULL::bigint;
			RETURN;
		END IF;
		v_month_wait := greatest(1, ceil(extract(epoch FROM ((v_month + interval '1 month')::timestamp AT TIME ZONE 'UTC') - now())))::integer;
		IF p_tokens_total_per_month - v_total < p_min_turn_tokens THEN
			RETURN QUERY SELECT 'total_budget'::text, v_month_wait, v_project, v_mine, v_total, NULL::uuid, NULL::bigint;
			RETURN;
		END IF;
		IF p_tokens_per_user_month - v_mine < p_min_turn_tokens THEN
			RETURN QUERY SELECT 'user_budget'::text, v_month_wait, v_project, v_mine, v_total, NULL::uuid, NULL::bigint;
			RETURN;
		END IF;
		IF p_tokens_per_month - v_project < p_min_turn_tokens THEN
			RETURN QUERY SELECT 'budget'::text, v_month_wait, v_project, v_mine, v_total, NULL::uuid, NULL::bigint;
			RETURN;
		END IF;
		v_budget := least(p_max_turn_tokens, p_tokens_total_per_month - v_total, p_tokens_per_user_month - v_mine, p_tokens_per_month - v_project);
		UPDATE assistant_rate SET messages = messages + 1 WHERE user_id = v_user;
		INSERT INTO assistant_usage (project_id, user_id, month, messages) VALUES (p_project, v_user, v_month, 1)
			ON CONFLICT (project_id, month, user_id) DO UPDATE SET messages = assistant_usage.messages + 1, updated_at = now();
		INSERT INTO assistant_reservation (project_id, user_id, month, reserved, expires_at)
			VALUES (p_project, v_user, v_month, v_budget, now() + make_interval(secs => p_reservation_seconds))
			RETURNING id INTO v_id;
		RETURN QUERY SELECT 'ok'::text, 0, v_project, v_mine, v_total, v_id, v_budget;
	END
	$$;
REVOKE ALL ON FUNCTION app_assistant_begin(uuid, bigint, integer, bigint, bigint, bigint, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_assistant_begin(uuid, bigint, integer, bigint, bigint, bigint, bigint, integer) TO water_app;

DROP FUNCTION app_assistant_charge(uuid, bigint, bigint);

-- Settle one turn: add the tokens it used to the signed-in user's row on
-- p_project and delete its reservation p_reservation, in one transaction.
--   - The reservation is found: it must be the caller's on p_project (else
--     refused, 42501: nobody settles another's turn); the tokens go to the
--     reservation's month, and no role is needed (a member removed during the
--     turn is still charged what it spent).
--   - It is gone (expired and converted in full): the tokens are added again,
--     this UTC month, so the spend is never counted short; a viewer and above.
--   - p_reservation is NULL: a charge with no reservation, this UTC month; a
--     viewer and above.
-- Returns this month's weighted tokens after it, as app_assistant_used.
CREATE FUNCTION app_assistant_charge(p_project uuid, p_reservation uuid, p_input bigint, p_output bigint)
	RETURNS TABLE (project_used bigint, user_used bigint, total_used bigint)
	LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_user uuid := app_current_user_id();
		v_now_month date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
		v_month date;
		v_res assistant_reservation;
	BEGIN
		IF v_user IS NULL OR p_project IS NULL OR p_input IS NULL OR p_input < 0 OR p_output IS NULL OR p_output < 0 THEN
			RAISE EXCEPTION 'app_assistant_charge: not allowed' USING ERRCODE = '42501';
		END IF;
		IF p_reservation IS NOT NULL THEN
			SELECT * INTO v_res FROM assistant_reservation WHERE id = p_reservation FOR UPDATE;
		END IF;
		IF v_res.id IS NOT NULL THEN
			IF v_res.user_id IS DISTINCT FROM v_user OR v_res.project_id <> p_project THEN
				RAISE EXCEPTION 'app_assistant_charge: not allowed' USING ERRCODE = '42501';
			END IF;
			v_month := v_res.month;
			DELETE FROM assistant_reservation WHERE id = v_res.id;
		ELSE
			IF NOT coalesce(app_has_role(p_project, 'viewer'), false) THEN
				RAISE EXCEPTION 'app_assistant_charge: not allowed' USING ERRCODE = '42501';
			END IF;
			v_month := v_now_month;
		END IF;
		INSERT INTO assistant_usage (project_id, user_id, month, input_tokens, output_tokens) VALUES (p_project, v_user, v_month, p_input, p_output)
			ON CONFLICT (project_id, month, user_id) DO UPDATE
			SET input_tokens = assistant_usage.input_tokens + EXCLUDED.input_tokens,
				output_tokens = assistant_usage.output_tokens + EXCLUDED.output_tokens,
				updated_at = now();
		RETURN QUERY SELECT * FROM assistant_month_spent(v_now_month, p_project, v_user);
	END
	$$;
REVOKE ALL ON FUNCTION app_assistant_charge(uuid, uuid, bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_assistant_charge(uuid, uuid, bigint, bigint) TO water_app;

-- As 262, and every expired reservation charged in full first (counted in the
-- rows returned), so none outlives its turn by more than a tick.
CREATE OR REPLACE FUNCTION app_purge_assistant(p_months integer) RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_rate integer;
		v_usage integer;
		v_reserved integer;
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker purges the assistant counters' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_months IS NULL OR p_months < 2 THEN
			RAISE EXCEPTION 'keep at least this month and the one before' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		-- Under the deployment's lock, as begin, so a begin's sum never runs beside the conversion.
		PERFORM pg_advisory_xact_lock(hashtext('assistant_usage:all'));
		v_reserved := assistant_settle_expired();
		DELETE FROM assistant_rate WHERE window_start <= now() - interval '1 hour';
		GET DIAGNOSTICS v_rate = ROW_COUNT;
		DELETE FROM assistant_usage
			WHERE month < (date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(months => p_months - 1))::date;
		GET DIAGNOSTICS v_usage = ROW_COUNT;
		RETURN v_rate + v_usage + v_reserved;
	END
	$$;
