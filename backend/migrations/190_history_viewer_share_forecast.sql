-- 190_history_viewer_share_forecast — two read paths that showed more than
-- their reader may see (docs/followups.md § Allocations, "Registration
-- numbers in History"; § POPIA and the Step 2 release, "One guard for views
-- over a run's stored series").
--
--  1. app_audit_subject: an audit event's subject as the reader may see it.
--     The allocation events (allocation.created / changed / deleted, written
--     by allocations/routes.ts) carry the allocation's registration number,
--     a "unique identifier" (POPIA s1), and allocation.created its volume.
--     A viewer reads neither from the allocation table (allocation_select,
--     162) until an owner switches allocations_viewer_units on, so the
--     History, which viewers read, mustn't hand them over either. The
--     History route reads every event's subject through this function
--     (history/routes.ts historyPage); editors and owners, and viewers once
--     the switch is on, read the subject as written.
--  2. app_share_series, from 164_applicant_visibility.sql (its latest): a
--     published forecast run's series run on into its forecast days (WP-2.12),
--     and a share link's chart averaged them into the latest months and the
--     last 365 days as if they were the river's record. Now cut at the run's
--     summary.forecast.from, as every other view over a run's stored series
--     is (engine views/fdc.ts beforeForecast; the guard is
--     scripts/guards/check_forecast_cut.mjs). The forecast stays the farm
--     view's ("Next 14 days").

-- ---------------------------------------------------------------------------
-- 1. An audit event's subject, for the reader
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_audit_subject(p_project uuid, p_kind text, p_subject jsonb) RETURNS jsonb
	LANGUAGE sql STABLE SET search_path = public
	AS $$
		SELECT CASE
			WHEN p_kind LIKE 'allocation.%'
				AND NOT coalesce(app_has_role(p_project, 'editor'), false)
				AND NOT app_allocations_viewer_units(p_project)
			THEN p_subject - 'registrationNo' - 'volumeM3PerYear'
			ELSE p_subject
		END
	$$;
COMMENT ON FUNCTION app_audit_subject(uuid, text, jsonb) IS
	'An audit event''s subject as the current user may read it (190): an allocation event without its registration number or volume for a reader who can''t read the allocation rows themselves (allocation_select, 162). The History reads every subject through it.';
REVOKE ALL ON FUNCTION app_audit_subject(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_audit_subject(uuid, text, jsonb) TO water_app;

-- ---------------------------------------------------------------------------
-- 2. A share link's series: the record only
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_share_series(p_hash bytea, p_key text)
	RETURNS TABLE (
		label text,
		unit text,
		monthly_start date,
		monthly double precision[],
		recent_start date,
		recent double precision[]
	)
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		WITH pub AS (
			SELECT p.project_id, p.run_id, r.start_date, (r.summary->'forecast'->>'from')::date AS forecast_from
			FROM share_link s
			JOIN run_publication p ON p.project_id = s.project_id AND p.superseded_at IS NULL
			JOIN model_run r ON r.id = p.run_id
			WHERE s.token_hash = p_hash AND s.target_kind IS NULL AND s.revoked_at IS NULL AND s.expires_at > now()
			  AND p_key IN ('natural_flow', 'simulated_outflow', 'observed_flow', 'ewr', 'ewr_shortfall')
		), holders AS (
			SELECT count(DISTINCT coalesce(
				(SELECT min(fl.user_id::text) FROM farm_link fl WHERE fl.node_id = n.id),
				'node:' || n.id::text
			)) AS n
			FROM node n JOIN pub ON n.project_id = pub.project_id
			WHERE n.kind = 'farm'
		), series AS (
			-- A forecast run's days before its first forecast day (a slice past the end clamps).
			SELECT rs.meta,
				CASE WHEN pub.forecast_from IS NULL THEN rs."values"
					ELSE rs."values"[1 : greatest(0, pub.forecast_from - pub.start_date)] END AS vals,
				pub.start_date
			FROM run_series rs JOIN pub ON rs.run_id = pub.run_id AND rs.project_id = pub.project_id
			WHERE rs.node_id IS NULL AND rs.key = p_key
			  -- The river (164): natural flow and the requirement made from it, always; the use's series at k ≥ 5.
			  AND (p_key IN ('natural_flow', 'ewr') OR (SELECT n FROM holders) >= 5)
		), days AS (
			SELECT (series.start_date + (u.o - 1)::int) AS d, NULLIF(u.v, 'NaN'::double precision) AS v
			FROM series, unnest(series.vals) WITH ORDINALITY u(v, o)
		), months AS (
			SELECT date_trunc('month', d)::date AS m, avg(v) AS v FROM days GROUP BY 1
		)
		SELECT
			coalesce(series.meta->>'label', p_key),
			coalesce(series.meta->>'unit', ''),
			date_trunc('month', series.start_date)::date,
			coalesce((SELECT array_agg(months.v ORDER BY months.m) FROM months), '{}'),
			series.start_date + greatest(0, cardinality(series.vals) - 365),
			coalesce((SELECT array_agg(days.v ORDER BY days.d) FROM days WHERE days.d >= series.start_date + greatest(0, cardinality(series.vals) - 365)), '{}')
		FROM series
	$$;
