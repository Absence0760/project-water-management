-- 262_assistant_usage — what the assistant costs, counted (issue #610;
-- docs/architecture.md § Assistant, docs/security.md § Assistant).
--
-- The assistant (assistant/routes.ts) calls a hosted model for each turn of a
-- chat, and every token is money. Tokens are counted weighted, input + 5 ×
-- output (assistant/config.ts OUTPUT_TOKEN_WEIGHT: Claude's output costs five
-- times its input on Bedrock), so every cap below is a cap in money at the
-- input price. Two counters, both checked before a turn and written only
-- through the SECURITY DEFINER functions below:
--
--   - assistant_usage: tokens (input and output, kept apart) and messages per
--     project, per person and per calendar month (UTC). Three monthly caps
--     read it, each the sum of the month's rows: the project's
--     (ASSISTANT_TOKENS_PER_MONTH), the person's across projects
--     (ASSISTANT_TOKENS_PER_USER_MONTH), and the deployment's in all
--     (ASSISTANT_TOKENS_PER_MONTH_TOTAL), which no number of projects or
--     accounts gets past. A turn is checked against all three before it
--     starts and charged after it ends, so a cap can be passed by at most one
--     turn's tokens for each turn in flight at once (the assistant Lambda's
--     reserved concurrency bounds those, and ASSISTANT_MAX_TURN_TOKENS each).
--     Nothing else is kept: no transcript, no prompt, no answer.
--   - assistant_rate: messages per person in a fixed one-hour window, across
--     projects (ASSISTANT_MESSAGES_PER_HOUR), the 186_map_compute_throttle
--     pattern: 429 with Retry-After past it.
--
-- app_assistant_begin serialises every turn's check on one transaction-level
-- advisory lock for the deployment, then the project's, then the person's
-- rate row on a row lock, in that order everywhere, so parallel turns are
-- counted one by one and can't deadlock (begins are a few short queries, and
-- at most the assistant's reserved concurrency run at once).
-- app_assistant_charge adds to the person's month row in one upsert, so
-- parallel charges are each counted once.
--
-- Retention (the job tick, jobs/runner.ts, app_purge_assistant): a rate row
-- goes once its hour is over; a usage row is kept for the month it counts
-- and the 12 before it (ASSISTANT_USAGE_RETENTION_MONTHS = 13: a year of the
-- project's spend to compare against its bill), then deleted.
--
-- Personal data: a usage row names the person (user_id). On an account
-- deletion it stays with the name cleared (ON DELETE SET NULL), so the
-- month still counts what was spent; it is in the person's "Download my
-- data" (auth/export.ts assistantUsage), and members read only their own
-- rows. The rate row is a count for an hourly cap (ON DELETE CASCADE, purged
-- after its hour), not exported, as dem_attempt (184).

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
-- The month caps sum a month's rows, over the project, the person or every project.
CREATE INDEX assistant_usage_month_idx ON assistant_usage (month);
COMMENT ON TABLE assistant_usage IS
	'Assistant tokens and messages per project, person and UTC month (262). Written only by app_assistant_begin / app_assistant_charge, purged after 13 months by app_purge_assistant; members read their own rows.';

ALTER TABLE assistant_usage ENABLE ROW LEVEL SECURITY;
-- A person reads their own rows (the export); the project total comes from app_assistant_used.
CREATE POLICY assistant_usage_own ON assistant_usage FOR SELECT USING (user_id = app_current_user_id());
GRANT SELECT ON assistant_usage TO water_app;

CREATE TABLE assistant_rate (
	user_id      uuid PRIMARY KEY REFERENCES app_user (id) ON DELETE CASCADE,
	window_start timestamptz NOT NULL DEFAULT now(),
	messages     integer NOT NULL DEFAULT 0 CHECK (messages >= 0)
);
-- The tick's purge deletes rows by age.
CREATE INDEX assistant_rate_window_idx ON assistant_rate (window_start);
COMMENT ON TABLE assistant_rate IS
	'Assistant messages per person in a one-hour window (262). Only app_assistant_begin touches it; app_purge_assistant deletes it once its hour is over.';

-- As map_compute_throttle (186): the app touches it only through the function below.
ALTER TABLE assistant_rate ENABLE ROW LEVEL SECURITY;
CREATE POLICY assistant_rate_none ON assistant_rate USING (false) WITH CHECK (false);
GRANT SELECT, INSERT, UPDATE, DELETE ON assistant_rate TO water_app;

-- Weighted tokens (input + 5 × output, assistant/config.ts weightedTokens): what every cap counts.
CREATE FUNCTION assistant_weighted(p_input bigint, p_output bigint) RETURNS bigint
	LANGUAGE sql IMMUTABLE SET search_path = public
	AS $$ SELECT p_input + 5 * p_output $$;
REVOKE ALL ON FUNCTION assistant_weighted(bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assistant_weighted(bigint, bigint) TO water_app;

-- This UTC month's weighted tokens for the signed-in user, where they are a
-- member (viewer and above) of p_project: the project's, theirs across
-- projects, and the deployment's in all (a total, naming no one). NULLs for
-- anyone else. The status (GET …/assistant) shows the cap nearest its end.
CREATE FUNCTION app_assistant_used(p_project uuid) RETURNS TABLE (project_used bigint, user_used bigint, total_used bigint)
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
		RETURN QUERY SELECT
			coalesce(sum(assistant_weighted(u.input_tokens, u.output_tokens)) FILTER (WHERE u.project_id = p_project), 0)::bigint,
			coalesce(sum(assistant_weighted(u.input_tokens, u.output_tokens)) FILTER (WHERE u.user_id = v_user), 0)::bigint,
			coalesce(sum(assistant_weighted(u.input_tokens, u.output_tokens)), 0)::bigint
		FROM assistant_usage u WHERE u.month = v_month;
	END
	$$;
REVOKE ALL ON FUNCTION app_assistant_used(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_assistant_used(uuid) TO water_app;

-- Begin one turn by the signed-in user on project p_project, where they are
-- at least a viewer. outcome:
--   'ok'           counted: one message in the hour and on this month's row;
--   'rate'         the person has sent p_messages_per_hour messages this window;
--                  wait_seconds until it ends (nothing counted);
--   'total_budget' the deployment's month has used p_tokens_total_per_month;
--   'user_budget'  the person's month has used p_tokens_per_user_month;
--   'budget'       the project's month has used p_tokens_per_month;
--                  each with wait_seconds until the month ends (nothing counted),
--                  checked in this order (the widest cap first).
-- The *_used columns are this month's weighted tokens so far: the project's,
-- the person's and the deployment's. Anyone else, or no user, is refused with
-- an error: the route has checked the role already, so this only stops a
-- caller from using up another project's budget.
CREATE FUNCTION app_assistant_begin(
	p_project uuid,
	p_tokens_per_month bigint,
	p_messages_per_hour integer,
	p_tokens_per_user_month bigint,
	p_tokens_total_per_month bigint
)
	RETURNS TABLE (outcome text, wait_seconds integer, project_used bigint, user_used bigint, total_used bigint)
	LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_user uuid := app_current_user_id();
		v_month date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
		v_month_wait integer;
		v_project bigint;
		v_mine bigint;
		v_total bigint;
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
		-- Every turn's check one at a time (the deployment's cap spans projects), then the project's,
		-- then the person's row: always in this order, so no two begins wait on each other in a cycle.
		PERFORM pg_advisory_xact_lock(hashtext('assistant_usage:all'));
		PERFORM pg_advisory_xact_lock(hashtext('assistant_usage:' || p_project::text));
		-- The end of the person's window: their row goes (the tick purges the rest, app_purge_assistant).
		DELETE FROM assistant_rate WHERE user_id = v_user AND window_start <= now() - interval '1 hour';
		INSERT INTO assistant_rate (user_id) VALUES (v_user) ON CONFLICT (user_id) DO NOTHING;
		SELECT * INTO v_rate FROM assistant_rate WHERE user_id = v_user FOR UPDATE;
		SELECT
			coalesce(sum(assistant_weighted(u.input_tokens, u.output_tokens)) FILTER (WHERE u.project_id = p_project), 0)::bigint,
			coalesce(sum(assistant_weighted(u.input_tokens, u.output_tokens)) FILTER (WHERE u.user_id = v_user), 0)::bigint,
			coalesce(sum(assistant_weighted(u.input_tokens, u.output_tokens)), 0)::bigint
			INTO v_project, v_mine, v_total
			FROM assistant_usage u WHERE u.month = v_month;
		IF v_rate.messages + 1 > p_messages_per_hour THEN
			RETURN QUERY SELECT 'rate'::text,
				greatest(1, ceil(extract(epoch FROM v_rate.window_start + interval '1 hour' - now())))::integer, v_project, v_mine, v_total;
			RETURN;
		END IF;
		v_month_wait := greatest(1, ceil(extract(epoch FROM ((v_month + interval '1 month')::timestamp AT TIME ZONE 'UTC') - now())))::integer;
		IF v_total >= p_tokens_total_per_month THEN
			RETURN QUERY SELECT 'total_budget'::text, v_month_wait, v_project, v_mine, v_total;
			RETURN;
		END IF;
		IF v_mine >= p_tokens_per_user_month THEN
			RETURN QUERY SELECT 'user_budget'::text, v_month_wait, v_project, v_mine, v_total;
			RETURN;
		END IF;
		IF v_project >= p_tokens_per_month THEN
			RETURN QUERY SELECT 'budget'::text, v_month_wait, v_project, v_mine, v_total;
			RETURN;
		END IF;
		UPDATE assistant_rate SET messages = messages + 1 WHERE user_id = v_user;
		INSERT INTO assistant_usage (project_id, user_id, month, messages) VALUES (p_project, v_user, v_month, 1)
			ON CONFLICT (project_id, month, user_id) DO UPDATE SET messages = assistant_usage.messages + 1, updated_at = now();
		RETURN QUERY SELECT 'ok'::text, 0, v_project, v_mine, v_total;
	END
	$$;
REVOKE ALL ON FUNCTION app_assistant_begin(uuid, bigint, integer, bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_assistant_begin(uuid, bigint, integer, bigint, bigint) TO water_app;

-- Charge the tokens one turn used to the signed-in user's row for this UTC
-- month on p_project (a viewer and above). Returns this month's weighted
-- tokens after it, as app_assistant_used: the project's, the person's and the
-- deployment's. One upsert, so parallel charges are each counted once.
CREATE FUNCTION app_assistant_charge(p_project uuid, p_input bigint, p_output bigint)
	RETURNS TABLE (project_used bigint, user_used bigint, total_used bigint)
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
		RETURN QUERY SELECT
			coalesce(sum(assistant_weighted(u.input_tokens, u.output_tokens)) FILTER (WHERE u.project_id = p_project), 0)::bigint,
			coalesce(sum(assistant_weighted(u.input_tokens, u.output_tokens)) FILTER (WHERE u.user_id = v_user), 0)::bigint,
			coalesce(sum(assistant_weighted(u.input_tokens, u.output_tokens)), 0)::bigint
		FROM assistant_usage u WHERE u.month = v_month;
	END
	$$;
REVOKE ALL ON FUNCTION app_assistant_charge(uuid, bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_assistant_charge(uuid, bigint, bigint) TO water_app;

-- The tick's retention (jobs/runner.ts): rate rows whose hour is over, and
-- usage rows of months before the last p_months (the current one included).
-- The worker only (no user, no API key). Returns the rows deleted.
CREATE FUNCTION app_purge_assistant(p_months integer) RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_rate integer;
		v_usage integer;
	BEGIN
		IF NOT alert_worker_context() THEN
			RAISE EXCEPTION 'only the worker purges the assistant counters' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_months IS NULL OR p_months < 2 THEN
			RAISE EXCEPTION 'keep at least this month and the one before' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		DELETE FROM assistant_rate WHERE window_start <= now() - interval '1 hour';
		GET DIAGNOSTICS v_rate = ROW_COUNT;
		DELETE FROM assistant_usage
			WHERE month < (date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(months => p_months - 1))::date;
		GET DIAGNOSTICS v_usage = ROW_COUNT;
		RETURN v_rate + v_usage;
	END
	$$;
REVOKE ALL ON FUNCTION app_purge_assistant(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_purge_assistant(integer) TO water_app;
