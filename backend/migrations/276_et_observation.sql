-- 276_et_observation — observed actual evapotranspiration (ETa) per unit and
-- dekad, from satellites, the independent check on a unit's modelled
-- irrigation use (issue #623; docs/data-model.md § Observed actual ET,
-- docs/data-sources.md § Observed actual evapotranspiration).
--
-- In this file:
--  * et_observation: one row per unit (a node of kind 'farm' with farm
--    parcels), source and dekad: the area-weighted mean ETa over the unit's
--    parcels (mm/day), the share of that area with a valid pixel, the area
--    and mask the mean covers ('cropland': parcels ∩ WorldCover cropland;
--    'parcel': the whole parcels, where no land cover is loaded), and where
--    it came from (the upstream file, its ETag, the product version) with a
--    revision that counts the times the values changed. Sources: 'wapor'
--    (FAO WaPOR v3 L2-AETI-D, 100 m, from 2018) and 'ssebop' (USGS FEWS NET
--    SSEBop v6, 1 km, from 2012, the fallback).
--  * et_observation_load_mark: per (source, unit), what the worker last
--    loaded (the status file's lastGood, the file's fetchedAt), a failure,
--    and when the unit's parcels last changed. Worker only: RLS on, no
--    policy, no privilege for water_app (the functions below read and write
--    it), like dam_observation_load_mark (261).
--  * Writers: only the SECURITY DEFINER functions below, from the worker's
--    session with no user (245 mirror_worker_context). water_app holds
--    SELECT on et_observation and nothing else. Nothing calls them yet: the
--    fetcher's et-dekadal mode, the handover and the tick are #623 step 4.
--  * Changing a unit's parcels: inserting, deleting or redrawing a
--    farm_parcel feature, or moving one to another node, drops the unit's
--    observations (each was a mean over the old parcels) and marks both
--    sources' load marks as changed now, clearing what was loaded, so the
--    next pass reads the unit again and a file fetched before the change is
--    refused (et_parcels_changed). A rename doesn't.
--  * RLS: a project's viewers and above read its observations; a farmer or
--    contributor reads their own units' only, through app_farm_nodes (020),
--    never a neighbour's.
--  * Same project: assert_same_project('node_id') (its node branch, latest
--    definition 198), and node_id → node ON DELETE CASCADE, so the rows go
--    with their unit. Covering indexes on every foreign key.
--  * Nothing here feeds the engine: the comparison reads run output only
--    (#623 step 5), so there is no ENGINE_VERSION change.

-- ---------------------------------------------------------------------------
-- et_observation
-- ---------------------------------------------------------------------------
CREATE TABLE et_observation (
	id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id       uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- The unit (a node of kind 'farm'); its parcels are the area read.
	node_id          uuid NOT NULL REFERENCES node(id) ON DELETE CASCADE,
	source           text NOT NULL CHECK (source IN ('wapor', 'ssebop')),
	-- The dekad's first day: the 1st, 11th or 21st of a month. SSEBop v6 starts in 2012, WaPOR v3 in 2018.
	dekad            date NOT NULL CHECK (dekad BETWEEN date '2012-01-01' AND date '2200-12-21' AND extract(day FROM dekad) IN (1, 11, 21)),
	-- The area-weighted mean actual ET over the valid part of the area, mm/day (WaPOR's int16 × 0.1 tops out near 3277).
	eta_mm_day       double precision NOT NULL CHECK (eta_mm_day >= 0 AND eta_mm_day <= 50),
	-- The share of the area with a valid pixel that dekad (not nodata), 0–1. Read eta_mm_day with it.
	valid_share      double precision NOT NULL CHECK (valid_share >= 0 AND valid_share <= 1),
	-- The area the mean covers, m², and which: the parcels ∩ cropland, or the whole parcels.
	area_m2          double precision NOT NULL CHECK (area_m2 > 0 AND area_m2 < 1e11),
	mask             text NOT NULL CHECK (mask IN ('cropland', 'parcel')),
	-- Provenance: the upstream file (its name or key), its ETag when it had one, and the product version.
	upstream_file    text NOT NULL CHECK (char_length(upstream_file) BETWEEN 1 AND 300 AND upstream_file ~ '^[!-~]+$'),
	upstream_etag    text CHECK (upstream_etag IS NULL OR (char_length(upstream_etag) BETWEEN 1 AND 200 AND upstream_etag ~ '^[!-~](?:[ -~]*[!-~])?$')),
	upstream_version text NOT NULL CHECK (char_length(upstream_version) BETWEEN 1 AND 50 AND upstream_version ~ '^[!-~]+$'),
	-- 1 when first loaded; +1 each time a load changes the row (FAO rewrites files in place: a new ETag, a re-read).
	revision         integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
	loaded_at        timestamptz NOT NULL DEFAULT now(),
	UNIQUE (node_id, source, dekad)
);
-- The unique key leads with node_id, so it covers that foreign key.
CREATE INDEX et_observation_project_idx ON et_observation (project_id);

COMMENT ON TABLE et_observation IS
	'Observed actual ET per unit, source and dekad (276, issue #623): the area-weighted mean over the unit''s parcels (∩ cropland where loaded), the valid share and the upstream file. Written only by app_et_observation_load (the worker); dropped when the unit''s parcels change.';
COMMENT ON COLUMN et_observation.valid_share IS
	'The share of the area with a valid pixel that dekad, 0–1. eta_mm_day is the mean over that part only.';

CREATE TRIGGER et_observation_same_project BEFORE INSERT OR UPDATE ON et_observation
	FOR EACH ROW EXECUTE FUNCTION assert_same_project('node_id');

-- ---------------------------------------------------------------------------
-- et_observation_load_mark
-- ---------------------------------------------------------------------------
-- What the worker last loaded per (source, unit). Owner only (the catalogue
-- test's OWNER_ONLY): water_app holds no privilege; app_et_load_marks and
-- app_et_load_mark_write are its only way in, and et_parcels_changed writes
-- parcels_changed_at.
CREATE TABLE et_observation_load_mark (
	source             text NOT NULL CHECK (source IN ('wapor', 'ssebop')),
	node_id            uuid NOT NULL REFERENCES node(id) ON DELETE CASCADE,
	-- The status file's lastGood for the unit when it was last read, and the file's fetchedAt last loaded.
	last_good          timestamptz,
	fetched_at         timestamptz,
	-- The last attempt failed (cleared by the next success): the tick takes such units after the others.
	failed_at          timestamptz,
	-- When the unit's parcels last changed: a file fetched before it is refused.
	parcels_changed_at timestamptz,
	updated_at         timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (source, node_id)
);
CREATE INDEX et_observation_load_mark_node_idx ON et_observation_load_mark (node_id);
COMMENT ON TABLE et_observation_load_mark IS
	'Per source and unit, what the ET tick last loaded, a failure, and when the unit''s parcels last changed (276). Owner only; the worker reads and writes it through app_et_load_marks and app_et_load_mark_write.';
ALTER TABLE et_observation_load_mark ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON et_observation_load_mark FROM water_app;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE et_observation ENABLE ROW LEVEL SECURITY;
CREATE POLICY et_observation_select ON et_observation FOR SELECT USING (app_has_role(project_id, 'viewer'));
-- A farmer or contributor: their own units only (crop_area_select_farmer, 020).
CREATE POLICY et_observation_select_farmer ON et_observation FOR SELECT
	USING (node_id IN (SELECT app_farm_nodes(project_id)));
-- Read only: every write goes through the worker's functions below.
GRANT SELECT ON et_observation TO water_app;

-- ---------------------------------------------------------------------------
-- A unit whose parcels change loses its observations
-- ---------------------------------------------------------------------------
-- Each value was a mean over the old parcels. SECURITY DEFINER: the editor
-- who draws holds no DELETE on et_observation and no privilege on the marks.
-- The unit's row is locked first, as the loader locks it, so a load can't
-- slip stale rows in between. A unit being deleted (its parcels' node_id set
-- null by the cascade) is no longer there to lock or mark: nothing is
-- inserted for it.
CREATE FUNCTION et_parcels_changed() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		n uuid;
	BEGIN
		FOR n IN
			SELECT DISTINCT x FROM unnest(ARRAY[
				CASE WHEN TG_OP <> 'INSERT' AND OLD.kind = 'farm_parcel' THEN OLD.node_id END,
				CASE WHEN TG_OP <> 'DELETE' AND NEW.kind = 'farm_parcel' THEN NEW.node_id END
			]) AS x WHERE x IS NOT NULL
		LOOP
			PERFORM 1 FROM node WHERE id = n FOR NO KEY UPDATE;
			DELETE FROM et_observation WHERE node_id = n;
			INSERT INTO et_observation_load_mark (source, node_id, parcels_changed_at, updated_at)
				SELECT s.source, nd.id, now(), now() FROM node nd CROSS JOIN (VALUES ('wapor'), ('ssebop')) AS s(source) WHERE nd.id = n
				ON CONFLICT (source, node_id) DO UPDATE
					SET parcels_changed_at = now(), last_good = NULL, fetched_at = NULL, updated_at = now();
		END LOOP;
		RETURN NULL;
	END
	$$;
COMMENT ON FUNCTION et_parcels_changed() IS
	'A unit''s farm parcels changed (276): drop its observed ET and mark it to be read again.';
REVOKE ALL ON FUNCTION et_parcels_changed() FROM PUBLIC;
CREATE TRIGGER et_parcels_changed_insert AFTER INSERT ON map_feature
	FOR EACH ROW WHEN (NEW.kind = 'farm_parcel' AND NEW.node_id IS NOT NULL) EXECUTE FUNCTION et_parcels_changed();
CREATE TRIGGER et_parcels_changed_delete AFTER DELETE ON map_feature
	FOR EACH ROW WHEN (OLD.kind = 'farm_parcel' AND OLD.node_id IS NOT NULL) EXECUTE FUNCTION et_parcels_changed();
CREATE TRIGGER et_parcels_changed_update AFTER UPDATE OF geometry, kind, node_id ON map_feature
	FOR EACH ROW WHEN ((OLD.kind = 'farm_parcel' OR NEW.kind = 'farm_parcel')
		AND (OLD.geometry IS DISTINCT FROM NEW.geometry OR OLD.kind IS DISTINCT FROM NEW.kind OR OLD.node_id IS DISTINCT FROM NEW.node_id))
	EXECUTE FUNCTION et_parcels_changed();

-- ---------------------------------------------------------------------------
-- The worker's functions (no user, no API key: 245 mirror_worker_context)
-- ---------------------------------------------------------------------------

-- Load one unit's pass file (#623 step 4's et/<unitKey>.json): its rows, one
-- per dekad. Refused (applied = false) when the node is gone, isn't a unit,
-- has no farm parcels, or its parcels changed after p_fetched_at (when the
-- fetch started), since the file is a mean over parcels that may be gone.
-- Rows are upserted by (unit, source, dekad): a file never removes a row (a
-- pass may cover only the dekads since the newest held); a row whose values
-- and provenance are unchanged isn't rewritten; a changed one is, and its
-- revision goes up by one. `written` counts the rows inserted or changed,
-- `revised` the changed ones among them.
--
-- Bounds (else 23514): a known source and mask; the arrays of one length, at
-- most 2000 rows (55 years of dekads), each a dekad's first day from 2012 to
-- today in UTC and listed once; each mean 0 to 50 mm/day, each share 0 to 1,
-- each area over 0 and under 1e11 m², never NaN; each file 1–300 printable
-- characters, each ETag null or as fileTag keeps one; the version 1–50
-- printable characters; p_fetched_at not in the future. Worker only.
CREATE FUNCTION app_et_observation_load(
	p_source text, p_node_id uuid,
	p_dekads date[], p_eta double precision[], p_valid double precision[], p_area double precision[],
	p_mask text, p_files text[], p_etags text[], p_version text,
	p_fetched_at timestamptz,
	OUT written integer, OUT revised integer, OUT applied boolean
)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		n integer := coalesce(cardinality(p_dekads), 0);
		unit node%ROWTYPE;
		changed timestamptz;
	BEGIN
		IF NOT mirror_worker_context() THEN
			RAISE EXCEPTION 'only the worker loads observed ET' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_source IS NULL OR p_source NOT IN ('wapor', 'ssebop') THEN
			RAISE EXCEPTION 'not an observed ET source' USING ERRCODE = 'check_violation';
		END IF;
		IF p_node_id IS NULL THEN
			RAISE EXCEPTION 'no unit' USING ERRCODE = 'check_violation';
		END IF;
		IF p_mask IS NULL OR p_mask NOT IN ('cropland', 'parcel') THEN
			RAISE EXCEPTION 'not an area mask' USING ERRCODE = 'check_violation';
		END IF;
		IF p_version IS NULL OR char_length(p_version) NOT BETWEEN 1 AND 50 OR p_version !~ '^[!-~]+$' THEN
			RAISE EXCEPTION 'the product version is not 1 to 50 printable characters' USING ERRCODE = 'check_violation';
		END IF;
		IF n > 2000 OR coalesce(cardinality(p_eta), 0) <> n OR coalesce(cardinality(p_valid), 0) <> n OR coalesce(cardinality(p_area), 0) <> n
			OR coalesce(cardinality(p_files), 0) <> n OR coalesce(cardinality(p_etags), 0) <> n
			OR (n > 0 AND (array_ndims(p_dekads) <> 1 OR array_ndims(p_eta) <> 1 OR array_ndims(p_valid) <> 1 OR array_ndims(p_area) <> 1
				OR array_ndims(p_files) <> 1 OR array_ndims(p_etags) <> 1)) THEN
			RAISE EXCEPTION 'the rows are not one dekad, mean, share, area, file and ETag each (at most 2000)' USING ERRCODE = 'check_violation';
		END IF;
		IF p_fetched_at IS NULL OR p_fetched_at > now() + interval '5 minutes' THEN
			RAISE EXCEPTION 'the fetch time is missing or in the future' USING ERRCODE = 'check_violation';
		END IF;
		IF EXISTS (SELECT 1 FROM unnest(p_dekads) d WHERE d IS NULL OR d < date '2012-01-01' OR d > (now() AT TIME ZONE 'UTC')::date OR extract(day FROM d) NOT IN (1, 11, 21)) THEN
			RAISE EXCEPTION 'a dekad is not the first day of one, from 2012 to today' USING ERRCODE = 'check_violation';
		END IF;
		IF (SELECT count(DISTINCT d) FROM unnest(p_dekads) d) <> n THEN
			RAISE EXCEPTION 'a dekad is listed twice' USING ERRCODE = 'check_violation';
		END IF;
		-- NaN and ±Infinity fail these bounds too.
		IF EXISTS (SELECT 1 FROM unnest(p_eta) v WHERE v IS NULL OR NOT (v >= 0 AND v <= 50)) THEN
			RAISE EXCEPTION 'a mean ET is not 0 to 50 mm/day' USING ERRCODE = 'check_violation';
		END IF;
		IF EXISTS (SELECT 1 FROM unnest(p_valid) v WHERE v IS NULL OR NOT (v >= 0 AND v <= 1)) THEN
			RAISE EXCEPTION 'a valid share is not 0 to 1' USING ERRCODE = 'check_violation';
		END IF;
		IF EXISTS (SELECT 1 FROM unnest(p_area) v WHERE v IS NULL OR NOT (v > 0 AND v < 1e11)) THEN
			RAISE EXCEPTION 'an area is not over 0 and under 1e11 m²' USING ERRCODE = 'check_violation';
		END IF;
		IF EXISTS (SELECT 1 FROM unnest(p_files) f WHERE f IS NULL OR char_length(f) NOT BETWEEN 1 AND 300 OR f !~ '^[!-~]+$') THEN
			RAISE EXCEPTION 'a file is not 1 to 300 printable characters' USING ERRCODE = 'check_violation';
		END IF;
		IF EXISTS (SELECT 1 FROM unnest(p_etags) t WHERE t IS NOT NULL AND (char_length(t) NOT BETWEEN 1 AND 200 OR t !~ '^[!-~](?:[ -~]*[!-~])?$')) THEN
			RAISE EXCEPTION 'an ETag is not 1 to 200 printable characters' USING ERRCODE = 'check_violation';
		END IF;

		-- The unit's row is locked first, as et_parcels_changed locks it, so a
		-- parcel change can't commit between the check and the write.
		SELECT * INTO unit FROM node WHERE id = p_node_id FOR NO KEY UPDATE;
		IF unit.id IS NULL OR unit.kind <> 'farm'
			OR NOT EXISTS (SELECT 1 FROM map_feature f WHERE f.node_id = unit.id AND f.kind = 'farm_parcel') THEN
			written := 0; revised := 0; applied := false;
			RETURN;
		END IF;
		SELECT k.parcels_changed_at INTO changed FROM et_observation_load_mark k WHERE k.source = p_source AND k.node_id = unit.id;
		IF changed IS NOT NULL AND changed > p_fetched_at THEN
			written := 0; revised := 0; applied := false;
			RETURN;
		END IF;

		WITH up AS (
			INSERT INTO et_observation AS o (project_id, node_id, source, dekad, eta_mm_day, valid_share, area_m2, mask, upstream_file, upstream_etag, upstream_version)
				SELECT unit.project_id, unit.id, p_source, t.d, t.e, t.v, t.a, p_mask, t.f, t.g, p_version
				FROM unnest(p_dekads, p_eta, p_valid, p_area, p_files, p_etags) AS t(d, e, v, a, f, g)
				ON CONFLICT (node_id, source, dekad) DO UPDATE
					SET eta_mm_day = EXCLUDED.eta_mm_day, valid_share = EXCLUDED.valid_share, area_m2 = EXCLUDED.area_m2, mask = EXCLUDED.mask,
						upstream_file = EXCLUDED.upstream_file, upstream_etag = EXCLUDED.upstream_etag, upstream_version = EXCLUDED.upstream_version,
						revision = o.revision + 1, loaded_at = now()
					WHERE (o.eta_mm_day, o.valid_share, o.area_m2, o.mask, o.upstream_file, o.upstream_etag, o.upstream_version)
						IS DISTINCT FROM (EXCLUDED.eta_mm_day, EXCLUDED.valid_share, EXCLUDED.area_m2, EXCLUDED.mask, EXCLUDED.upstream_file, EXCLUDED.upstream_etag, EXCLUDED.upstream_version)
				RETURNING o.revision
		)
		SELECT count(*)::integer, count(*) FILTER (WHERE up.revision > 1)::integer INTO written, revised FROM up;
		applied := true;
	END
	$$;
COMMENT ON FUNCTION app_et_observation_load(text, uuid, date[], double precision[], double precision[], double precision[], text, text[], text[], text, timestamptz) IS
	'Load one unit''s pass file of observed actual ET (276, issue #623), refused when the unit''s parcels changed since the fetch. For the worker (no user) only.';
REVOKE ALL ON FUNCTION app_et_observation_load(text, uuid, date[], double precision[], double precision[], double precision[], text, text[], text[], text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_et_observation_load(text, uuid, date[], double precision[], double precision[], double precision[], text, text[], text[], text, timestamptz) TO water_app;

-- The worker's load marks (et_observation_load_mark), every one: the tick
-- reads them once a tick to choose the files it loads. Worker only.
CREATE FUNCTION app_et_load_marks()
	RETURNS TABLE (source text, node_id uuid, last_good timestamptz, fetched_at timestamptz, failed_at timestamptz, parcels_changed_at timestamptz)
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NOT mirror_worker_context() THEN
			RAISE EXCEPTION 'only the worker reads the ET load marks' USING ERRCODE = 'insufficient_privilege';
		END IF;
		RETURN QUERY SELECT k.source, k.node_id, k.last_good, k.fetched_at, k.failed_at, k.parcels_changed_at FROM et_observation_load_mark k;
	END
	$$;
COMMENT ON FUNCTION app_et_load_marks() IS
	'What the ET tick last loaded per source and unit (276), for the worker (no user) only.';
REVOKE ALL ON FUNCTION app_et_load_marks() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_et_load_marks() TO water_app;

-- Record a unit's mark. p_failed false: the file (fetchedAt p_fetched_at) was
-- loaded, or found already loaded, as of the status's lastGood p_last_good;
-- the failure mark is cleared. p_failed true: the attempt failed, so the tick
-- takes the unit after the others; the rest of the mark stays. A unit that is
-- gone records nothing (applied = false). parcels_changed_at is left as it is.
-- Worker only.
CREATE FUNCTION app_et_load_mark_write(
	p_source text, p_node_id uuid, p_last_good timestamptz, p_fetched_at timestamptz, p_failed boolean,
	OUT applied boolean
)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NOT mirror_worker_context() THEN
			RAISE EXCEPTION 'only the worker records ET load marks' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_source IS NULL OR p_source NOT IN ('wapor', 'ssebop') OR p_failed IS NULL OR p_node_id IS NULL THEN
			RAISE EXCEPTION 'not an observed ET source and unit' USING ERRCODE = 'check_violation';
		END IF;
		IF NOT EXISTS (SELECT 1 FROM node WHERE id = p_node_id) THEN
			applied := false;
			RETURN;
		END IF;
		IF p_failed THEN
			INSERT INTO et_observation_load_mark AS k (source, node_id, failed_at, updated_at)
				VALUES (p_source, p_node_id, now(), now())
				ON CONFLICT (source, node_id) DO UPDATE SET failed_at = now(), updated_at = now();
		ELSE
			IF p_last_good IS NULL OR p_fetched_at IS NULL THEN
				RAISE EXCEPTION 'a loaded mark needs the lastGood and the fetchedAt' USING ERRCODE = 'check_violation';
			END IF;
			INSERT INTO et_observation_load_mark AS k (source, node_id, last_good, fetched_at, failed_at, updated_at)
				VALUES (p_source, p_node_id, p_last_good, p_fetched_at, NULL, now())
				ON CONFLICT (source, node_id) DO UPDATE SET last_good = EXCLUDED.last_good, fetched_at = EXCLUDED.fetched_at,
					failed_at = NULL, updated_at = now();
		END IF;
		applied := true;
	END
	$$;
COMMENT ON FUNCTION app_et_load_mark_write(text, uuid, timestamptz, timestamptz, boolean) IS
	'Record what the ET tick loaded, or that it failed, for one source and unit (276), for the worker (no user) only.';
REVOKE ALL ON FUNCTION app_et_load_mark_write(text, uuid, timestamptz, timestamptz, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_et_load_mark_write(text, uuid, timestamptz, timestamptz, boolean) TO water_app;
