-- 104_outlook_triggers_publication — the seasonal outlook's review triggers
-- and its publication to farmers (issue #53 R6 and R5's farmer view E3;
-- docs/model.md §2.15a, docs/data-model.md § Seasonal outlooks, docs/api.md
-- § Seasonal outlooks, docs/design/planning-outputs.md §3.5–3.6).
--
-- In this file:
--  * `seasonal_outlook.review_date` and `.triggers`: an outlook can carry the
--    review-trigger table (the engine's reviewTriggerTable) for a review date
--    inside its season, computed by the same `outlook` job after the outlook
--    itself and stored with it on completion. NULL review date = no table
--    (older outlooks, or one asked for without it). The guard (latest
--    definition: 063) now also clears `triggers` at insert.
--  * `outlook_publication`: the WUA publishes one level of a complete outlook
--    to the project's farmers (the client confirmed farmers see the outlook,
--    O5, issue #90). One current publication per project (ended_at IS NULL);
--    a new one ends the last; the WUA can end one without a successor
--    (withdraw). The newest 12 are kept, as run_publication.
--  * `outlook_publication_farm`: each linked farm's own figures at that level
--    (the engine's FarmOutlookProjection), written with the publication and
--    never changed: what the farm's farmers were shown. A farmer reads only
--    their own farms' rows (app_farm_nodes, 020_farm_scope); the outlook
--    itself stays viewer-only.

-- ---------------------------------------------------------------------------
-- seasonal_outlook: the review triggers
-- ---------------------------------------------------------------------------
ALTER TABLE seasonal_outlook
	ADD COLUMN review_date date,
	-- The engine's ReviewTriggers without each row's whole outlook (outlooks/store.ts StoredTriggers); set on completion.
	ADD COLUMN triggers jsonb CHECK (jsonb_typeof(triggers) = 'object' AND octet_length(triggers::text) <= 8388608),
	-- Inside the season, after its first day: the review re-plans what is left of it.
	ADD CONSTRAINT seasonal_outlook_review_in_season CHECK (review_date IS NULL OR (review_date > decision_date AND review_date <= season_end)),
	ADD CONSTRAINT seasonal_outlook_triggers_need_review CHECK (triggers IS NULL OR review_date IS NOT NULL),
	-- A complete outlook with a review date has its table (which may say why it couldn't be drawn).
	ADD CONSTRAINT seasonal_outlook_triggers_on_complete CHECK (status <> 'complete' OR review_date IS NULL OR triggers IS NOT NULL);

-- Latest definition: 063_seasonal_outlook.sql (066 changed only the complete trigger). Adds: triggers cleared at insert.
CREATE OR REPLACE FUNCTION seasonal_outlook_guard() RETURNS trigger
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
		NEW.triggers := NULL;
		NEW.engine_version := NULL;
		NEW.completed_at := NULL;
		NEW.created_by := uid;
		NEW.created_at := clock_timestamp();
		RETURN NEW;
	END
	$$;

-- The outcome columns, now with the table; the review date is fixed at insert.
GRANT UPDATE (triggers) ON seasonal_outlook TO water_app;

-- ---------------------------------------------------------------------------
-- outlook_publication
-- ---------------------------------------------------------------------------
CREATE TABLE outlook_publication (
	id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id     uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- The outlook it came from; SET NULL when the outlook goes (the API keeps
	-- the newest 20): the farms' rows keep what was shown.
	outlook_id     uuid REFERENCES seasonal_outlook(id) ON DELETE SET NULL,
	-- The level the WUA chose (its id and label in the outlook's `levels`).
	level_id       text NOT NULL CHECK (char_length(level_id) BETWEEN 1 AND 8),
	level_label    text NOT NULL CHECK (char_length(level_label) BETWEEN 1 AND 100),
	-- Copied from the outlook by the guard: the season and review date farmers are told.
	decision_date  date NOT NULL,
	season_end     date NOT NULL,
	review_date    date,
	engine_version text NOT NULL CHECK (char_length(engine_version) BETWEEN 1 AND 40),
	published_by   uuid REFERENCES app_user(id) ON DELETE SET NULL,
	published_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
	-- Ended by a newer publication or withdrawn; NULL = current.
	ended_at       timestamptz,
	ended_by       uuid REFERENCES app_user(id) ON DELETE SET NULL,
	CHECK (season_end >= decision_date)
);
COMMENT ON TABLE outlook_publication IS
	'One level of a seasonal outlook published to the project''s farmers (104, issue #53 R5 E3). One current (ended_at IS NULL) per project; the newest 12 kept.';

CREATE UNIQUE INDEX outlook_publication_current_idx ON outlook_publication (project_id) WHERE ended_at IS NULL;
CREATE INDEX outlook_publication_project_idx ON outlook_publication (project_id, published_at DESC);
CREATE INDEX outlook_publication_outlook_idx ON outlook_publication (outlook_id);
CREATE INDEX outlook_publication_published_by_idx ON outlook_publication (published_by);
CREATE INDEX outlook_publication_ended_by_idx ON outlook_publication (ended_by);

-- The outlook is this project's and complete, the level is one of its
-- levels; the label, season, review date and engine come from it; who and
-- when are stamped. (Whether the level ran, and each farm's figures, the API
-- checks with the engine's farmOutlookProjection.)
CREATE FUNCTION outlook_publication_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
		o seasonal_outlook%ROWTYPE;
		lvl jsonb;
	BEGIN
		IF uid IS NULL THEN
			RAISE EXCEPTION 'a publication needs a signed-in user' USING ERRCODE = 'insufficient_privilege';
		END IF;
		SELECT * INTO o FROM seasonal_outlook WHERE id = NEW.outlook_id;
		IF o.project_id IS DISTINCT FROM NEW.project_id THEN
			RAISE EXCEPTION 'outlook % belongs to a different project', NEW.outlook_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		IF o.status <> 'complete' THEN
			RAISE EXCEPTION 'only a complete outlook can be published' USING ERRCODE = 'check_violation';
		END IF;
		SELECT l INTO lvl FROM jsonb_array_elements(o.levels) l WHERE l ->> 'id' = NEW.level_id;
		IF lvl IS NULL THEN
			RAISE EXCEPTION 'level % is not one of the outlook''s levels', NEW.level_id USING ERRCODE = 'check_violation';
		END IF;
		NEW.level_label := lvl ->> 'label';
		NEW.decision_date := o.decision_date;
		NEW.season_end := o.season_end;
		NEW.review_date := o.review_date;
		NEW.engine_version := o.engine_version;
		NEW.published_by := uid;
		NEW.published_at := clock_timestamp();
		-- Written already ended (as a superseded run_publication may be): by whoever wrote it.
		IF NEW.ended_at IS NOT NULL THEN
			NEW.ended_at := NEW.published_at;
			NEW.ended_by := uid;
		ELSE
			NEW.ended_by := NULL;
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER outlook_publication_guard BEFORE INSERT ON outlook_publication
	FOR EACH ROW EXECUTE FUNCTION outlook_publication_guard();

-- A current publication is ended once, stamped with who and when; after that
-- it is fixed. A foreign key clearing a person (an account going) or the
-- outlook (it was trimmed) passes untouched.
CREATE FUNCTION outlook_publication_end() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	BEGIN
		IF to_jsonb(NEW) - 'published_by' - 'ended_by' - 'outlook_id' = to_jsonb(OLD) - 'published_by' - 'ended_by' - 'outlook_id'
			AND (NEW.published_by IS NULL OR NEW.published_by = OLD.published_by)
			AND (NEW.ended_by IS NULL OR NEW.ended_by IS NOT DISTINCT FROM OLD.ended_by)
			AND (NEW.outlook_id IS NULL OR NEW.outlook_id = OLD.outlook_id) THEN
			RETURN NEW;
		END IF;
		IF OLD.ended_at IS NOT NULL THEN
			RAISE EXCEPTION 'an ended publication is never changed' USING ERRCODE = 'check_violation';
		END IF;
		IF NEW.ended_at IS NULL THEN
			RAISE EXCEPTION 'a publication can only be ended' USING ERRCODE = 'check_violation';
		END IF;
		NEW.ended_at := clock_timestamp();
		NEW.ended_by := app_current_user_id();
		RETURN NEW;
	END
	$$;
CREATE TRIGGER outlook_publication_end BEFORE UPDATE ON outlook_publication
	FOR EACH ROW EXECUTE FUNCTION outlook_publication_end();

-- The newest 12 per project; a current one is never trimmed.
CREATE FUNCTION outlook_publication_cap() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		DELETE FROM outlook_publication WHERE id IN (
			SELECT id FROM outlook_publication
			WHERE project_id = NEW.project_id
			ORDER BY published_at DESC, id DESC
			OFFSET 12
		) AND ended_at IS NOT NULL;
		RETURN NULL;
	END
	$$;
CREATE TRIGGER outlook_publication_cap AFTER INSERT ON outlook_publication
	FOR EACH ROW EXECUTE FUNCTION outlook_publication_cap();

-- Read: every member, farmers included (the page says whether there is one);
-- the figures are in outlook_publication_farm. Write: an editor.
ALTER TABLE outlook_publication ENABLE ROW LEVEL SECURITY;
CREATE POLICY outlook_publication_select ON outlook_publication FOR SELECT USING (app_has_role(project_id, 'farmer'));
CREATE POLICY outlook_publication_insert ON outlook_publication FOR INSERT WITH CHECK (app_has_role(project_id, 'editor'));
CREATE POLICY outlook_publication_update ON outlook_publication FOR UPDATE
	USING (app_has_role(project_id, 'editor') AND ended_at IS NULL)
	WITH CHECK (app_has_role(project_id, 'editor'));

GRANT SELECT, INSERT ON outlook_publication TO water_app;
-- Ending it only: what was published never changes.
GRANT UPDATE (ended_at, ended_by) ON outlook_publication TO water_app;

-- ---------------------------------------------------------------------------
-- outlook_publication_farm
-- ---------------------------------------------------------------------------
CREATE TABLE outlook_publication_farm (
	publication_id uuid NOT NULL REFERENCES outlook_publication(id) ON DELETE CASCADE,
	project_id     uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	node_id        uuid NOT NULL REFERENCES node(id) ON DELETE CASCADE,
	-- FarmOutlookProjection (packages/engine/src/views/farmOutlook.ts): this farm's own figures only.
	view           jsonb NOT NULL CHECK (jsonb_typeof(view) = 'object' AND octet_length(view::text) <= 16384),
	PRIMARY KEY (publication_id, node_id)
);
COMMENT ON TABLE outlook_publication_farm IS
	'One farm''s own figures in an outlook publication (104, issue #53 R5 E3). Append-only: what the farm''s farmers were shown.';
CREATE INDEX outlook_publication_farm_node_idx ON outlook_publication_farm (node_id);
CREATE INDEX outlook_publication_farm_project_idx ON outlook_publication_farm (project_id);

-- The publication is this project's and current; the node is one of its farms.
CREATE FUNCTION outlook_publication_farm_guard() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		p outlook_publication%ROWTYPE;
	BEGIN
		SELECT * INTO p FROM outlook_publication WHERE id = NEW.publication_id;
		IF p.project_id IS DISTINCT FROM NEW.project_id THEN
			RAISE EXCEPTION 'publication % belongs to a different project', NEW.publication_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		IF p.ended_at IS NOT NULL THEN
			RAISE EXCEPTION 'an ended publication takes no new farms' USING ERRCODE = 'check_violation';
		END IF;
		IF NOT EXISTS (SELECT 1 FROM node WHERE id = NEW.node_id AND project_id = NEW.project_id AND kind = 'farm') THEN
			RAISE EXCEPTION 'node % is not a farm of this project', NEW.node_id USING ERRCODE = 'foreign_key_violation';
		END IF;
		RETURN NEW;
	END
	$$;
CREATE TRIGGER outlook_publication_farm_guard BEFORE INSERT ON outlook_publication_farm
	FOR EACH ROW EXECUTE FUNCTION outlook_publication_farm_guard();

ALTER TABLE outlook_publication_farm ENABLE ROW LEVEL SECURITY;
CREATE POLICY outlook_publication_farm_select ON outlook_publication_farm FOR SELECT
	USING (app_has_role(project_id, 'viewer') OR node_id IN (SELECT app_farm_nodes(project_id)));
CREATE POLICY outlook_publication_farm_insert ON outlook_publication_farm FOR INSERT WITH CHECK (app_has_role(project_id, 'editor'));

-- Append-only (catalogue.db.test.ts APPEND_ONLY): it goes with its publication.
GRANT SELECT, INSERT ON outlook_publication_farm TO water_app;
