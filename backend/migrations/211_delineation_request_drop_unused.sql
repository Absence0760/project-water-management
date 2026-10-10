-- 211_delineation_request_drop_unused — drop the two columns of
-- delineation_request (191) nothing reads or writes since issue #472
-- (delineate-13), the contract half of that change (issue #476):
--  - reach: the river reach picked at a confluence. The confluence question
--    is gone, so the route never stores a pick and the worker never reads one.
--  - check_note: the river-network check sent with a proposal. `checkNote`
--    is gone from the API.
-- The release that stopped using them (backend@0.2.1) is in production, so
-- no running backend reads them. Their CHECK constraints go with them.
--
-- delineation_request_final (latest: 191) compares every column but the two
-- links, so it is redefined first without the dropped ones; the rest of it
-- is unchanged.

CREATE OR REPLACE FUNCTION delineation_request_final() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF OLD.status <> 'queued' AND (
			(NEW.id, NEW.project_id, NEW.status, NEW.click_kind, NEW.click_lon, NEW.click_lat, NEW.keep_point, NEW.from_window,
				NEW.aim, NEW.refusal_code, NEW.refusal, NEW.larger, NEW.created_at, NEW.finished_at)
			IS DISTINCT FROM
			(OLD.id, OLD.project_id, OLD.status, OLD.click_kind, OLD.click_lon, OLD.click_lat, OLD.keep_point, OLD.from_window,
				OLD.aim, OLD.refusal_code, OLD.refusal, OLD.larger, OLD.created_at, OLD.finished_at)
			OR (NEW.proposal_id IS DISTINCT FROM OLD.proposal_id AND NEW.proposal_id IS NOT NULL)
			OR (NEW.job_id IS DISTINCT FROM OLD.job_id AND NEW.job_id IS NOT NULL)
		) THEN
			RAISE EXCEPTION 'a delineation request is finished once, and its outcome stays' USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END
	$$;

ALTER TABLE delineation_request DROP COLUMN reach, DROP COLUMN check_note;
