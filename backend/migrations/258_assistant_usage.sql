-- 258_assistant_usage — what the assistant costs, counted (issue #610;
-- docs/architecture.md § Assistant, docs/security.md § Assistant).
--
-- The assistant (assistant/routes.ts) calls a hosted model for each turn of a
-- chat, and every token is money. Two counters, both checked before a turn
-- and written only through the SECURITY DEFINER functions below:
--
--   - assistant_usage: tokens (input and output) and messages per project,
--     per person and per calendar month (UTC). A project's budget is the sum
--     of its month's rows (ASSISTANT_TOKENS_PER_MONTH, assistant/config.ts).
--     A turn is checked against it before it starts and charged after it
--     ends, so the budget can be passed by at most one turn's tokens for each turn
--     in flight at once (the assistant Lambda's reserved concurrency bounds those)
--     (bounded by the hop and output caps). Nothing else is kept: no
--     transcript, no prompt, no answer.
--   - assistant_rate: messages per person in a fixed one-hour window, across
--     projects (ASSISTANT_MESSAGES_PER_HOUR), the 186_map_compute_throttle
--     pattern: 429 with Retry-After past it.
--
-- app_assistant_begin serialises one project's turns on a transaction-level
-- advisory lock (never a lock on the project row, which every insert into a
-- project table key-shares) and then the person's rate row on a row lock, in
-- that order everywhere, so parallel turns are counted one by one and can't
-- deadlock. app_assistant_charge adds to the person's month row in one
-- upsert, so parallel charges are each counted once.
--
-- Personal data: a usage row names the person (user_id). On an account
-- deletion it stays with the name cleared (ON DELETE SET NULL), so the
-- project's month still counts what was spent; it is in the person's
-- "Download my data" (auth/export.ts assistantUsage), and members read only
-- their own rows. The rate row is a count for an hourly cap (ON DELETE
-- CASCADE, gone an hour on), not exported, as dem_attempt (184).

CREATE TABLE assistant_usage (
	id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id    uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
	-- NULL once the account is deleted: the spend stays counted, without the name.
	user_id       uuid REFERENCES app_user (id) ON DELETE SET NULL,
	-- The first day of the UTC month the tokens were spent in.
	month         date NOT NULL CHECK (month = date_trunc('month', month)::date),
	input_tokens  bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
	output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
	messages      integer NOT NULL DEFAULT 0 CHECK (messages >= 0),
	updated_at    timestamptz NOT NULL DEFAULT now(),
	-- One row per person per project per month (NULLs distinct: a deleted account's rows stay apart). Covers the project key.
	UNIQUE (project_id, month, user_id)
);
-- Covers the user key, and the export's read of a person's own rows.
CREATE INDEX assistant_usage_user_idx ON assistant_usage (user_id);
COMMENT ON TABLE assistant_usage IS
	'Assistant tokens and messages per project, person and UTC month (258). Written only by app_assistant_begin / app_assistant_charge; members read their own rows.';

ALTER TABLE assistant_usage ENABLE ROW LEVEL SECURITY;
-- A person reads their own rows (the export); the project total comes from app_assistant_used.
CREATE POLICY assistant_usage_own ON assistant_usage FOR SELECT USING (user_id = app_current_user_id());
GRANT SELECT ON assistant_usage TO water_app;

CREATE TABLE assistant_rate (
	user_id      uuid PRIMARY KEY REFERENCES app_user (id) ON DELETE CASCADE,
	window_start timestamptz NOT NULL DEFAULT now(),
	messages     integer NOT NULL DEFAULT 0 CHECK (messages >= 0)
);
-- Housekeeping deletes rows by age.
CREATE INDEX assistant_rate_window_idx ON assistant_rate (window_start);
COMMENT ON TABLE assistant_rate IS
	'Assistant messages per person in a one-hour window (258). Only app_assistant_begin touches it.';

-- As map_compute_throttle (186): the app touches it only through the function below.
ALTER TABLE assistant_rate ENABLE ROW LEVEL SECURITY;
CREATE POLICY assistant_rate_none ON assistant_rate USING (false) WITH CHECK (false);
GRANT SELECT, INSERT, UPDATE, DELETE ON assistant_rate TO water_app;

-- The project's tokens this UTC month, for a member (viewer and above); NULL for anyone else.
CREATE FUNCTION app_assistant_used(p_project uuid) RETURNS bigint
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF app_current_user_id() IS NULL OR p_project IS NULL OR NOT coalesce(app_has_role(p_project, 'viewer'), false) THEN
			RETURN NULL;
		END IF;
		RETURN (SELECT coalesce(sum(input_tokens + output_tokens), 0)::bigint FROM assistant_usage
			WHERE project_id = p_project AND month = date_trunc('month', now() AT TIME ZONE 'UTC')::date);
	END
	$$;
REVOKE ALL ON FUNCTION app_assistant_used(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_assistant_used(uuid) TO water_app;

-- Begin one turn by the signed-in user on project p_project, where they are
-- at least a viewer. outcome:
--   'ok'     counted: one message in the hour and on this month's row;
--   'rate'   the person has sent p_messages_per_hour messages this window;
--            wait_seconds until it ends (nothing counted);
--   'budget' the project's month has used p_tokens_per_month tokens;
--            wait_seconds until the month ends (nothing counted).
-- tokens_used is the project's month so far. Anyone else, or no user, is
-- refused with an error: the route has checked the role already, so this only
-- stops a caller from using up another project's budget.
CREATE FUNCTION app_assistant_begin(p_project uuid, p_tokens_per_month bigint, p_messages_per_hour integer)
	RETURNS TABLE (outcome text, wait_seconds integer, tokens_used bigint)
	LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_user uuid := app_current_user_id();
		v_month date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
		v_used bigint;
		v_rate assistant_rate;
	BEGIN
		IF v_user IS NULL OR p_project IS NULL OR p_tokens_per_month IS NULL OR p_tokens_per_month < 1
			OR p_messages_per_hour IS NULL OR p_messages_per_hour < 1
			OR NOT coalesce(app_has_role(p_project, 'viewer'), false) THEN
			RAISE EXCEPTION 'app_assistant_begin: not allowed' USING ERRCODE = '42501';
		END IF;
		-- The project's turns one at a time, then the person's row: always in this order.
		PERFORM pg_advisory_xact_lock(hashtext('assistant_usage:' || p_project::text));
		-- The end of the person's window: their row goes. Only their own, so two
		-- begins never lock each other's rows (no deadlock); a row left by
		-- someone who stopped asking is a few bytes and goes on their next turn.
		DELETE FROM assistant_rate WHERE user_id = v_user AND window_start <= now() - interval '1 hour';
		INSERT INTO assistant_rate (user_id) VALUES (v_user) ON CONFLICT (user_id) DO NOTHING;
		SELECT * INTO v_rate FROM assistant_rate WHERE user_id = v_user FOR UPDATE;
		SELECT coalesce(sum(u.input_tokens + u.output_tokens), 0)::bigint INTO v_used FROM assistant_usage u
			WHERE u.project_id = p_project AND u.month = v_month;
		IF v_rate.messages + 1 > p_messages_per_hour THEN
			RETURN QUERY SELECT 'rate'::text,
				greatest(1, ceil(extract(epoch FROM v_rate.window_start + interval '1 hour' - now())))::integer, v_used;
			RETURN;
		END IF;
		IF v_used >= p_tokens_per_month THEN
			RETURN QUERY SELECT 'budget'::text,
				greatest(1, ceil(extract(epoch FROM ((v_month + interval '1 month')::timestamp AT TIME ZONE 'UTC') - now())))::integer, v_used;
			RETURN;
		END IF;
		UPDATE assistant_rate SET messages = messages + 1 WHERE user_id = v_user;
		INSERT INTO assistant_usage (project_id, user_id, month, messages) VALUES (p_project, v_user, v_month, 1)
			ON CONFLICT (project_id, month, user_id) DO UPDATE SET messages = assistant_usage.messages + 1, updated_at = now();
		RETURN QUERY SELECT 'ok'::text, 0, v_used;
	END
	$$;
REVOKE ALL ON FUNCTION app_assistant_begin(uuid, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_assistant_begin(uuid, bigint, integer) TO water_app;

-- Charge the tokens one turn used to the signed-in user's row for this UTC
-- month on p_project (a viewer and above). Returns the project's month total
-- after it. One upsert, so parallel charges are each counted once.
CREATE FUNCTION app_assistant_charge(p_project uuid, p_input bigint, p_output bigint) RETURNS bigint
	LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_user uuid := app_current_user_id();
		v_month date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
	BEGIN
		IF v_user IS NULL OR p_project IS NULL OR p_input IS NULL OR p_input < 0 OR p_output IS NULL OR p_output < 0
			OR NOT coalesce(app_has_role(p_project, 'viewer'), false) THEN
			RAISE EXCEPTION 'app_assistant_charge: not allowed' USING ERRCODE = '42501';
		END IF;
		INSERT INTO assistant_usage (project_id, user_id, month, input_tokens, output_tokens) VALUES (p_project, v_user, v_month, p_input, p_output)
			ON CONFLICT (project_id, month, user_id) DO UPDATE
			SET input_tokens = assistant_usage.input_tokens + EXCLUDED.input_tokens,
				output_tokens = assistant_usage.output_tokens + EXCLUDED.output_tokens,
				updated_at = now();
		RETURN (SELECT coalesce(sum(input_tokens + output_tokens), 0)::bigint FROM assistant_usage
			WHERE project_id = p_project AND month = v_month);
	END
	$$;
REVOKE ALL ON FUNCTION app_assistant_charge(uuid, bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_assistant_charge(uuid, bigint, bigint) TO water_app;
