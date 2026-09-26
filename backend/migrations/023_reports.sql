-- 023_reports — server-side PDF reports: on demand, emailed, and on a
-- schedule (roadmap WP-2.15 Phase B, issue #26; docs/architecture.md §
-- Server-side reports, docs/data-model.md § Reports, docs/security.md §
-- Render tokens).
--
-- A `report_render` job (the queue from 016_jobs.sql) opens the printable
-- report route (/projects/:id/report?run=…) in headless Chromium, waits for
-- data-report-ready and prints it to an A4 PDF, which goes to object storage
-- (MinIO locally, a private S3 bucket in production). Four tables:
--
--   render_token   a single-use, 5-minute credential that lets the headless
--                  browser in, as the requesting user, for ONE project and
--                  ONE run (POST /auth/render-session exchanges it for a
--                  session that can only read that project and run).
--   report         one requested PDF: who asked, which run, who to email,
--                  and the outcome. The PDF itself is in object storage under
--                  a key derived from the ids (reports/<project>/<report>.pdf),
--                  never a stored key, so no row can point at another
--                  project's file.
--   report_schedule, report_schedule_recipient
--                  "send the latest run's report to these members every
--                  Monday at 07:00": the worker's tick queues a render for
--                  each schedule whose time has come, as the schedule's
--                  acting user.
--
-- Who can do what (a farmer, 019_farmer_role, ranks below viewer and so can
-- do none of it: the catchment report is not theirs to read):
--   * Ask for a report (INSERT report, and its report_render job): any viewer
--     of the project, as themselves. The report route already shows a viewer
--     everything the PDF contains. The job table's insert policy is widened
--     for this one kind (below); every other kind still needs an editor.
--   * Read reports and schedules (SELECT): any viewer of the project.
--   * A report's outcome (UPDATE status / pages / bytes / error /
--     finished_at): only its requester, which is who the job runs as.
--   * Schedules and their recipients (INSERT / UPDATE / DELETE): editors and
--     owners. The trigger stamps the saver as the acting user. Recipients
--     must be members of the project, and are checked again at send time.
--   * Render tokens: issued by the requester for a project they can view
--     (INSERT); consumed, and old ones purged, only through the SECURITY
--     DEFINER app_consume_render_token, because the headless browser has no
--     session yet. water_app never UPDATEs or DELETEs one directly.

-- ---------------------------------------------------------------------------
-- Render tokens
-- ---------------------------------------------------------------------------

CREATE TABLE render_token (
	id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	-- The email_token pattern (004_email.sql), with its own purpose; one
	-- purpose today, so a future one is a CHECK change, not a new table.
	purpose    text NOT NULL DEFAULT 'report' CHECK (purpose = 'report'),
	-- SHA-256 of the token. Never the token itself.
	token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
	user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
	project_id uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	run_id     uuid NOT NULL REFERENCES model_run(id) ON DELETE CASCADE,
	expires_at timestamptz NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);
-- Covering indexes for every foreign key (catalogue.db.test.ts).
CREATE INDEX render_token_user_idx ON render_token (user_id);
CREATE INDEX render_token_project_idx ON render_token (project_id);
CREATE INDEX render_token_run_idx ON render_token (run_id);
CREATE INDEX render_token_expires_idx ON render_token (expires_at);

COMMENT ON TABLE render_token IS
	'Single-use, 5-minute credentials for the headless report renderer (019_reports, WP-2.15 Phase B). water_app: SELECT own, INSERT (viewer of the project, as themselves); consumed only through app_consume_render_token.';

-- An issued token is the caller's, for a run of the project, and lives five
-- minutes from now whatever the caller sent.
CREATE FUNCTION render_token_issue() RETURNS trigger
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
		RETURN NEW;
	END
	$$;
CREATE TRIGGER render_token_issue BEFORE INSERT ON render_token
	FOR EACH ROW EXECUTE FUNCTION render_token_issue();

ALTER TABLE render_token ENABLE ROW LEVEL SECURITY;
CREATE POLICY render_token_select ON render_token FOR SELECT USING (user_id = app_current_user_id());
CREATE POLICY render_token_insert ON render_token FOR INSERT
	WITH CHECK (user_id = app_current_user_id() AND app_has_role(project_id, 'viewer'));

GRANT SELECT, INSERT ON render_token TO water_app;

-- Consume a render token: deletes it (single use) and returns what it opens,
-- or no row when it is unknown, already used or expired. Also drops tokens
-- that expired over a day ago, so the table stays small. Runs before anyone
-- is signed in (the browser has only the token), like app_consume_email_token.
CREATE FUNCTION app_consume_render_token(p_hash bytea)
	RETURNS TABLE (user_id uuid, project_id uuid, run_id uuid)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_user uuid;
		v_project uuid;
		v_run uuid;
		v_expires timestamptz;
	BEGIN
		DELETE FROM render_token t WHERE t.token_hash = p_hash AND t.purpose = 'report'
			RETURNING t.user_id, t.project_id, t.run_id, t.expires_at INTO v_user, v_project, v_run, v_expires;
		DELETE FROM render_token t WHERE t.expires_at < now() - interval '1 day';
		IF v_user IS NULL OR v_expires <= now() THEN
			RETURN;
		END IF;
		RETURN QUERY SELECT v_user, v_project, v_run;
	END
	$$;

-- ---------------------------------------------------------------------------
-- Schedules
-- ---------------------------------------------------------------------------

CREATE TABLE report_schedule (
	id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id     uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	frequency      text NOT NULL CHECK (frequency IN ('weekly', 'monthly')),
	-- ISO weekday, 1 = Monday … 7 = Sunday (weekly only).
	weekday        smallint CHECK (weekday BETWEEN 1 AND 7),
	-- 1–28, so every month has the day (monthly only).
	month_day      smallint CHECK (month_day BETWEEN 1 AND 28),
	hour           smallint NOT NULL DEFAULT 7 CHECK (hour BETWEEN 0 AND 23),
	-- IANA zone the hour is in (validated by the API with Intl).
	timezone       text NOT NULL DEFAULT 'Africa/Johannesburg' CHECK (char_length(timezone) BETWEEN 1 AND 64),
	enabled        boolean NOT NULL DEFAULT true,
	acting_user_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
	created_by     uuid REFERENCES app_user(id) ON DELETE SET NULL,
	created_at     timestamptz NOT NULL DEFAULT now(),
	updated_at     timestamptz NOT NULL DEFAULT now(),
	-- A schedule fires only for times after this: saving it doesn't send a
	-- report for a time that has already passed this week or month.
	anchor_at      timestamptz NOT NULL DEFAULT now(),
	-- The scheduled time last queued (app_claim_report_schedule).
	last_fired_for timestamptz,
	-- Why the last scheduled time queued nothing (no runs, the acting user
	-- lost access). Fixed messages from app_report_schedule_failed only.
	last_error     text CHECK (last_error IS NULL OR char_length(last_error) <= 500),
	CHECK ((frequency = 'weekly') = (weekday IS NOT NULL)),
	CHECK ((frequency = 'monthly') = (month_day IS NOT NULL))
);
CREATE INDEX report_schedule_project_idx ON report_schedule (project_id);
CREATE INDEX report_schedule_acting_user_idx ON report_schedule (acting_user_id);
CREATE INDEX report_schedule_created_by_idx ON report_schedule (created_by);

COMMENT ON TABLE report_schedule IS
	'Recurring PDF reports (019_reports, WP-2.15 Phase B). water_app: SELECT (viewer), INSERT/UPDATE/DELETE (editor); last_fired_for / last_error only through app_claim_report_schedule / app_report_schedule_failed.';
COMMENT ON COLUMN report_schedule.acting_user_id IS 'The editor who last saved the schedule. Renders run as this user under RLS. NULL after that account is deleted: the schedule is skipped until an editor saves it.';

-- water_app's writes are stamped: the saver becomes the acting user, and the
-- bookkeeping columns keep their values unless the timing changed (then the
-- schedule starts afresh from now). SECURITY DEFINER bookkeeping passes through.
CREATE FUNCTION report_schedule_stamp() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
	BEGIN
		IF current_user <> 'water_app' THEN
			RETURN NEW;
		END IF;
		IF uid IS NULL THEN
			RAISE EXCEPTION 'a report schedule needs a signed-in user' USING ERRCODE = 'insufficient_privilege';
		END IF;
		NEW.acting_user_id := uid;
		NEW.updated_at := now();
		IF TG_OP = 'INSERT' THEN
			NEW.created_by := uid;
			NEW.created_at := now();
			NEW.anchor_at := now();
			NEW.last_fired_for := NULL;
			NEW.last_error := NULL;
		ELSE
			NEW.id := OLD.id;
			NEW.project_id := OLD.project_id;
			NEW.created_by := OLD.created_by;
			NEW.created_at := OLD.created_at;
			NEW.last_fired_for := OLD.last_fired_for;
			NEW.last_error := OLD.last_error;
			IF (NEW.frequency, NEW.weekday, NEW.month_day, NEW.hour, NEW.timezone, NEW.enabled)
				IS DISTINCT FROM (OLD.frequency, OLD.weekday, OLD.month_day, OLD.hour, OLD.timezone, OLD.enabled) THEN
				NEW.anchor_at := now();
				NEW.last_error := NULL;
			ELSE
				NEW.anchor_at := OLD.anchor_at;
			END IF;
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER report_schedule_stamp BEFORE INSERT OR UPDATE ON report_schedule
	FOR EACH ROW EXECUTE FUNCTION report_schedule_stamp();

ALTER TABLE report_schedule ENABLE ROW LEVEL SECURITY;
CREATE POLICY report_schedule_select ON report_schedule FOR SELECT USING (app_has_role(project_id, 'viewer'));
CREATE POLICY report_schedule_insert ON report_schedule FOR INSERT
	WITH CHECK (app_has_role(project_id, 'editor') AND acting_user_id = app_current_user_id());
CREATE POLICY report_schedule_update ON report_schedule FOR UPDATE
	USING (app_has_role(project_id, 'editor'))
	WITH CHECK (app_has_role(project_id, 'editor') AND acting_user_id = app_current_user_id());
CREATE POLICY report_schedule_delete ON report_schedule FOR DELETE USING (app_has_role(project_id, 'editor'));

GRANT SELECT, INSERT, UPDATE, DELETE ON report_schedule TO water_app;

CREATE TABLE report_schedule_recipient (
	schedule_id uuid NOT NULL REFERENCES report_schedule(id) ON DELETE CASCADE,
	user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
	PRIMARY KEY (schedule_id, user_id)
);
-- The primary key covers schedule_id; this covers user_id.
CREATE INDEX report_schedule_recipient_user_idx ON report_schedule_recipient (user_id);

COMMENT ON TABLE report_schedule_recipient IS
	'Who a scheduled report is emailed to: members of the schedule''s project only (019_reports). Filtered to current members again at send time.';

-- A recipient must be a member of the schedule's project who can read the
-- report (a direct member, the list the Sharing panel shows, viewer or
-- above: a farmer (019_farmer_role) never gets the catchment report): a
-- schedule can't mail project data to an arbitrary account.
CREATE FUNCTION report_schedule_recipient_check() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF NOT EXISTS (
			SELECT 1 FROM report_schedule s JOIN project_member m ON m.project_id = s.project_id
			WHERE s.id = NEW.schedule_id AND m.user_id = NEW.user_id AND m.role >= 'viewer'
		) THEN
			RAISE EXCEPTION 'a report recipient must be a member of the project who can read its report' USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER report_schedule_recipient_check BEFORE INSERT OR UPDATE ON report_schedule_recipient
	FOR EACH ROW EXECUTE FUNCTION report_schedule_recipient_check();

ALTER TABLE report_schedule_recipient ENABLE ROW LEVEL SECURITY;
CREATE POLICY report_schedule_recipient_select ON report_schedule_recipient FOR SELECT USING (
	EXISTS (SELECT 1 FROM report_schedule s WHERE s.id = schedule_id AND app_has_role(s.project_id, 'viewer'))
);
CREATE POLICY report_schedule_recipient_insert ON report_schedule_recipient FOR INSERT WITH CHECK (
	EXISTS (SELECT 1 FROM report_schedule s WHERE s.id = schedule_id AND app_has_role(s.project_id, 'editor'))
);
CREATE POLICY report_schedule_recipient_update ON report_schedule_recipient FOR UPDATE
	USING (EXISTS (SELECT 1 FROM report_schedule s WHERE s.id = schedule_id AND app_has_role(s.project_id, 'editor')))
	WITH CHECK (EXISTS (SELECT 1 FROM report_schedule s WHERE s.id = schedule_id AND app_has_role(s.project_id, 'editor')));
CREATE POLICY report_schedule_recipient_delete ON report_schedule_recipient FOR DELETE USING (
	EXISTS (SELECT 1 FROM report_schedule s WHERE s.id = schedule_id AND app_has_role(s.project_id, 'editor'))
);

GRANT SELECT, INSERT, UPDATE, DELETE ON report_schedule_recipient TO water_app;

-- ---------------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------------

CREATE TABLE report (
	id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id   uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- The run printed. NULL once the run is deleted (trimmed); a report still
	-- queued then fails ("the run was deleted").
	run_id       uuid REFERENCES model_run(id) ON DELETE SET NULL,
	-- The job that renders it; the API addresses a report by this id
	-- (GET /projects/:id/reports/:jobId). NULL once the job is purged.
	job_id       uuid UNIQUE REFERENCES job(id) ON DELETE SET NULL,
	schedule_id  uuid REFERENCES report_schedule(id) ON DELETE SET NULL,
	requested_by uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
	-- Members to email the link to (user ids; resolved to addresses of
	-- current members at send time). Empty = nobody.
	email_to     uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(email_to) <= 50),
	-- queued → rendering (production: handed to the renderer Lambda) → done,
	-- or failed when the renderer Lambda answers with a failure. A render
	-- that fails in the worker itself is recorded on the job (retried, then
	-- dead with its sanitised reason); the API reports the two together.
	status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'rendering', 'done', 'failed')),
	pages        integer CHECK (pages IS NULL OR pages >= 0),
	bytes        integer CHECK (bytes IS NULL OR bytes >= 0),
	-- Why the renderer failed, or the email step after a good render: our own
	-- text (reports/render.ts, reports/store.ts), never a transport or
	-- database message.
	error        text CHECK (error IS NULL OR char_length(error) <= 500),
	created_at   timestamptz NOT NULL DEFAULT now(),
	finished_at  timestamptz,
	CHECK ((status IN ('done', 'failed')) = (finished_at IS NOT NULL))
);
-- job_id is covered by its unique constraint.
CREATE INDEX report_project_idx ON report (project_id, created_at DESC);
CREATE INDEX report_run_idx ON report (run_id);
CREATE INDEX report_schedule_idx ON report (schedule_id);
CREATE INDEX report_requested_by_idx ON report (requested_by, created_at DESC);
CREATE INDEX report_created_idx ON report (created_at);

COMMENT ON TABLE report IS
	'Requested PDF reports (019_reports, WP-2.15 Phase B). The PDF is at reports/<project_id>/<id>.pdf in the reports bucket (7-day lifecycle); the row goes after 8 days (app_purge_reports). water_app: SELECT (viewer), INSERT (viewer, as themselves), UPDATE of the outcome columns and DELETE by the requester.';

-- A new report is queued, by the signed-in user, now.
CREATE FUNCTION report_enqueue() RETURNS trigger
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
		RETURN NEW;
	END
	$$;
CREATE TRIGGER report_enqueue BEFORE INSERT ON report
	FOR EACH ROW EXECUTE FUNCTION report_enqueue();

ALTER TABLE report ENABLE ROW LEVEL SECURITY;
CREATE POLICY report_select ON report FOR SELECT USING (app_has_role(project_id, 'viewer'));
CREATE POLICY report_insert ON report FOR INSERT
	WITH CHECK (app_has_role(project_id, 'viewer') AND requested_by = app_current_user_id());
CREATE POLICY report_update ON report FOR UPDATE
	USING (requested_by = app_current_user_id() AND app_has_role(project_id, 'viewer'))
	WITH CHECK (requested_by = app_current_user_id() AND app_has_role(project_id, 'viewer'));
CREATE POLICY report_delete ON report FOR DELETE USING (requested_by = app_current_user_id());

-- The outcome only: which project, run, job, requester and recipients a
-- report has is fixed at insert.
GRANT SELECT, INSERT, DELETE ON report TO water_app;
GRANT UPDATE (status, pages, bytes, error, finished_at) ON report TO water_app;

-- ---------------------------------------------------------------------------
-- Jobs: a viewer may queue a report render (and nothing else)
-- ---------------------------------------------------------------------------

-- Latest definition: 016_jobs.sql.
DROP POLICY job_insert ON job;
CREATE POLICY job_insert ON job FOR INSERT
	WITH CHECK (
		(app_has_role(project_id, 'editor') OR (kind = 'report_render' AND app_has_role(project_id, 'viewer')))
		AND acting_user_id = app_current_user_id()
	);

-- ---------------------------------------------------------------------------
-- The worker's side (no user context, crossing projects)
-- ---------------------------------------------------------------------------

-- Every enabled schedule with an acting user, with what the tick needs to
-- decide whether it is due (reports/schedule.ts). Routing and timing only.
CREATE FUNCTION app_report_schedules_to_check()
	RETURNS TABLE (id uuid, project_id uuid, acting_user_id uuid, frequency text, weekday smallint, month_day smallint,
		hour smallint, timezone text, anchor_at timestamptz, last_fired_for timestamptz)
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT s.id, s.project_id, s.acting_user_id, s.frequency, s.weekday, s.month_day, s.hour, s.timezone, s.anchor_at, s.last_fired_for
		FROM report_schedule s
		WHERE s.enabled AND s.acting_user_id IS NOT NULL
		ORDER BY s.id
		LIMIT 1000
	$$;

-- Claim one scheduled time for a schedule: true only for the first caller,
-- for a time that has come, is after the schedule was saved, and is later
-- than the last one claimed. Two workers can't both queue the same time.
CREATE FUNCTION app_claim_report_schedule(p_id uuid, p_fire timestamptz) RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		UPDATE report_schedule s SET last_fired_for = p_fire, last_error = NULL
		WHERE s.id = p_id AND s.enabled AND s.acting_user_id IS NOT NULL
		  AND p_fire <= now() AND p_fire > s.anchor_at
		  AND (s.last_fired_for IS NULL OR s.last_fired_for < p_fire);
		RETURN FOUND;
	END
	$$;

-- A claimed time that queued nothing, and why (a fixed reason chosen by the
-- tick: never raw database text).
CREATE FUNCTION app_report_schedule_failed(p_id uuid, p_reason text) RETURNS void
	LANGUAGE sql SECURITY DEFINER SET search_path = public
	AS $$
		UPDATE report_schedule SET last_error = left(p_reason, 500) WHERE id = p_id
	$$;

-- Production: the renderer Lambda answers on the `render-results` queue with
-- no user context (lambda-worker.ts). This names the project and requester
-- of a report that is waiting for a render, so the worker can queue the
-- follow-up as that user under RLS. Nothing for a report that isn't waiting.
CREATE FUNCTION app_report_render_target(p_report uuid)
	RETURNS TABLE (project_id uuid, requested_by uuid)
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT r.project_id, r.requested_by FROM report r
		WHERE r.id = p_report AND r.status IN ('queued', 'rendering')
	$$;

-- Delete reports older than p_age (at least a day; the tick passes 8 days,
-- a day past the bucket's 7-day lifecycle). Returns the deleted rows' ids,
-- so a local run can delete their objects too.
CREATE FUNCTION app_purge_reports(p_age interval)
	RETURNS TABLE (project_id uuid, id uuid)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF p_age IS NULL OR p_age < interval '1 day' THEN
			RAISE EXCEPTION 'purge only reports at least a day old' USING ERRCODE = 'invalid_parameter_value';
		END IF;
		RETURN QUERY DELETE FROM report r WHERE r.created_at < now() - p_age RETURNING r.project_id, r.id;
	END
	$$;

REVOKE ALL ON FUNCTION app_consume_render_token(bytea), app_report_schedules_to_check(), app_claim_report_schedule(uuid, timestamptz),
	app_report_schedule_failed(uuid, text), app_report_render_target(uuid), app_purge_reports(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_consume_render_token(bytea), app_report_schedules_to_check(), app_claim_report_schedule(uuid, timestamptz),
	app_report_schedule_failed(uuid, text), app_report_render_target(uuid), app_purge_reports(interval) TO water_app;
