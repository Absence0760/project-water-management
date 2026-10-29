-- 284_cancel_future_jobs — cancelling § 8's future yield and the Scenarios
-- tab's change factors (issue #621; docs/api.md § Future yield and § Future
-- climate, docs/data-model.md § Jobs).
--
-- A real 10-model future yield is about 40 runs; an editor who queued the
-- wrong one, or whose climate projections changed, could only wait for it.
-- app_cancel_job now also takes `future_yield` and `climate_factors` jobs,
-- through POST …/future-yield/:jobId/cancel and POST …/climate-factors/:jobId/cancel
-- (backend/src/future/routes.ts, editor). Who may cancel is unchanged: the
-- user who queued the job, or an editor of its project (both kinds are
-- queued by editors only). A waiting job is dead at once; a running one is
-- flagged, and its handler stops at its next progress report, before it
-- writes a result.
--
-- No table, policy or grant changes; no personal data.

-- Latest definition: 191_delineation_request.sql. Only the kind list changes.
CREATE OR REPLACE FUNCTION app_cancel_job(p_id uuid) RETURNS text
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
		v_status text;
	BEGIN
		IF uid IS NULL THEN
			RETURN NULL;
		END IF;
		UPDATE job j SET
			status = CASE WHEN j.status IN ('queued', 'failed') THEN 'dead' ELSE j.status END,
			finished_at = CASE WHEN j.status IN ('queued', 'failed') THEN now() ELSE j.finished_at END,
			last_error = CASE WHEN j.status IN ('queued', 'failed') THEN 'cancelled' ELSE j.last_error END,
			cancel_requested_at = CASE WHEN j.status = 'running' THEN COALESCE(j.cancel_requested_at, now()) ELSE j.cancel_requested_at END
		WHERE j.id = p_id AND j.kind IN ('yield', 'delineate', 'future_yield', 'climate_factors')
		  AND (j.acting_user_id = uid OR app_has_role(j.project_id, 'editor'))
		RETURNING j.status INTO v_status;
		RETURN v_status;
	END
	$$;
