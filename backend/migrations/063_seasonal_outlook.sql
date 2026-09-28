-- 063_seasonal_outlook — the seasonal outlook as a background job (issue #53
-- R5; docs/model.md §2.15, docs/data-model.md § Seasonal outlooks,
-- docs/api.md § Seasonal outlooks, docs/design/planning-outputs.md §3.5).
--
-- An outlook is one saved base run × a season (a decision date and a season
-- end) × up to 6 demand levels (each a list of `demand.scale` ops, R1),
-- run over every analogue water year of the record: an ESP ensemble from the
-- model's state on the decision date. POST /projects/:id/outlooks writes the
-- outlook and an `outlook` job (the queue, 016_jobs.sql) in one transaction;
-- the job, as the editor who asked and under RLS, picks the analogue years
-- from the base run, runs every level × year as one member (the engine's
-- outlookMemberInput → runModel → outlookMember), stores each member, then
-- the engine's summariseOutlook as the outlook's result. A member the engine
-- refuses is stored as failed and never fails the outlook.
--
-- Not a sweep (062_scenario_sweeps): a sweep member is a whole-record run
-- storing a run summary and series, at most 12 of them; an outlook member is
-- one level in one analogue year, measured over the season only, and an
-- outlook has years × levels of them (up to 240). The same pattern: a row
-- written at the start with everything the result depends on (the base run,
-- the season, the levels, the planning share, fixed by the column grants),
-- then completed once by whoever asked, and never changed after. An outlook
-- goes with its base run (cascade); the API keeps the newest 20 per project.
--
-- In this file:
--  * `job.kind` accepts 'outlook'.
--  * `seasonal_outlook` and `seasonal_outlook_member`, with RLS (viewer
--    read, editor write), grants, covering indexes, and same-project guard
--    triggers. Members are written once, complete, and never updated.

-- ---------------------------------------------------------------------------
-- job: the new kind
-- ---------------------------------------------------------------------------

-- Latest definition: 062_scenario_sweeps.sql.
ALTER TABLE job DROP CONSTRAINT job_kind_check;
ALTER TABLE job ADD CONSTRAINT job_kind_check
	CHECK (kind IN ('feed_fetch', 'feed_ingest', 'rerun', 'alert_eval', 'report_render', 'yield', 'sweep', 'outlook'));

-- ---------------------------------------------------------------------------
-- seasonal_outlook
-- ---------------------------------------------------------------------------
CREATE TABLE seasonal_outlook (
	id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id     uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- The saved run whose state on the decision date every member starts
	-- from and whose record supplies the analogue years. Never a scenario
	-- or forecast run (the guard). The outlook goes with it.
	base_run_id    uuid NOT NULL REFERENCES model_run(id) ON DELETE CASCADE,
	-- The job that computes it; SET NULL when the 30-day purge deletes the job.
	job_id         uuid REFERENCES job(id) ON DELETE SET NULL,
	name           text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
	-- The season: its first day (the state is the end of the day before) and
	-- its last, inclusive; at most 366 days (the engine's OUTLOOK_SEASON_MAX_DAYS).
	decision_date  date NOT NULL,
	season_end     date NOT NULL,
	-- The planning figure's share of analogue years, (0, 1]; NULL = the
	-- engine's DEFAULT_PLANNING_SHARE (pending the client's O6).
	planning_share double precision CHECK (planning_share > 0 AND planning_share <= 1),
	-- The demand levels, as validated by the API (outlooks/schema.ts):
	-- [{ id, label, ops }], 1–6 of them, ops demand.scale only.
	levels         jsonb NOT NULL CHECK (jsonb_typeof(levels) = 'array' AND jsonb_array_length(levels) BETWEEN 1 AND 6 AND octet_length(levels::text) <= 262144),
	-- Analogue water years asked for; NULL = every one the record holds (the engine's outlookAnalogues).
	analogue_years integer[] CHECK (cardinality(analogue_years) BETWEEN 1 AND 200),
	-- pending: written, the job hasn't finished it. complete: `result` holds the summary.
	status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'complete')),
	-- The engine's SeasonalOutlook (summariseOutlook), with the members that
	-- failed and the years left out over the limit; set on completion.
	result         jsonb CHECK (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 8388608),
	-- The engine that ran the members; set on completion.
	engine_version text CHECK (char_length(engine_version) BETWEEN 1 AND 40),
	created_by     uuid REFERENCES app_user(id) ON DELETE SET NULL,
	created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
	completed_at   timestamptz,
	CHECK (season_end >= decision_date AND season_end - decision_date < 366),
	CHECK ((status = 'complete') = (completed_at IS NOT NULL AND engine_version IS NOT NULL AND result IS NOT NULL))
);
COMMENT ON TABLE seasonal_outlook IS
	'A base run × a season × demand levels over the record''s analogue years, run as one outlook job (063_seasonal_outlook, issue #53 R5). Written pending, completed once with its summary by whoever asked.';

-- Covering indexes for every foreign key (catalogue.db.test.ts); the first
-- also serves GET /projects/:id/outlooks (newest first).
CREATE INDEX seasonal_outlook_project_idx ON seasonal_outlook (project_id, created_at DESC);
CREATE INDEX seasonal_outlook_base_run_idx ON seasonal_outlook (base_run_id);
CREATE INDEX seasonal_outlook_job_idx ON seasonal_outlook (job_id);
CREATE INDEX seasonal_outlook_created_by_idx ON seasonal_outlook (created_by);

-- Its base run and job are its own project's; the base run is an ordinary
-- run of the model; who and when are stamped here; it starts pending.
CREATE FUNCTION seasonal_outlook_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
		base model_run%ROWTYPE;
	BEGIN
		IF uid IS NULL THEN
			RAISE EXCEPTION 'an outlook needs a signed-in user' USING ERRCODE = 'insufficient_privilege';
		END IF;
		SELECT * INTO base FROM model_run WHERE id = NEW.base_run_id;
		IF base.project_id IS DISTINCT FROM NEW.project_id THEN
			RAISE EXCEPTION 'run % belongs to a different project', NEW.base_run_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		IF base.scenario_id IS NOT NULL OR base."trigger" = 'forecast' THEN
			RAISE EXCEPTION 'an outlook is based on an ordinary run of the model' USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.job_id IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM job j WHERE j.id = NEW.job_id AND j.project_id = NEW.project_id AND j.kind = 'outlook'
		) THEN
			RAISE EXCEPTION 'job % is not an outlook job of this project', NEW.job_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		NEW.status := 'pending';
		NEW.result := NULL;
		NEW.engine_version := NULL;
		NEW.completed_at := NULL;
		NEW.created_by := uid;
		NEW.created_at := clock_timestamp();
		RETURN NEW;
	END
	$$;
CREATE TRIGGER seasonal_outlook_guard BEFORE INSERT ON seasonal_outlook
	FOR EACH ROW EXECUTE FUNCTION seasonal_outlook_guard();

-- A pending outlook is completed once, by whoever asked for it (its job runs
-- as them); after that it is fixed.
CREATE FUNCTION seasonal_outlook_complete() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF OLD.status <> 'pending' THEN
			RAISE EXCEPTION 'an outlook is completed once and never changed' USING ERRCODE = 'check_violation';
		END IF;
		IF app_current_user_id() IS DISTINCT FROM OLD.created_by THEN
			RAISE EXCEPTION 'only whoever asked for an outlook can complete it' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF NEW.status <> 'complete' THEN
			RAISE EXCEPTION 'a pending outlook can only be completed' USING ERRCODE = 'check_violation';
		END IF;
		NEW.completed_at := clock_timestamp();
		RETURN NEW;
	END
	$$;
CREATE TRIGGER seasonal_outlook_complete BEFORE UPDATE ON seasonal_outlook
	FOR EACH ROW EXECUTE FUNCTION seasonal_outlook_complete();

-- Read: a viewer (farmers and contributors read nothing, as for model_run;
-- the farmer view, E3, waits on the client's O5). Write: an editor, who is
-- who an outlook job runs as.
ALTER TABLE seasonal_outlook ENABLE ROW LEVEL SECURITY;
CREATE POLICY seasonal_outlook_select ON seasonal_outlook FOR SELECT USING (app_has_role(project_id, 'viewer'));
CREATE POLICY seasonal_outlook_insert ON seasonal_outlook FOR INSERT WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY seasonal_outlook_update ON seasonal_outlook FOR UPDATE
	USING (app_has_role(project_id, 'editor') AND status = 'pending')
	WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY seasonal_outlook_delete ON seasonal_outlook FOR DELETE USING (app_has_role(project_id, 'editor'));

GRANT SELECT, INSERT, DELETE ON seasonal_outlook TO water_app;
-- The outcome only: the base run, job, name, season, share, levels and author are fixed at insert.
GRANT UPDATE (status, result, engine_version, completed_at) ON seasonal_outlook TO water_app;

-- ---------------------------------------------------------------------------
-- seasonal_outlook_member
-- ---------------------------------------------------------------------------
CREATE TABLE seasonal_outlook_member (
	id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	outlook_id     uuid NOT NULL REFERENCES seasonal_outlook(id) ON DELETE CASCADE,
	project_id     uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- The level's place in the outlook's `levels`, from 0 (at most 6 levels).
	level_position smallint NOT NULL CHECK (level_position BETWEEN 0 AND 5),
	-- The analogue water year (by the calendar year its 1 October falls in).
	water_year     integer NOT NULL CHECK (water_year BETWEEN 1800 AND 2200),
	-- done: `member` holds the engine's OutlookMember (the season as measured).
	-- failed: the engine refused the member's input, `problems` holds its message.
	status         text NOT NULL CHECK (status IN ('done', 'failed')),
	member         jsonb CHECK (jsonb_typeof(member) = 'object' AND octet_length(member::text) <= 65536),
	problems       jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(problems) = 'array' AND octet_length(problems::text) <= 65536),
	created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
	CHECK ((status = 'done') = (member IS NOT NULL)),
	CHECK (status <> 'failed' OR jsonb_array_length(problems) > 0)
);
COMMENT ON TABLE seasonal_outlook_member IS
	'One demand level in one analogue year of an outlook (063_seasonal_outlook): written once, complete, by the job of whoever asked; never updated.';

-- Covering indexes: the unique index leads with outlook_id.
CREATE UNIQUE INDEX seasonal_outlook_member_idx ON seasonal_outlook_member (outlook_id, level_position, water_year);
CREATE INDEX seasonal_outlook_member_project_idx ON seasonal_outlook_member (project_id);

-- Its outlook is its own project's, still pending, and whoever writes it
-- asked for the outlook (its job runs as them).
CREATE FUNCTION seasonal_outlook_member_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		o seasonal_outlook%ROWTYPE;
	BEGIN
		SELECT * INTO o FROM seasonal_outlook WHERE id = NEW.outlook_id;
		IF o.project_id IS DISTINCT FROM NEW.project_id THEN
			RAISE EXCEPTION 'outlook % belongs to a different project', NEW.outlook_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		IF o.status <> 'pending' THEN
			RAISE EXCEPTION 'a complete outlook takes no new members' USING ERRCODE = 'check_violation';
		END IF;
		IF app_current_user_id() IS DISTINCT FROM o.created_by THEN
			RAISE EXCEPTION 'only whoever asked for an outlook can store its members' USING ERRCODE = 'insufficient_privilege';
		END IF;
		NEW.created_at := clock_timestamp();
		RETURN NEW;
	END
	$$;
CREATE TRIGGER seasonal_outlook_member_guard BEFORE INSERT ON seasonal_outlook_member
	FOR EACH ROW EXECUTE FUNCTION seasonal_outlook_member_guard();

ALTER TABLE seasonal_outlook_member ENABLE ROW LEVEL SECURITY;
CREATE POLICY seasonal_outlook_member_select ON seasonal_outlook_member FOR SELECT USING (app_has_role(project_id, 'viewer'));
CREATE POLICY seasonal_outlook_member_insert ON seasonal_outlook_member FOR INSERT WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY seasonal_outlook_member_delete ON seasonal_outlook_member FOR DELETE USING (app_has_role(project_id, 'editor'));

-- Written once: no UPDATE, table or column (catalogue.db.test.ts NO_UPDATE).
GRANT SELECT, INSERT, DELETE ON seasonal_outlook_member TO water_app;
