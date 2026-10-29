-- 285_cancel_job_outcome — a cancel says whether it changed anything
-- (docs/followups.md; docs/api.md § Yield, § Future yield and § Future
-- climate; docs/data-model.md § Jobs).
--
-- The yield, future yield and climate factors cancel routes answered
-- `cancelled: true` whenever the job was `dead` or `running` afterwards, so
-- cancelling a job a second time (already dead, or already flagged) still said
-- it was cancelled. app_cancel_job_outcome(id) does what app_cancel_job did
-- and also says whether this call changed the job: `changed` is true only when
-- it killed a waiting job (queued or failed → dead) or flagged a running one
-- not flagged yet. The update itself only touches such a job, so of two
-- cancels at once exactly one reports the change (the second waits on the row
-- lock and, under READ COMMITTED, finds it no longer matches).
--
-- Expand only: app_cancel_job(id) keeps its signature (RETURNS text, the
-- job's status afterwards) for the delineation callers and for a backend
-- still running while this migration lands; it is now a thin wrapper over the
-- new function, so the two can't drift. Who may cancel and which kinds are
-- unchanged (latest definition: 284_cancel_future_jobs.sql).
--
-- No table or policy changes; no personal data.

CREATE FUNCTION app_cancel_job_outcome(p_id uuid, OUT status text, OUT changed boolean)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	DECLARE
		uid uuid := app_current_user_id();
	BEGIN
		changed := false;
		IF uid IS NULL THEN
			RETURN;
		END IF;
		-- Only a job this call changes: a waiting one, or a running one not flagged yet.
		UPDATE job j SET
			status = CASE WHEN j.status IN ('queued', 'failed') THEN 'dead' ELSE j.status END,
			finished_at = CASE WHEN j.status IN ('queued', 'failed') THEN now() ELSE j.finished_at END,
			last_error = CASE WHEN j.status IN ('queued', 'failed') THEN 'cancelled' ELSE j.last_error END,
			cancel_requested_at = CASE WHEN j.status = 'running' THEN now() ELSE j.cancel_requested_at END
		WHERE j.id = p_id AND j.kind IN ('yield', 'delineate', 'future_yield', 'climate_factors')
		  AND (j.acting_user_id = uid OR app_has_role(j.project_id, 'editor'))
		  AND (j.status IN ('queued', 'failed') OR (j.status = 'running' AND j.cancel_requested_at IS NULL))
		RETURNING j.status INTO status;
		IF FOUND THEN
			changed := true;
			RETURN;
		END IF;
		-- Nothing to change (done, dead, or already flagged): its status as it is, or NULL when it isn't the caller's to cancel.
		SELECT j.status INTO status FROM job j
		WHERE j.id = p_id AND j.kind IN ('yield', 'delineate', 'future_yield', 'climate_factors')
		  AND (j.acting_user_id = uid OR app_has_role(j.project_id, 'editor'));
	END
	$$;

COMMENT ON FUNCTION app_cancel_job_outcome(uuid) IS
	'Cancel a yield, delineate, future_yield or climate_factors job as the session''s user (who queued it, or an editor of its project): status afterwards (NULL when not theirs) and whether this call changed it (285_cancel_job_outcome).';

REVOKE ALL ON FUNCTION app_cancel_job_outcome(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_cancel_job_outcome(uuid) TO water_app;

-- Latest definition: 284_cancel_future_jobs.sql. Same signature, settings and grants; the work is app_cancel_job_outcome's.
CREATE OR REPLACE FUNCTION app_cancel_job(p_id uuid) RETURNS text
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		RETURN (SELECT o.status FROM app_cancel_job_outcome(p_id) o);
	END
	$$;
