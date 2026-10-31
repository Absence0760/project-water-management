-- 296_feed_area_replace — a feed re-reads its whole record over new cells
-- (WP-2.10, found in #326 B-rain; docs/architecture.md § Data feeds,
-- docs/data-model.md § Series provenance).
--
-- A gridded feed's days are the weighted mean of its cells, so a feed given
-- new cells (the catchment boundary's, a redrawn boundary, another box) must
-- never splice the new area's days onto the old area's record. Until now new
-- cells went only to a feed whose series held nothing, else to a new feed in
-- a separate series. Now an owner may confirm an **area replacement**: the
-- feed backfills its whole record over the new cells into its stage
-- (feed_stage, 032), and the ingest swaps it in whole once caught up, as the
-- version replacement of issue #40c does. Unlike that one the series keeps
-- its product and version, and only the feed's own days are replaced: a day a
-- person wrote or edited (not in feed_days, 031; hand_days, 212) stays as it
-- is, as every feed merge keeps it.
--
-- In this file:
--  * data_feed.replace_series_from takes a second form, 'area:<product/version>'
--    ('area:' for a feed whose series carry no version, agera5_et0): the
--    owner confirmed re-reading the record over the feed's new cells
--    (feeds/routes.ts areaCheck). No column change: its 64-character CHECK
--    holds it.
--  * data_feed.replace_config_from: the feed's config before that
--    confirmation, the cells its record was read over, so withdrawing the
--    replacement puts them back rather than leaving the new cells to merge
--    into the old record. Only with an area confirmation (CHECK), cleared
--    with it (data_feed_stamp below, app_feed_replace_done). Owners write
--    data_feed (018's policies); the existing grants cover the column.
--  * feed_stage.product / product_version may be NULL (both or neither), for
--    a source whose series carry no version (agera5_et0).
--  * feed_stage.agera5_days / power_days: which reference ET product each
--    staged day came from (292_feed_et0_product_days), so the swap rebuilds
--    the series' feed_agera5_days / feed_power_days with the record rather
--    than leaving them unknown.
--
-- No new table, policy or foreign key; feed_stage's RLS (032) and grants
-- cover the new columns. Expand only: every existing row reads as before
-- (replace_config_from NULL, the product days NULL).

ALTER TABLE data_feed
	ADD COLUMN replace_config_from jsonb CHECK (replace_config_from IS NULL OR jsonb_typeof(replace_config_from) = 'object'),
	ADD CONSTRAINT data_feed_replace_config_from_area CHECK (replace_config_from IS NULL OR replace_series_from LIKE 'area:%');

COMMENT ON COLUMN data_feed.replace_series_from IS
	'An owner confirmed this feed may replace its target series while the series holds this product/version (032; '''' = not recorded), or, as ''area:<product/version>'', re-read its whole record over its new cells (296). Cleared by app_feed_replace_done once replaced, and by re-targeting.';
COMMENT ON COLUMN data_feed.replace_config_from IS
	'With an area replacement (replace_series_from ''area:…'', 296): the config the series'' record was read over, put back when the owner withdraws the replacement. NULL otherwise.';

ALTER TABLE feed_stage
	ALTER COLUMN product DROP NOT NULL,
	ALTER COLUMN product_version DROP NOT NULL,
	ADD CONSTRAINT feed_stage_provenance CHECK ((product IS NULL) = (product_version IS NULL)),
	ADD COLUMN agera5_days datemultirange,
	ADD COLUMN power_days datemultirange;

COMMENT ON COLUMN feed_stage.agera5_days IS
	'The staged days an agera5_et0 feed read from AgERA5 (296), swapped in as the series'' feed_agera5_days (292). NULL = none.';
COMMENT ON COLUMN feed_stage.power_days IS
	'The staged days an agera5_et0 feed read from NASA POWER (296), swapped in as the series'' feed_power_days (292). NULL = none.';

-- From 032_series_provenance.sql's definition (the latest), plus: the config
-- an area replacement started from goes with its confirmation (a re-target
-- drops both, as does a version confirmation or a withdrawal).
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
		-- The config an area replacement started from lives only as long as its confirmation (296).
		IF NEW.replace_series_from IS NULL OR NEW.replace_series_from NOT LIKE 'area:%' THEN
			NEW.replace_config_from := NULL;
		END IF;
		RETURN NEW;
	END
	$$;

-- From 032's definition, plus the area replacement's starting config (296):
-- the confirmation is used up, and the config it started from with it. The
-- trigger above returns early here (SECURITY DEFINER runs as the owner role),
-- so this clears both itself.
CREATE OR REPLACE FUNCTION app_feed_replace_done(p_feed uuid) RETURNS void
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_project uuid;
	BEGIN
		SELECT f.project_id INTO v_project FROM data_feed f WHERE f.id = p_feed;
		IF v_project IS NULL OR NOT app_has_role(v_project, 'editor') THEN
			RAISE EXCEPTION 'not permitted' USING ERRCODE = 'insufficient_privilege';
		END IF;
		UPDATE data_feed f SET replace_series_from = NULL, replace_config_from = NULL WHERE f.id = p_feed;
	END
	$$;
