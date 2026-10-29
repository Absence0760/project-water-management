-- 272_plan_request — Start and Divide plans on the background worker (issue
-- #646 item 3; docs/design/delineation.md § Where it runs, docs/maps.md
-- § Start from the map, followups.md "Start and Divide have no worker").
--
-- Start from the map and Divide route the elevation model within the API
-- request's 20 s and 3 072-cell window (about 100 km at zoom 11), and refused
-- a larger catchment `too_large` (48 of 129 gauges of 1 000–10 000 km² that
-- Delineate proposes through the worker). Now a plan whose routing stops at
-- the request's last window goes to the same `delineate` job as a click
-- (191): the same code with the worker's larger windows, its first placed
-- over where the request's window cut the catchment. A Start answers at once
-- with the plan a server without a DEM makes from the same map (since
-- start-16 the units' areas are their boundaries'), and the job's routed plan
-- replaces it while it is still open.
--
-- In this file, all on delineation_request (latest: 191, its trigger 211):
--  1. A request is a click (click_kind, click_lon, click_lat) or a plan
--     (plan_kind 'start' | 'divide', plan_body: the editor's request body as
--     sent, bounded), never both; the click columns become nullable for it.
--  2. plan_proposal_id: the start_proposal the job made (with `proposed`);
--     fallback_proposal_id: a Start's proposal without the order, made at
--     once, that the routed one replaces while open. Both composite foreign
--     keys on (id, project_id), so same-project by construction (start_proposal
--     gains that unique key), cleared when the proposal is pruned.
--  3. refusal_code also takes 'off_channel' (delineate-13's refusal, which the
--     list never had) and 'map_changed' (a plan's feature gone or changed
--     before the job read the map).
--  4. delineation_request_final compares the new columns too.
-- RLS, grants, the job's same-project trigger and app_cancel_job are
-- unchanged: a plan's job is a `delineate` job of its project. Personal data:
-- none new (plan_body names map features by id only).

-- ---------------------------------------------------------------------------
-- 1. A click or a plan
-- ---------------------------------------------------------------------------
ALTER TABLE delineation_request
	ALTER COLUMN click_kind DROP NOT NULL,
	ALTER COLUMN click_lon DROP NOT NULL,
	ALTER COLUMN click_lat DROP NOT NULL,
	ADD COLUMN plan_kind text CHECK (plan_kind IN ('start', 'divide')),
	ADD COLUMN plan_body jsonb CHECK (plan_body IS NULL OR (jsonb_typeof(plan_body) = 'object' AND octet_length(plan_body::text) <= 16384)),
	ADD CONSTRAINT delineation_request_click_or_plan CHECK (
		(plan_kind IS NULL AND plan_body IS NULL AND click_kind IS NOT NULL AND click_lon IS NOT NULL AND click_lat IS NOT NULL)
		OR (plan_kind IS NOT NULL AND plan_body IS NOT NULL AND click_kind IS NULL AND click_lon IS NULL AND click_lat IS NULL)
	);

-- ---------------------------------------------------------------------------
-- 2. The plan's proposals
-- ---------------------------------------------------------------------------
ALTER TABLE start_proposal ADD CONSTRAINT start_proposal_id_project_key UNIQUE (id, project_id);

ALTER TABLE delineation_request
	ADD COLUMN plan_proposal_id uuid,
	ADD COLUMN fallback_proposal_id uuid,
	ADD CONSTRAINT delineation_request_plan_proposal_fkey FOREIGN KEY (plan_proposal_id, project_id)
		REFERENCES start_proposal (id, project_id) ON DELETE SET NULL (plan_proposal_id),
	ADD CONSTRAINT delineation_request_fallback_proposal_fkey FOREIGN KEY (fallback_proposal_id, project_id)
		REFERENCES start_proposal (id, project_id) ON DELETE SET NULL (fallback_proposal_id),
	ADD CONSTRAINT delineation_request_plan_proposal_status CHECK (plan_proposal_id IS NULL OR (status = 'proposed' AND plan_kind IS NOT NULL)),
	ADD CONSTRAINT delineation_request_fallback_plan CHECK (fallback_proposal_id IS NULL OR plan_kind = 'start');
CREATE INDEX delineation_request_plan_proposal_idx ON delineation_request (plan_proposal_id, project_id);
CREATE INDEX delineation_request_fallback_proposal_idx ON delineation_request (fallback_proposal_id, project_id);

-- ---------------------------------------------------------------------------
-- 3. The refusals
-- ---------------------------------------------------------------------------
ALTER TABLE delineation_request DROP CONSTRAINT delineation_request_refusal_code_check;
ALTER TABLE delineation_request ADD CONSTRAINT delineation_request_refusal_code_check
	CHECK (refusal_code IN ('outside', 'no_data', 'off_channel', 'too_large', 'too_small', 'outline', 'larger_channel', 'confluence', 'off', 'map_changed'));

-- ---------------------------------------------------------------------------
-- 4. An outcome is final (latest: 211): the plan's columns too
-- ---------------------------------------------------------------------------
-- Only the links (the proposals', cleared by their foreign keys; the job's, by the purge) may change once finished.
CREATE OR REPLACE FUNCTION delineation_request_final() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF OLD.status <> 'queued' AND (
			(NEW.id, NEW.project_id, NEW.status, NEW.click_kind, NEW.click_lon, NEW.click_lat, NEW.keep_point, NEW.from_window,
				NEW.aim, NEW.refusal_code, NEW.refusal, NEW.larger, NEW.created_at, NEW.finished_at, NEW.plan_kind, NEW.plan_body)
			IS DISTINCT FROM
			(OLD.id, OLD.project_id, OLD.status, OLD.click_kind, OLD.click_lon, OLD.click_lat, OLD.keep_point, OLD.from_window,
				OLD.aim, OLD.refusal_code, OLD.refusal, OLD.larger, OLD.created_at, OLD.finished_at, OLD.plan_kind, OLD.plan_body)
			OR (NEW.proposal_id IS DISTINCT FROM OLD.proposal_id AND NEW.proposal_id IS NOT NULL)
			OR (NEW.plan_proposal_id IS DISTINCT FROM OLD.plan_proposal_id AND NEW.plan_proposal_id IS NOT NULL)
			OR (NEW.fallback_proposal_id IS DISTINCT FROM OLD.fallback_proposal_id AND NEW.fallback_proposal_id IS NOT NULL)
			OR (NEW.job_id IS DISTINCT FROM OLD.job_id AND NEW.job_id IS NOT NULL)
		) THEN
			RAISE EXCEPTION 'a delineation request is finished once, and its outcome stays' USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END
	$$;

COMMENT ON TABLE delineation_request IS
	'A click delineated on the background worker, too large for the request (191), or a Start or Divide plan routed there (272): the job that has it, then the proposal it made or the refusal. Viewers read; editors queue; the job writes the outcome as its editor.';
