-- 032_series_provenance — which product and version a series holds, and the
-- CHIRPS feed's version guard (issue #40 part c; docs/data-model.md § Series
-- provenance, docs/architecture.md § Data feeds).
--
-- CHIRPS v2 and v3 differ by an era-dependent factor. A b023 workbook's CHIRPS
-- column is usually v2; the CHIRPS feed writes v3. Merging one into the other
-- makes a break in the record that the double-mass check then blames on the
-- catchment, and the monthly CHIRPS factors (model.md §2.4b) are fitted
-- across the splice. So a series now says what it holds, and a feed refuses
-- to write a different version into it unless an owner has confirmed that it
-- should replace the series whole.
--
-- In this file:
--  * time_series.product / product_version: e.g. ('CHIRPS', '2.0') or
--    ('CHIRPS sat', '3.0'). The product is recorded apart from the version,
--    and a product change counts like a version change: CHIRPS v3.0's two
--    daily products (`sat` from 1998, `rnl` from 1981) disaggregate the same
--    pentads with different daily timing, so a series is one of them end to
--    end, never one spliced onto the other. Both or
--    neither; NULL = not recorded. Set by an upload or import that says it,
--    by a feed that creates or replaces the series, and by PATCH
--    /projects/:id/series/:seriesId (a person saying what an existing series
--    is). water_app's existing table grants and RLS policies cover the new
--    columns.
--  * series_revision.product / product_version: kept with the values, so a
--    restore puts the label back with them. `feed_replace` is a new reason:
--    the values a confirmed feed replacement removed.
--  * data_feed.replace_series_from: an owner's confirmation that the feed may
--    replace its target series, naming what the series held when they
--    confirmed ('CHIRPS/2.0', or '' for a series whose version was not
--    recorded). The ingest replaces only while the series still holds exactly
--    that, so a later upload of something else needs a new confirmation.
--    Confirming restarts the feed's history (as re-targeting does), so it
--    backfills from its start date. app_feed_replace_done clears it once the
--    replacement is made.
--  * feed_stage: a confirmed replacement is **staged**, never written into the
--    live series window by window. The feed's fetches build the new product's
--    record here while the live series keeps its old values and label, so a
--    run in the meantime uses the whole old record, never a partial new one.
--    When the backfill reaches the newest day the ingest swaps it in, in one
--    transaction (values, label, a feed_replace revision, the audit event),
--    and deletes the stage. One row per feed (cascades with it); a new
--    confirmation, withdrawing it, or re-targeting the feed discards it
--    (data_feed_stamp). RLS: viewers read (progress in the panel), editors
--    write (the ingest runs as the feed's acting user, an editor). A replacement is a full backfill: the routes start
--    the feed at the series' first day, and each fetch that stops short of the
--    newest day queues the next window a minute on (feeds/ingest.ts);
--    app_feed_fetch_now lets "Run now" pull that waiting fetch forward.
--  * Backfill: a series some CHIRPS feed already writes is marked CHIRPS sat
--    3.0, the only product the feed has fetched before this migration. Nothing is deployed yet, so
--    this only touches development data; a series that mixed an import with
--    feed days before this migration can't be told apart and is marked too.

ALTER TABLE time_series
	ADD COLUMN product         text CHECK (product ~ '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$'),
	ADD COLUMN product_version text CHECK (product_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$'),
	ADD CONSTRAINT time_series_provenance CHECK ((product IS NULL) = (product_version IS NULL));

COMMENT ON COLUMN time_series.product IS 'The product the values come from, e.g. CHIRPS (032). NULL with product_version = not recorded.';
COMMENT ON COLUMN time_series.product_version IS 'The product version, e.g. 2.0 or 3.0 for CHIRPS (032). A data feed refuses to write another version into the series without an owner''s confirmation.';

ALTER TABLE series_revision
	ADD COLUMN product         text,
	ADD COLUMN product_version text;
ALTER TABLE series_revision DROP CONSTRAINT series_revision_reason_check;
ALTER TABLE series_revision ADD CONSTRAINT series_revision_reason_check CHECK (reason IN ('replace', 'delete', 'manual_merge', 'feed_replace'));

ALTER TABLE data_feed
	ADD COLUMN replace_series_from text CHECK (char_length(replace_series_from) <= 64);

COMMENT ON COLUMN data_feed.replace_series_from IS
	'An owner confirmed this feed may replace its target series while the series holds this product/version (032; '''' = not recorded). Cleared by app_feed_replace_done once replaced, and by re-targeting.';

CREATE TABLE feed_stage (
	feed_id         uuid PRIMARY KEY REFERENCES data_feed(id) ON DELETE CASCADE,
	project_id      uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- The new record so far: values[i] is day start_date + i; NULL = no reading.
	start_date      date NOT NULL,
	"values"        double precision[] NOT NULL CHECK (cardinality("values") <= 60000),
	-- What it will be labelled, and what the live series held when the owner confirmed.
	product         text NOT NULL CHECK (product ~ '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$'),
	product_version text NOT NULL CHECK (product_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$'),
	replace_from    text NOT NULL CHECK (char_length(replace_from) <= 64),
	created_at      timestamptz NOT NULL DEFAULT now(),
	updated_at      timestamptz NOT NULL DEFAULT now()
);
-- Covers the project_id foreign key (feed_id is covered by the primary key).
CREATE INDEX feed_stage_project_idx ON feed_stage (project_id);

COMMENT ON TABLE feed_stage IS
	'A confirmed series replacement being backfilled by its data feed (032): swapped into time_series whole when caught up, so runs never see a partial record. water_app: SELECT (viewer), INSERT/UPDATE/DELETE (editor, for a feed of the same project).';

ALTER TABLE feed_stage ENABLE ROW LEVEL SECURITY;
CREATE POLICY feed_stage_select ON feed_stage FOR SELECT USING (app_has_role(project_id, 'viewer'));
CREATE POLICY feed_stage_insert ON feed_stage FOR INSERT WITH CHECK (
	app_has_role(project_id, 'editor') AND EXISTS (SELECT 1 FROM data_feed f WHERE f.id = feed_stage.feed_id AND f.project_id = feed_stage.project_id)
);
CREATE POLICY feed_stage_update ON feed_stage FOR UPDATE USING (app_has_role(project_id, 'editor')) WITH CHECK (
	app_has_role(project_id, 'editor') AND EXISTS (SELECT 1 FROM data_feed f WHERE f.id = feed_stage.feed_id AND f.project_id = feed_stage.project_id)
);
CREATE POLICY feed_stage_delete ON feed_stage FOR DELETE USING (app_has_role(project_id, 'editor'));

GRANT SELECT, INSERT, UPDATE, DELETE ON feed_stage TO water_app;

UPDATE time_series t SET product = 'CHIRPS sat', product_version = '3.0'
FROM data_feed f
WHERE f.source = 'chirps' AND f.project_id = t.project_id AND f.target_kind = t.kind AND f.target_name = t.name
  AND t.product IS NULL;

-- From 029_feed_fetch.sql's definition (the latest), plus the replace
-- confirmation: re-targeting drops a confirmation the same save didn't give
-- (it named the old series' contents), and a new confirmation restarts the
-- feed's history like a re-target, so it fetches from its start date. Any
-- change to the confirmation, the target or the config discards the feed's
-- staged replacement (feed_stage): it was built for the old one.
CREATE OR REPLACE FUNCTION data_feed_stamp() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
	BEGIN
		IF current_user <> 'water_app' THEN
			RETURN NEW; -- a SECURITY DEFINER health update, or the owner role
		END IF;
		IF uid IS NULL THEN
			RAISE EXCEPTION 'a data feed needs a signed-in user' USING ERRCODE = 'insufficient_privilege';
		END IF;
		NEW.acting_user_id := uid;
		NEW.updated_at := now();
		IF TG_OP = 'INSERT' THEN
			NEW.created_by := uid;
			NEW.created_at := now();
			NEW.last_scheduled_at := NULL;
			NEW.last_attempt_at := NULL;
			NEW.last_success_at := NULL;
			NEW.last_data_date := NULL;
			NEW.last_value := NULL;
			NEW.consecutive_failures := 0;
			NEW.last_error := NULL;
			NEW.last_meta := NULL;
			NEW.fetch_job_id := NULL;
			NEW.fetch_start := NULL;
			NEW.fetch_end := NULL;
		ELSE
			NEW.id := OLD.id;
			NEW.project_id := OLD.project_id;
			NEW.created_by := OLD.created_by;
			NEW.created_at := OLD.created_at;
			NEW.last_attempt_at := OLD.last_attempt_at;
			NEW.last_success_at := OLD.last_success_at;
			NEW.last_value := OLD.last_value;
			NEW.last_meta := OLD.last_meta;
			NEW.last_error := OLD.last_error;
			NEW.fetch_job_id := OLD.fetch_job_id;
			NEW.fetch_start := OLD.fetch_start;
			NEW.fetch_end := OLD.fetch_end;
			IF (NEW.source IS DISTINCT FROM OLD.source OR NEW.target_kind IS DISTINCT FROM OLD.target_kind OR NEW.target_name IS DISTINCT FROM OLD.target_name)
				AND NEW.replace_series_from IS NOT DISTINCT FROM OLD.replace_series_from THEN
				-- The confirmation named what the old target held.
				NEW.replace_series_from := NULL;
			END IF;
			IF NEW.replace_series_from IS DISTINCT FROM OLD.replace_series_from OR NEW.source IS DISTINCT FROM OLD.source
				OR NEW.config IS DISTINCT FROM OLD.config OR NEW.target_kind IS DISTINCT FROM OLD.target_kind
				OR NEW.target_name IS DISTINCT FROM OLD.target_name THEN
				DELETE FROM feed_stage WHERE feed_id = OLD.id;
			END IF;
			IF NEW.source IS DISTINCT FROM OLD.source OR NEW.config IS DISTINCT FROM OLD.config
				OR NEW.target_kind IS DISTINCT FROM OLD.target_kind OR NEW.target_name IS DISTINCT FROM OLD.target_name
				OR (NEW.replace_series_from IS NOT NULL AND NEW.replace_series_from IS DISTINCT FROM OLD.replace_series_from) THEN
				-- A different place or series, or a series about to be replaced:
				-- the feed's data so far says nothing about what it will hold.
				NEW.last_data_date := NULL;
				NEW.last_value := NULL;
				NEW.last_success_at := NULL;
				NEW.last_meta := NULL;
				NEW.last_error := NULL;
				NEW.consecutive_failures := 0;
				NEW.last_scheduled_at := NULL;
				-- An answer for the old settings is dropped anyway (the feed's version changed).
				NEW.fetch_job_id := NULL;
				NEW.fetch_start := NULL;
				NEW.fetch_end := NULL;
			ELSE
				NEW.last_data_date := OLD.last_data_date;
				NEW.consecutive_failures := OLD.consecutive_failures;
				-- Saving (or re-enabling) makes it due now.
				NEW.last_scheduled_at := CASE WHEN NEW.enabled AND NOT OLD.enabled THEN NULL ELSE OLD.last_scheduled_at END;
			END IF;
		END IF;
		RETURN NEW;
	END
	$$;

-- The ingest replaced the feed's target series under an owner's confirmation:
-- the confirmation is used up. As the feed's acting user, who must still be an
-- editor (as for app_record_feed_result); an editor can't write data_feed
-- directly (owners only).
CREATE FUNCTION app_feed_replace_done(p_feed uuid) RETURNS void
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_project uuid;
	BEGIN
		SELECT f.project_id INTO v_project FROM data_feed f WHERE f.id = p_feed;
		IF v_project IS NULL OR NOT app_has_role(v_project, 'editor') THEN
			RAISE EXCEPTION 'not permitted' USING ERRCODE = 'insufficient_privilege';
		END IF;
		UPDATE data_feed f SET replace_series_from = NULL WHERE f.id = p_feed;
	END
	$$;

-- "Run now" when the feed's fetch is already pending but waiting: a
-- backfill's next window (feeds/ingest.ts queues it a minute on, so a long
-- backfill, such as a confirmed replacement's, goes a window at a time rather
-- than a window a day) or a failed fetch's retry. The pending job becomes due
-- now instead of the press doing nothing. water_app can't UPDATE job, so this
-- touches only that feed's pending feed_fetch (its dedupe key), for an editor.
CREATE FUNCTION app_feed_fetch_now(p_feed uuid) RETURNS boolean
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_project uuid;
		v_moved integer;
	BEGIN
		SELECT f.project_id INTO v_project FROM data_feed f WHERE f.id = p_feed;
		IF v_project IS NULL OR NOT app_has_role(v_project, 'editor') THEN
			RAISE EXCEPTION 'not permitted' USING ERRCODE = 'insufficient_privilege';
		END IF;
		UPDATE job j SET run_after = now()
		WHERE j.project_id = v_project AND j.kind = 'feed_fetch' AND j.dedupe_key = 'feed_fetch:' || p_feed::text
		  AND j.status IN ('queued', 'failed') AND j.run_after > now();
		GET DIAGNOSTICS v_moved = ROW_COUNT;
		RETURN v_moved > 0; -- true: a waiting fetch was made due, so wake the worker
	END
	$$;

REVOKE ALL ON FUNCTION app_feed_replace_done(uuid), app_feed_fetch_now(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_feed_replace_done(uuid), app_feed_fetch_now(uuid) TO water_app;
