-- 277_dam_observation_sentinel — two more dam observation sources: Sentinel-2
-- L2A Collection 1 and Sentinel-1 RTC from Digital Earth Africa, classified
-- by us inside each traced dam's own outline (issue #624 step 3;
-- docs/data-model.md § Dam observations, docs/data-sources.md
-- deafrica-sentinel-2-c1 and deafrica-sentinel-1).
--
--   s2  Sentinel-2 (10 m optical): MNDWI water, SCL cloud and shadow masking;
--       upstream_key is the STAC item id, as WOfS's.
--   s1  Sentinel-1 (radar through cloud): VV backscatter water, the RTC mask
--       excluding layover and shadow; a secondary source, never alone "seen
--       full" or "seen empty" (the reader's rule, a later slice of #624).
--
-- Like WOfS, both observe every traced dam over its own outline, so a pass
-- file's key is the dam feature's id and its load mark holds the feature.
-- No pass writes either source yet (#624 steps 4 and 5): this only lets the
-- tables and the worker's functions take them.
--
-- Expand only. Starting from the latest (and only) definitions, all in 261:
--  * dam_observation_source_check and dam_observation_load_mark_source_check
--    (the column CHECKs, by their generated names) gain 's2' and 's1';
--  * dam_observation_load_mark_check, "a feature-keyed source has its
--    feature_id", gains them too (WOfS was the only one);
--  * app_dam_observation_load and app_dam_load_mark_write take them, with the
--    WOfS rules (a dam feature id key, the feature locked and checked against
--    the fetch time). Same signatures, so CREATE OR REPLACE keeps their
--    owner, grants and SECURITY DEFINER; search_path stays pinned.
-- Every existing row is 'waterbodies' or 'wofs', so each new CHECK holds and
-- the ADDs validate without rewriting (a scan of the tables under the
-- ALTER's lock). No new table, policy, grant, trigger or index: RLS on
-- dam_observation reads no source, and dam_observation_load_mark stays owner
-- only. app_dam_outlines (261) still returns the newest row per source for
-- waterbodies and wofs only; the Sentinel passes add theirs when they need it.

ALTER TABLE dam_observation DROP CONSTRAINT dam_observation_source_check;
ALTER TABLE dam_observation
	ADD CONSTRAINT dam_observation_source_check CHECK (source IN ('waterbodies', 'wofs', 's2', 's1'));

ALTER TABLE dam_observation_load_mark DROP CONSTRAINT dam_observation_load_mark_source_check;
ALTER TABLE dam_observation_load_mark
	ADD CONSTRAINT dam_observation_load_mark_source_check CHECK (source IN ('waterbodies', 'wofs', 's2', 's1'));
ALTER TABLE dam_observation_load_mark DROP CONSTRAINT dam_observation_load_mark_check;
ALTER TABLE dam_observation_load_mark
	ADD CONSTRAINT dam_observation_load_mark_check CHECK ((source IN ('wofs', 's2', 's1')) = (feature_id IS NOT NULL));

COMMENT ON TABLE dam_observation IS
	'The wet area satellites saw of a traced dam on a date, per source (261, issue #604 R5; 277, issue #624): DE Africa Waterbodies for a matched dam; WOfS, Sentinel-2 (s2) and Sentinel-1 radar (s1) over every dam''s outline. Written only by app_dam_observation_load (the worker), from the weekly pass''s files.';

-- Load one observation file the weekly pass wrote (261's rules, unchanged):
--   p_source 'waterbodies':       p_key is a uid; the rows go to every dam matched to it.
--   p_source 'wofs', 's2', 's1':  p_key is a dam feature's id; the rows go to it, unless the
--                                 feature changed after p_fetched_at, or it is no longer a
--                                 dam polygon (applied = false).
CREATE OR REPLACE FUNCTION app_dam_observation_load(
	p_source text, p_key text,
	p_dates date[], p_wet double precision[], p_pct double precision[], p_upstream text[],
	p_fetched_at timestamptz,
	OUT written integer, OUT dams integer, OUT applied boolean
)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		n integer := coalesce(cardinality(p_dates), 0);
		targets uuid[];
		fid uuid;
	BEGIN
		IF NOT mirror_worker_context() THEN
			RAISE EXCEPTION 'only the worker loads dam observations' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_source IS NULL OR p_source NOT IN ('waterbodies', 'wofs', 's2', 's1') THEN
			RAISE EXCEPTION 'not a dam observation source' USING ERRCODE = 'check_violation';
		END IF;
		IF p_key IS NULL OR (p_source = 'waterbodies' AND p_key !~ '^[0-9a-z]{6,12}$') THEN
			RAISE EXCEPTION 'not a waterbody uid' USING ERRCODE = 'check_violation';
		END IF;
		IF p_source IN ('wofs', 's2', 's1') AND p_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
			RAISE EXCEPTION 'not a dam feature id' USING ERRCODE = 'check_violation';
		END IF;
		IF n > 20000 OR coalesce(cardinality(p_wet), 0) <> n OR coalesce(cardinality(p_pct), 0) <> n OR coalesce(cardinality(p_upstream), 0) <> n
			OR (n > 0 AND (array_ndims(p_dates) <> 1 OR array_ndims(p_wet) <> 1 OR array_ndims(p_pct) <> 1 OR array_ndims(p_upstream) <> 1)) THEN
			RAISE EXCEPTION 'the rows are not one date, wet area, share and key each (at most 20000)' USING ERRCODE = 'check_violation';
		END IF;
		IF p_fetched_at IS NULL OR p_fetched_at > now() + interval '5 minutes' THEN
			RAISE EXCEPTION 'the fetch time is missing or in the future' USING ERRCODE = 'check_violation';
		END IF;
		IF EXISTS (SELECT 1 FROM unnest(p_dates) d WHERE d IS NULL OR d < date '1984-01-01' OR d > (now() AT TIME ZONE 'UTC')::date + 1) THEN
			RAISE EXCEPTION 'a date is before 1984 or after tomorrow' USING ERRCODE = 'check_violation';
		END IF;
		IF (SELECT count(DISTINCT d) FROM unnest(p_dates) d) <> n THEN
			RAISE EXCEPTION 'a date is listed twice' USING ERRCODE = 'check_violation';
		END IF;
		-- NaN and ±Infinity fail these bounds too.
		IF EXISTS (SELECT 1 FROM unnest(p_wet) v WHERE v IS NULL OR NOT (v >= 0 AND v < 1e12)) THEN
			RAISE EXCEPTION 'a wet area is not 0 to 1e12 m²' USING ERRCODE = 'check_violation';
		END IF;
		IF EXISTS (SELECT 1 FROM unnest(p_pct) v WHERE v IS NULL OR NOT (v >= 0 AND v <= 100)) THEN
			RAISE EXCEPTION 'a share observed is not 0 to 100' USING ERRCODE = 'check_violation';
		END IF;
		IF EXISTS (SELECT 1 FROM unnest(p_upstream) k WHERE k IS NULL OR char_length(k) NOT BETWEEN 1 AND 200 OR k !~ '^[!-~]+$') THEN
			RAISE EXCEPTION 'an upstream key is not 1 to 200 printable characters' USING ERRCODE = 'check_violation';
		END IF;

		-- The target dams' rows are locked first, so a redraw (which drops the
		-- dam's match and observations) can't commit between choosing them and
		-- writing: it waits, or the dam is chosen against the state it left.
		IF p_source = 'waterbodies' THEN
			SELECT coalesce(array_agg(l.id), '{}') INTO targets FROM (
				SELECT f.id FROM map_feature f JOIN dam_waterbody_match m ON m.feature_id = f.id
				WHERE m.uid = p_key AND m.status = 'matched'
				ORDER BY f.id FOR NO KEY UPDATE OF f
			) l;
			-- Read the matches again under the locks: one redrawn meanwhile is gone.
			SELECT coalesce(array_agg(m.feature_id), '{}') INTO targets
				FROM dam_waterbody_match m WHERE m.feature_id = ANY (targets) AND m.uid = p_key AND m.status = 'matched';
		ELSE
			fid := p_key::uuid;
			SELECT coalesce(array_agg(l.id), '{}') INTO targets FROM (
				SELECT f.id FROM map_feature f
				WHERE f.id = fid AND f.kind = 'dam' AND f.geometry ->> 'type' IN ('Polygon', 'MultiPolygon') AND date_trunc('milliseconds', f.updated_at) <= p_fetched_at
				FOR NO KEY UPDATE
			) l;
		END IF;
		dams := cardinality(targets);
		IF dams = 0 THEN
			written := 0;
			applied := false;
			RETURN;
		END IF;

		INSERT INTO dam_observation (project_id, feature_id, source, obs_date, wet_area_m2, pct_observed, upstream_key)
			SELECT f.project_id, f.id, p_source, t.d, t.w, t.p, t.k
			FROM map_feature f
			CROSS JOIN unnest(p_dates, p_wet, p_pct, p_upstream) AS t(d, w, p, k)
			WHERE f.id = ANY (targets)
			ON CONFLICT (feature_id, source, obs_date) DO UPDATE
				SET wet_area_m2 = EXCLUDED.wet_area_m2, pct_observed = EXCLUDED.pct_observed, upstream_key = EXCLUDED.upstream_key, loaded_at = now()
				WHERE (dam_observation.wet_area_m2, dam_observation.pct_observed, dam_observation.upstream_key)
					IS DISTINCT FROM (EXCLUDED.wet_area_m2, EXCLUDED.pct_observed, EXCLUDED.upstream_key);
		GET DIAGNOSTICS written = ROW_COUNT;
		applied := true;
	END
	$$;
COMMENT ON FUNCTION app_dam_observation_load(text, text, date[], double precision[], double precision[], text[], timestamptz) IS
	'Load one weekly pass file of dam observations (261, 277): a Waterbodies uid''s series into every dam matched to it, or a dam''s WOfS, Sentinel-2 (s2) or Sentinel-1 (s1) rows. For the worker (no user) only.';
REVOKE ALL ON FUNCTION app_dam_observation_load(text, text, date[], double precision[], double precision[], text[], timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_dam_observation_load(text, text, date[], double precision[], double precision[], text[], timestamptz) TO water_app;

-- Record a pass file's mark (261's rules, unchanged): a feature-keyed source
-- ('wofs', 's2', 's1') holds the feature, and records nothing for one that is
-- gone (applied = false). Worker only.
CREATE OR REPLACE FUNCTION app_dam_load_mark_write(
	p_source text, p_key text, p_last_good timestamptz, p_fetched_at timestamptz, p_targets text, p_failed boolean,
	OUT applied boolean
)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		fid uuid;
	BEGIN
		IF NOT mirror_worker_context() THEN
			RAISE EXCEPTION 'only the worker records dam load marks' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_source IS NULL OR p_source NOT IN ('waterbodies', 'wofs', 's2', 's1') OR p_failed IS NULL THEN
			RAISE EXCEPTION 'not a dam observation source' USING ERRCODE = 'check_violation';
		END IF;
		IF p_key IS NULL OR (p_source = 'waterbodies' AND p_key !~ '^[0-9a-z]{6,12}$')
			OR (p_source IN ('wofs', 's2', 's1') AND p_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
			RAISE EXCEPTION 'not a pass file key' USING ERRCODE = 'check_violation';
		END IF;
		IF p_source IN ('wofs', 's2', 's1') THEN
			SELECT f.id INTO fid FROM map_feature f WHERE f.id = p_key::uuid;
			IF fid IS NULL THEN
				applied := false;
				RETURN;
			END IF;
		END IF;
		IF p_failed THEN
			INSERT INTO dam_observation_load_mark AS k (source, key, feature_id, failed_at, updated_at)
				VALUES (p_source, p_key, fid, now(), now())
				ON CONFLICT (source, key) DO UPDATE SET failed_at = now(), updated_at = now();
		ELSE
			IF p_last_good IS NULL OR p_fetched_at IS NULL THEN
				RAISE EXCEPTION 'a loaded mark needs the lastGood and the fetchedAt' USING ERRCODE = 'check_violation';
			END IF;
			-- The table's CHECK bounds the digest (23514).
			INSERT INTO dam_observation_load_mark AS k (source, key, feature_id, last_good, fetched_at, targets, failed_at, updated_at)
				VALUES (p_source, p_key, fid, p_last_good, p_fetched_at, coalesce(p_targets, ''), NULL, now())
				ON CONFLICT (source, key) DO UPDATE SET last_good = EXCLUDED.last_good, fetched_at = EXCLUDED.fetched_at,
					targets = EXCLUDED.targets, failed_at = NULL, updated_at = now();
		END IF;
		applied := true;
	END
	$$;
COMMENT ON FUNCTION app_dam_load_mark_write(text, text, timestamptz, timestamptz, text, boolean) IS
	'Record what the dams tick loaded, or that it failed, for one pass file (261, 277), for the worker (no user) only.';
REVOKE ALL ON FUNCTION app_dam_load_mark_write(text, text, timestamptz, timestamptz, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_dam_load_mark_write(text, text, timestamptz, timestamptz, text, boolean) TO water_app;
