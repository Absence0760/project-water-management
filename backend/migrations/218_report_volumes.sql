-- 218_report_volumes — a server report PDF printed with each farm's
-- registered volume isn't a viewer's to download (issue #523 G1, decision D3;
-- docs/security.md § Allocations, docs/api.md § Reports).
--
-- A report is printed in a render session as the member who asked for it
-- (reports/scope.ts), so it shows what they read. Printed for an editor or
-- owner, the run report's "Changes since the previous publication" and an
-- impact report's input changes list "Registered volume added to <unit>
-- (surface N m³/a)" and the like (engine compare.ts diffInputs), and any
-- viewer of the project could download it (report_select is viewer-wide). A
-- viewer the project doesn't let read each registered volume
-- (project.allocations_viewer_units off, 162) must not.
--
--   report.with_volumes
--       Set by report_enqueue at insert, never by the caller: true when the
--       requester reads each registered volume (an editor or owner, or a
--       viewer with the switch on) and a run of the project, or the impact
--       report's baseline, carries a registered volume (its stored
--       inputs.model.allocations). The API refuses such a PDF to a viewer
--       who can't read each volume (403 pack_volumes_withheld, unless they
--       asked for it themselves) and doesn't email its link to them
--       (reports/store.ts finishReport). A scheduled report prints as its
--       editor, so it is sent to the recipients who may read it; a viewer
--       kept from the volumes asks for their own PDF, printed as them.
--       Existing rows are true: who printed them, and with what, isn't
--       recorded, so they fail closed (the requester still downloads their
--       own; reports are deleted after 8 days).
--       An impact report against another project's baseline is never true:
--       the report project's readers mustn't read the baseline project's
--       volumes, and the reverse, so it is printed without any (below), and
--       anyone who reads the report project may download it.
--   render_token.redact_allocations
--       The visibility a report prints at, fixed when it was queued: the
--       report job issues its token with `NOT report.with_volumes`, and a
--       render session opened with such a token reads every project as a
--       viewer kept from the volumes (the session's `x` claim;
--       allocationUnitsHidden). So a requester promoted, or the switch turned
--       on, between queue and render can't print volumes into a PDF flagged
--       without them; one demoted prints fewer than the flag allows, never
--       more. app_consume_render_token returns it.
--
-- No grant changes: report's INSERT is table-wide and the trigger overwrites
-- with_volumes; there is no UPDATE grant on it. render_token's INSERT is
-- table-wide (023); only the report job sets the new column.

ALTER TABLE report ADD COLUMN with_volumes boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN report.with_volumes IS
	'Printed with each farm''s registered volume (218, #523 G1): the requester could read each one and a run of the project (or the baseline) carries one. Set by report_enqueue. A viewer kept from the volumes (162) is refused its PDF and not sent its link.';

-- Latest definition: 082_report_against.sql. Adds with_volumes.
CREATE OR REPLACE FUNCTION report_enqueue() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
	BEGIN
		IF uid IS NULL THEN
			RAISE EXCEPTION 'a report needs a signed-in user' USING ERRCODE = 'insufficient_privilege';
		END IF;
		NEW.requested_by := uid;
		NEW.status := 'queued';
		NEW.pages := NULL;
		NEW.bytes := NULL;
		NEW.error := NULL;
		NEW.created_at := now();
		NEW.finished_at := NULL;
		IF NEW.run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM model_run r WHERE r.id = NEW.run_id AND r.project_id = NEW.project_id) THEN
			RAISE EXCEPTION 'the run is not one of the project''s' USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.job_id IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM job j WHERE j.id = NEW.job_id AND j.project_id = NEW.project_id AND j.kind = 'report_render' AND j.acting_user_id = uid
		) THEN
			RAISE EXCEPTION 'the job is not this report''s render' USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.schedule_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM report_schedule s WHERE s.id = NEW.schedule_id AND s.project_id = NEW.project_id) THEN
			RAISE EXCEPTION 'the schedule is not one of the project''s' USING ERRCODE = 'check_violation';
		END IF;
		-- An impact report names its baseline, one the requester can read
		-- (this function is SECURITY INVOKER: model_run's RLS is theirs), and
		-- not the run itself.
		IF NEW.impact AND NEW.against_run_id IS NULL THEN
			RAISE EXCEPTION 'an impact report needs a baseline run' USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.against_run_id IS NOT NULL THEN
			IF NOT EXISTS (SELECT 1 FROM model_run r WHERE r.id = NEW.against_run_id AND app_has_role(r.project_id, 'viewer')) THEN
				RAISE EXCEPTION 'the baseline run is not one the requester can read' USING ERRCODE = 'insufficient_privilege';
			END IF;
			IF NEW.against_run_id = NEW.run_id THEN
				RAISE EXCEPTION 'the baseline is the run itself' USING ERRCODE = 'check_violation';
			END IF;
		END IF;
		-- 218: printed with each farm's registered volume? The requester reads each one (D3, 162), the report isn't
		-- against another project's baseline (printed without any volumes), and a run they can read of this project,
		-- or the baseline, carries one. Under their RLS, as the render will read.
		NEW.with_volumes := (app_has_role(NEW.project_id, 'editor') OR app_allocations_viewer_units(NEW.project_id))
			AND (NEW.against_run_id IS NULL OR EXISTS (SELECT 1 FROM model_run b WHERE b.id = NEW.against_run_id AND b.project_id = NEW.project_id))
			AND EXISTS (
				SELECT 1 FROM model_run r
				WHERE (r.project_id = NEW.project_id OR r.id = NEW.against_run_id)
				  AND CASE WHEN jsonb_typeof(r.inputs -> 'model' -> 'allocations') = 'array'
				           THEN jsonb_array_length(r.inputs -> 'model' -> 'allocations') > 0 ELSE false END
			);
		RETURN NEW;
	END
	$$;

-- ---------------------------------------------------------------------------
-- The render's visibility, fixed at queue time
-- ---------------------------------------------------------------------------
ALTER TABLE render_token ADD COLUMN redact_allocations boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN render_token.redact_allocations IS
	'218, #523 G1: the render session reads every project as a viewer kept from each registered volume (a report queued without them, report.with_volumes false). Set by the report job.';

-- Latest definition: 165_applicant_copy.sql. Returns redact_allocations too.
DROP FUNCTION app_consume_render_token(bytea);
CREATE FUNCTION app_consume_render_token(p_hash bytea)
	RETURNS TABLE (user_id uuid, project_id uuid, run_id uuid, against_project_id uuid, against_run_id uuid, pack_id uuid, purpose text, redact_allocations boolean)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_user uuid;
		v_project uuid;
		v_run uuid;
		v_against uuid;
		v_pack uuid;
		v_purpose text;
		v_expires timestamptz;
		v_redact boolean;
	BEGIN
		DELETE FROM render_token t WHERE t.token_hash = p_hash
			RETURNING t.user_id, t.project_id, t.run_id, t.against_run_id, t.pack_id, t.purpose, t.expires_at, t.redact_allocations
			INTO v_user, v_project, v_run, v_against, v_pack, v_purpose, v_expires, v_redact;
		DELETE FROM render_token t WHERE t.expires_at < now() - interval '1 day';
		IF v_user IS NULL OR v_expires <= now() THEN
			RETURN;
		END IF;
		RETURN QUERY SELECT v_user, v_project, v_run, (SELECT r.project_id FROM model_run r WHERE r.id = v_against), v_against, v_pack, v_purpose, v_redact;
	END
	$$;
REVOKE ALL ON FUNCTION app_consume_render_token(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_consume_render_token(bytea) TO water_app;
