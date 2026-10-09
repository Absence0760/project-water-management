-- 209_unit_rain_series — a rain series of a hydrological unit's own, and the
-- unit's MAP (issue #482 part B; docs/model.md §2.4h, docs/data-model.md §
-- Unit rain series).
--
-- Until now time_series.site_node_id (084_gauge_records) was allowed only on
-- a flow record: rain and evaporation were the catchment's. A land unit (a
-- farm node) may now have its own rain too: its own gauge
-- (rain_catchment_mm) or its own area-weighted CHIRPS (rain_chirps_mm, the
-- from-units feeds, feeds/fromUnits.ts). A run gives such a series to the
-- engine under `<kind>@<node id>` (engine unitRainSeriesKey,
-- runs/execute.ts loadLiveInput), which reads it only under
-- settings.unitRain `perUnit`; the catchment's rain stays the series with no
-- site, so a project that never sets one runs exactly as before.
--
-- * The kind CHECK (084's time_series_site_flow_only, from its only
--   definition) now also takes the two rain kinds. Flow kinds are unchanged.
-- * A rain series' site is a farm node of the same project
--   (time_series_site_land_unit). The same-project check is 084's trigger,
--   which already fires on site_node_id; this one adds the node's kind. Like
--   084 it checks on write only: the series outlives its node (a plain uuid,
--   no foreign key, for the reasons 084 gives), and a run leaves out and warns
--   about a unit key whose node is gone or no longer a land unit. The API also
--   asks for an area above 0 (series/routes.ts setSite).
-- * A unit's CHIRPS feed (data_feed.config.unit, feeds/config.ts UnitMark)
--   writes a series sited at its unit (time_series_site_from_feed). The
--   from-units route creates that series with its site before the first fetch;
--   if someone deletes it, the feed's next fetch creates it again, and this
--   trigger gives it back its site, so the unit's rain can never quietly
--   become the catchment's (a series the feed creates has feed_id set: the
--   merge and the replace both insert with it, series/merge.ts, series/replace.ts).
--   It runs before the land-unit and same-project checks (triggers fire in
--   name order), which then check the site it set. Only a new series: a
--   merge's upsert fires BEFORE INSERT triggers on an existing row too, and
--   that row keeps its own site. The ingest refuses a unit feed whose unit is
--   no longer a land unit before it writes (feeds/unitFeed.ts), so this check
--   never fails a fetch with database text.
-- * node.map_mm / node.map_source: the unit's mean annual precipitation, mm,
--   and where it came from. Bounds as the engine's MAP_MM_MIN / MAP_MM_MAX
--   (1–12 000) and PE_SOURCE_MAX (600); a MAP needs its source (engine
--   mapMmError, which the API applies). NULL (every existing row) = none, so
--   every stored model runs as before.
--
-- Columns on existing project tables (001's node and time_series): their RLS
-- policies, same-project triggers and table grants to water_app already cover
-- them; no new foreign key, so no new index. The two new functions are
-- SECURITY INVOKER with a pinned search_path: they read node and data_feed
-- under the writer's RLS, and anyone who may write a project's series
-- (an editor, or an API key with series:write) may read both. Expand only:
-- older code writes rows that pass every new check (it sets no rain site).

ALTER TABLE time_series DROP CONSTRAINT time_series_site_flow_only;
ALTER TABLE time_series ADD CONSTRAINT time_series_site_kind
	CHECK (site_node_id IS NULL OR kind IN ('flow_observed_m3s', 'flow_logger_m3s', 'rain_catchment_mm', 'rain_chirps_mm'));

COMMENT ON COLUMN time_series.site_node_id IS
	'The node a series belongs to (084_gauge_records, 209_unit_rain_series): a flow record''s gauge (engine >= 1.4.0), or a land unit''s own rain (a farm node, engine unitRainSeriesKey); NULL = the outlet''s record / the catchment''s rain. A plain uuid: the series outlives the node, and the run warns.';

CREATE FUNCTION time_series_site_land_unit() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	DECLARE
		k text;
	BEGIN
		IF NEW.site_node_id IS NULL OR NEW.kind NOT IN ('rain_catchment_mm', 'rain_chirps_mm') THEN
			RETURN NEW;
		END IF;
		SELECT n.kind::text INTO k FROM node n WHERE n.id = NEW.site_node_id AND n.project_id = NEW.project_id;
		IF k IS DISTINCT FROM 'farm' THEN
			RAISE EXCEPTION 'a unit''s own rain belongs to a land unit (a farm node) of the project' USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END
	$$;

CREATE TRIGGER time_series_site_land_unit BEFORE INSERT OR UPDATE OF site_node_id, kind ON time_series
	FOR EACH ROW EXECUTE FUNCTION time_series_site_land_unit();

CREATE FUNCTION time_series_site_from_feed() RETURNS trigger
	LANGUAGE plpgsql SET search_path = public
	AS $$
	DECLARE
		unit text;
	BEGIN
		IF NEW.site_node_id IS NOT NULL OR NEW.feed_id IS NULL OR NEW.kind NOT IN ('rain_catchment_mm', 'rain_chirps_mm') THEN
			RETURN NEW;
		END IF;
		-- A merge is INSERT … ON CONFLICT DO UPDATE, and a BEFORE INSERT trigger fires before the conflict is found: a
		-- series that already exists keeps its own site (the update doesn't touch it), so only a new one is sited here.
		IF EXISTS (SELECT 1 FROM time_series t WHERE t.project_id = NEW.project_id AND t.kind = NEW.kind AND t.name = NEW.name) THEN
			RETURN NEW;
		END IF;
		SELECT f.config -> 'unit' ->> 'nodeId' INTO unit
		FROM data_feed f WHERE f.id = NEW.feed_id AND f.project_id = NEW.project_id AND f.source = 'chirps';
		IF unit ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
			NEW.site_node_id := unit::uuid;
		END IF;
		RETURN NEW;
	END
	$$;

CREATE TRIGGER time_series_site_from_feed BEFORE INSERT ON time_series
	FOR EACH ROW EXECUTE FUNCTION time_series_site_from_feed();

ALTER TABLE node
	ADD COLUMN map_mm double precision
		CONSTRAINT node_map_mm_range CHECK (map_mm IS NULL OR (map_mm >= 1 AND map_mm <= 12000)),
	ADD COLUMN map_source text
		CONSTRAINT node_map_source_text CHECK (map_source IS NULL OR (char_length(map_source) BETWEEN 1 AND 600 AND map_source ~ '\S')),
	ADD CONSTRAINT node_map_mm_needs_source CHECK (map_mm IS NULL OR map_source IS NOT NULL);

COMMENT ON COLUMN node.map_mm IS
	'A land unit''s mean annual precipitation, mm (1-12000; 209_unit_rain_series, issue #482); NULL = none. Under settings.unitRain perUnit it sets the level of the unit''s own rain (docs/model.md 2.4h).';
COMMENT ON COLUMN node.map_source IS
	'Where node.map_mm came from (a dataset or study, and its period; at most 600 characters). Required with a MAP.';
