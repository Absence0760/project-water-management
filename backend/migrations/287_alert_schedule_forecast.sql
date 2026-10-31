-- 287_alert_schedule_forecast — the tick's scheduled alert checks include
-- the EWR forecast alert (docs/api.md § Alerts, docs/data-model.md § Alerts;
-- backend/src/alerts/evaluate.ts).
--
-- An ewr_forecast_fail event clears once its forecast's days have all
-- passed (a forecast of the past says nothing about what's coming), judged
-- against today in the project's time zone: a value that changes with the
-- calendar, not with a run. app_alert_schedule queued the scheduled check
-- only for projects with an enabled data_stale, feed_failing or job_dead
-- rule, so on a project with the EWR alert on and none of those, once the
-- forecast runs stopped (the forecast feed failing) nothing evaluated it:
-- the event stayed firing, on the Overview and the portfolio, for a
-- forecast weeks past. The kinds the scheduler looks for now include
-- ewr_forecast_fail. Spacing (p_gap, the tick's hour), the acting editor and
-- who may call it are unchanged.
--
-- app_alert_schedule, from its only definition (051_alerts.sql); CREATE OR
-- REPLACE keeps its grants (REVOKE from PUBLIC, EXECUTE to water_app). No
-- table or policy changes; no personal data.

CREATE OR REPLACE FUNCTION app_alert_schedule(p_project uuid, p_gap interval, p_limit integer) RETURNS integer
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
				AND (p_project IS NOT NULL OR r.kind IN ('data_stale', 'feed_failing', 'job_dead', 'ewr_forecast_fail')))
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
