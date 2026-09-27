-- 082_report_against — a server-side PDF of the impact report (issue #17;
-- docs/api.md § Reports, docs/data-model.md § Reports, docs/security.md §
-- Render tokens).
--
-- The report route prints an impact report with `&against=<project>:<run>`
-- (Compare runs' Export impact report): the run's report with a first
-- section comparing it against a baseline run, which may be in another
-- project. 023 stored only the run to print, so the server PDF could print
-- only the plain report. Now a report, and the render token that lets the
-- headless browser in, carry the baseline too:
--
--   report.impact / report.against_run_id
--       An impact report of run_id against against_run_id. The baseline may
--       be another project's run: deliberately, as in Compare runs. So the
--       reference is not same-project (cross-project-refs.security.db.test.ts
--       classifies it as a baseline); instead the requester must be able to
--       READ it, checked by report_enqueue under RLS as the requester (a
--       viewer of its project who can see the run). ON DELETE SET NULL, with
--       `impact` kept, so a report whose baseline was deleted before the
--       render fails ("the baseline was deleted") rather than quietly
--       printing the plain report. Fixed at insert like the other references
--       (no UPDATE grant).
--   render_token.against_run_id
--       The baseline the render session may compare against (its only extra
--       read: GET /compare/runs with exactly this pair, reports/scope.ts).
--       render_token_issue checks it the same way, as the issuer.
--       app_consume_render_token returns it with its project.
--
-- Nothing is backfilled: every existing report and token is of a plain run.

-- ---------------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------------

ALTER TABLE report
	ADD COLUMN impact boolean NOT NULL DEFAULT false,
	ADD COLUMN against_run_id uuid REFERENCES model_run(id) ON DELETE SET NULL,
	ADD CONSTRAINT report_against_is_impact CHECK (impact OR against_run_id IS NULL);
-- Covering index for the foreign key (catalogue.db.test.ts).
CREATE INDEX report_against_run_idx ON report (against_run_id);

COMMENT ON COLUMN report.impact IS 'An impact report (the run against a baseline, 082); stays true when the baseline is deleted, so the render fails instead of printing the plain report.';
COMMENT ON COLUMN report.against_run_id IS 'The impact report''s baseline run, possibly another project''s; readable by the requester at insert (report_enqueue). NULL for a plain report, or once the baseline is deleted.';

-- Latest definition: 023_reports.sql. Adds the baseline's checks.
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
		RETURN NEW;
	END
	$$;

-- ---------------------------------------------------------------------------
-- Render tokens
-- ---------------------------------------------------------------------------

-- CASCADE: a token for a deleted baseline opens nothing worth printing.
ALTER TABLE render_token ADD COLUMN against_run_id uuid REFERENCES model_run(id) ON DELETE CASCADE;
CREATE INDEX render_token_against_run_idx ON render_token (against_run_id);

COMMENT ON COLUMN render_token.against_run_id IS 'An impact report''s baseline run (082): the one other run the render session may compare against. Readable by the issuer at issue (render_token_issue).';

-- Latest definition: 023_reports.sql. Adds the baseline's check.
CREATE OR REPLACE FUNCTION render_token_issue() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
	BEGIN
		IF uid IS NULL THEN
			RAISE EXCEPTION 'a render token needs a signed-in user' USING ERRCODE = 'insufficient_privilege';
		END IF;
		NEW.user_id := uid;
		NEW.purpose := 'report';
		NEW.created_at := now();
		NEW.expires_at := now() + interval '5 minutes';
		-- The policy checks this too; saying it first keeps a stranger's
		-- refusal "not permitted" rather than "no such run".
		IF NOT app_has_role(NEW.project_id, 'viewer') THEN
			RAISE EXCEPTION 'not permitted' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF NOT EXISTS (SELECT 1 FROM model_run r WHERE r.id = NEW.run_id AND r.project_id = NEW.project_id) THEN
			RAISE EXCEPTION 'the run is not one of the project''s' USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.against_run_id IS NOT NULL THEN
			IF NOT EXISTS (SELECT 1 FROM model_run r WHERE r.id = NEW.against_run_id AND app_has_role(r.project_id, 'viewer')) THEN
				RAISE EXCEPTION 'not permitted' USING ERRCODE = 'insufficient_privilege';
			END IF;
			IF NEW.against_run_id = NEW.run_id THEN
				RAISE EXCEPTION 'the baseline is the run itself' USING ERRCODE = 'check_violation';
			END IF;
		END IF;
		RETURN NEW;
	END
	$$;

-- Latest definition: 023_reports.sql. Its result gains the baseline and the
-- baseline's project, so the return type changes: drop and create, and grant
-- again as 023 did.
DROP FUNCTION app_consume_render_token(bytea);
CREATE FUNCTION app_consume_render_token(p_hash bytea)
	RETURNS TABLE (user_id uuid, project_id uuid, run_id uuid, against_project_id uuid, against_run_id uuid)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_user uuid;
		v_project uuid;
		v_run uuid;
		v_against uuid;
		v_expires timestamptz;
	BEGIN
		DELETE FROM render_token t WHERE t.token_hash = p_hash AND t.purpose = 'report'
			RETURNING t.user_id, t.project_id, t.run_id, t.against_run_id, t.expires_at INTO v_user, v_project, v_run, v_against, v_expires;
		DELETE FROM render_token t WHERE t.expires_at < now() - interval '1 day';
		IF v_user IS NULL OR v_expires <= now() THEN
			RETURN;
		END IF;
		RETURN QUERY SELECT v_user, v_project, v_run, (SELECT r.project_id FROM model_run r WHERE r.id = v_against), v_against;
	END
	$$;
REVOKE ALL ON FUNCTION app_consume_render_token(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_consume_render_token(bytea) TO water_app;
