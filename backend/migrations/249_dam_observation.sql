-- 249_dam_observation — what satellites saw of each traced dam: the wet area
-- on a date, per source (issue #604 Round 5; docs/data-model.md § Dam
-- observations, docs/architecture.md § Dam observations).
--
-- In this file:
--  * waterbody_reference: Digital Earth Africa's Waterbodies polygons (the
--    v0.0.3 historical extent), loaded by the operator with
--    `pnpm import:waterbodies` (never by the app). Global, not per project,
--    like dam_register_reference (157): any signed-in user reads it, water_app
--    never writes it. The repo ships a synthetic set only (dataset
--    'synthetic', invented outlines round the seeded examples' dams).
--  * dam_waterbody_match: per traced dam polygon (map_feature kind 'dam',
--    Polygon or MultiPolygon), which waterbody it is, worked out by the
--    worker by overlap (backend/src/dams/observed/match.ts, thresholds
--    there): 'matched' (one waterbody is essentially this dam), 'merged' (the
--    waterbody it sits in also holds other water, so its wet area isn't this
--    dam's) or 'none' (no waterbody, e.g. a dam under Waterbodies' 0.45 ha
--    minimum). Only 'matched' dams get Waterbodies observations.
--  * dam_observation: one row per dam, source and date: the wet area seen
--    (m²), the share of the outline seen clearly that date (pct_observed),
--    and the upstream key the row came from (a Waterbodies uid, or a WOfS
--    STAC item id). Sources: 'waterbodies' (DE Africa's per-waterbody time
--    series, for matched dams) and 'wofs' (Water Observations from Space
--    over the dam's own outline, every traced dam).
--  * Writers: only the SECURITY DEFINER functions below, from the worker's
--    session with no user (245 mirror_worker_context): the tick matches dams
--    (app_dam_match_write) and loads the files the weekly fetcher pass left
--    in the mirror bucket (app_dam_observation_load). water_app holds SELECT
--    on the project tables and nothing else.
--  * Redrawing a dam: a change to a dam feature's geometry or kind drops its
--    match and its observations (map_feature_outline_changed); the tick
--    matches it again, and the next passes observe the new outline. A WOfS
--    file fetched before the feature's last change is not loaded.
--  * RLS: a project's viewers and above read its matches and observations; a
--    farmer reads those of the dams on their own farms (as map_feature's
--    farmer policy, 152), never a neighbour's.
--  * Same project: the composite foreign key (feature_id, project_id) →
--    map_feature (id, project_id), the pattern 152 uses for a feature's
--    source and node.area_feature_id. It holds the row to its feature's
--    project by construction, so no assert_same_project trigger is needed
--    (that function resolves node, run and scenario columns, not features).
--    Covering indexes on every foreign key.
--  * reference_load (192, latest 248) takes the kind 'waterbodies', so a
--    production load of the polygons (load-reference.yml, geo/referenceLoad.ts)
--    records which file it came from, as the other reference datasets do.
--  * No PostGIS: the polygons are jsonb with a bounding box; the box test
--    runs here, the overlap in the backend.

-- From 248's definition, plus 'waterbodies'.
ALTER TABLE reference_load DROP CONSTRAINT reference_load_kind_check;
ALTER TABLE reference_load ADD CONSTRAINT reference_load_kind_check CHECK (kind IN ('land-cover', 'evaporation', 'rivers', 'gazetteer', 'map-grid', 'tiles', 'waterbodies'));

-- ---------------------------------------------------------------------------
-- waterbody_reference
-- ---------------------------------------------------------------------------
CREATE TABLE waterbody_reference (
	-- DE Africa's waterbody id (a geohash, e.g. 10 characters); it names the time series' file upstream.
	uid        text PRIMARY KEY CHECK (uid ~ '^[0-9a-z]{6,12}$'),
	-- Which load it came from: 'synthetic' (the repo's invented fixture) or the operator's label ('waterbodies-v0.0.3').
	dataset    text NOT NULL CHECK (char_length(dataset) BETWEEN 1 AND 50),
	-- The historical extent, WGS84 lon/lat, checked by backend/src/geo before it gets here.
	geometry   jsonb NOT NULL CHECK (jsonb_typeof(geometry) = 'object' AND geometry ->> 'type' IN ('Polygon', 'MultiPolygon')),
	min_lon    double precision NOT NULL,
	min_lat    double precision NOT NULL,
	max_lon    double precision NOT NULL,
	max_lat    double precision NOT NULL,
	-- Geodesic area of the polygon, m² (geo/area.ts).
	area_m2    double precision NOT NULL CHECK (area_m2 > 0 AND area_m2 < 1e12),
	-- Shown with what is proposed from it: the product, version and file.
	source     text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 500),
	loaded_at  timestamptz NOT NULL DEFAULT now(),
	CHECK (min_lon BETWEEN -180 AND 180 AND max_lon BETWEEN -180 AND 180 AND min_lat BETWEEN -90 AND 90 AND max_lat BETWEEN -90 AND 90),
	CHECK (min_lon <= max_lon AND min_lat <= max_lat)
);
-- The match's first pass: the waterbodies whose box meets a dam's.
CREATE INDEX waterbody_reference_bbox_idx ON waterbody_reference (min_lon, max_lon, min_lat, max_lat);
CREATE INDEX waterbody_reference_dataset_idx ON waterbody_reference (dataset);

COMMENT ON TABLE waterbody_reference IS
	'Digital Earth Africa Waterbodies polygons (historical extent), loaded by the operator (pnpm import:waterbodies), read-only to the app (249, issue #604 R5). The repo ships a synthetic set only.';

ALTER TABLE waterbody_reference ENABLE ROW LEVEL SECURITY;
-- Public reference data: anyone signed in reads it; the app never writes it.
CREATE POLICY waterbody_reference_select ON waterbody_reference FOR SELECT USING (app_current_user_id() IS NOT NULL);
GRANT SELECT ON waterbody_reference TO water_app;

-- ---------------------------------------------------------------------------
-- dam_waterbody_match
-- ---------------------------------------------------------------------------
CREATE TABLE dam_waterbody_match (
	feature_id      uuid NOT NULL,
	project_id      uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	status          text NOT NULL CHECK (status IN ('matched', 'merged', 'none')),
	-- The waterbody: the one matched, or the one the dam sits in when merged; NULL for none.
	-- Not a foreign key: a reload of the reference set replaces its rows, and the tick then matches every dam again.
	uid             text CHECK (uid ~ '^[0-9a-z]{6,12}$'),
	-- The share of the dam's outline inside the waterbody, and of the waterbody inside the dam's outline (0–1).
	dam_share       double precision CHECK (dam_share BETWEEN 0 AND 1),
	waterbody_share double precision CHECK (waterbody_share BETWEEN 0 AND 1),
	matched_at      timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (feature_id),
	FOREIGN KEY (feature_id, project_id) REFERENCES map_feature (id, project_id) ON DELETE CASCADE,
	CHECK ((status = 'none') = (uid IS NULL)),
	CHECK ((uid IS NULL) = (dam_share IS NULL) AND (uid IS NULL) = (waterbody_share IS NULL))
);
-- Covers the composite feature foreign key (the primary key leads with feature_id alone).
CREATE INDEX dam_waterbody_match_feature_idx ON dam_waterbody_match (feature_id, project_id);
CREATE INDEX dam_waterbody_match_project_idx ON dam_waterbody_match (project_id);
-- The loader's lookup: the dams matched to a waterbody.
CREATE INDEX dam_waterbody_match_uid_idx ON dam_waterbody_match (uid) WHERE status = 'matched';

COMMENT ON TABLE dam_waterbody_match IS
	'Which DE Africa waterbody a traced dam polygon is, by overlap (249; backend/src/dams/observed/match.ts): matched, merged (the waterbody also holds other water) or none. Written only by app_dam_match_write (the worker).';

-- ---------------------------------------------------------------------------
-- dam_observation
-- ---------------------------------------------------------------------------
CREATE TABLE dam_observation (
	id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_id   uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
	-- A dam polygon of the project.
	feature_id   uuid NOT NULL,
	source       text NOT NULL CHECK (source IN ('waterbodies', 'wofs')),
	-- The satellite pass's date (UTC). Landsat's record, which both sources read, starts in 1984.
	obs_date     date NOT NULL CHECK (obs_date BETWEEN date '1984-01-01' AND date '2200-12-31'),
	-- The wet area seen, m². Of the part seen clearly only: read it with pct_observed.
	wet_area_m2  double precision NOT NULL CHECK (wet_area_m2 >= 0 AND wet_area_m2 < 1e12),
	-- The share of the outline seen clearly that date (not cloud, shadow or no data), 0–100.
	pct_observed double precision NOT NULL CHECK (pct_observed BETWEEN 0 AND 100),
	-- The Waterbodies uid, or the WOfS STAC item id, the row came from.
	upstream_key text NOT NULL CHECK (char_length(upstream_key) BETWEEN 1 AND 200 AND upstream_key ~ '^[!-~]+$'),
	loaded_at    timestamptz NOT NULL DEFAULT now(),
	UNIQUE (feature_id, source, obs_date),
	FOREIGN KEY (feature_id, project_id) REFERENCES map_feature (id, project_id) ON DELETE CASCADE
);
CREATE INDEX dam_observation_feature_idx ON dam_observation (feature_id, project_id);
CREATE INDEX dam_observation_project_idx ON dam_observation (project_id);

COMMENT ON TABLE dam_observation IS
	'The wet area satellites saw of a traced dam on a date, per source (249, issue #604 R5): DE Africa Waterbodies for a matched dam, WOfS over every dam''s outline. Written only by app_dam_observation_load (the worker), from the weekly pass''s files.';
COMMENT ON COLUMN dam_observation.pct_observed IS
	'The share of the outline seen clearly that date, 0–100 (Waterbodies: 100 − pc_invalid). wet_area_m2 counts the part seen only, so a low share understates the water.';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- The dam features on the caller's own farms, in every project they farm in:
-- the farmer policies below, as map_feature_select_farmer (152) reads them
-- through app_farm_nodes. No argument, so a policy runs it once per query,
-- not once per row (a dam's series is thousands of rows).
CREATE FUNCTION app_farm_dam_features() RETURNS SETOF uuid
	LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
	AS $$
		SELECT f.id FROM map_feature f
		JOIN farm_link l ON l.project_id = f.project_id AND l.node_id = f.node_id
		WHERE l.user_id = app_current_user_id() AND f.kind = 'dam'
	$$;
COMMENT ON FUNCTION app_farm_dam_features() IS
	'The dam map features on the calling user''s own farms, in every project (249): the farmer policies of dam_waterbody_match and dam_observation.';
REVOKE ALL ON FUNCTION app_farm_dam_features() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_farm_dam_features() TO water_app;

ALTER TABLE dam_waterbody_match ENABLE ROW LEVEL SECURITY;
CREATE POLICY dam_waterbody_match_select ON dam_waterbody_match FOR SELECT USING (app_has_role(project_id, 'viewer'));
-- A farmer or contributor: the dams on their own farms only (map_feature_select_farmer, 152).
CREATE POLICY dam_waterbody_match_select_farmer ON dam_waterbody_match FOR SELECT
	USING (feature_id IN (SELECT app_farm_dam_features()));

ALTER TABLE dam_observation ENABLE ROW LEVEL SECURITY;
CREATE POLICY dam_observation_select ON dam_observation FOR SELECT USING (app_has_role(project_id, 'viewer'));
CREATE POLICY dam_observation_select_farmer ON dam_observation FOR SELECT
	USING (feature_id IN (SELECT app_farm_dam_features()));

-- Read only: every write goes through the worker's functions below.
GRANT SELECT ON dam_waterbody_match, dam_observation TO water_app;

-- ---------------------------------------------------------------------------
-- A redrawn dam loses its match and its observations
-- ---------------------------------------------------------------------------
-- What was seen of the old outline isn't the new one's, and the waterbody may
-- differ. SECURITY DEFINER: the editor who redraws holds no DELETE on them.
CREATE FUNCTION map_feature_outline_changed() RETURNS trigger
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		DELETE FROM dam_observation WHERE feature_id = NEW.id;
		DELETE FROM dam_waterbody_match WHERE feature_id = NEW.id;
		RETURN NULL;
	END
	$$;
REVOKE ALL ON FUNCTION map_feature_outline_changed() FROM PUBLIC;
CREATE TRIGGER map_feature_outline_changed AFTER UPDATE OF geometry, kind ON map_feature
	FOR EACH ROW WHEN ((OLD.kind = 'dam' OR NEW.kind = 'dam') AND (OLD.geometry IS DISTINCT FROM NEW.geometry OR OLD.kind IS DISTINCT FROM NEW.kind))
	EXECUTE FUNCTION map_feature_outline_changed();

-- ---------------------------------------------------------------------------
-- The worker's functions (no user, no API key: 245 mirror_worker_context)
-- ---------------------------------------------------------------------------

-- Every traced dam polygon in any project (at most 5000), for the tick: the
-- outline for the wanted list and the match, its match as it stands
-- (match_stale when there is none, or the reference set was loaded since),
-- and the newest observation held per source. The outlines leave the VPC
-- only to our own mirror bucket, for the fetcher (docs/security.md). Past the
-- cap the newest dams wait: the tick logs it (dams/observed/tick.ts).
CREATE FUNCTION app_dam_outlines()
	RETURNS TABLE (
		feature_id uuid, project_id uuid, geometry jsonb, area_m2 double precision, updated_at timestamptz,
		status text, uid text, match_stale boolean, waterbodies_newest date, wofs_newest date
	)
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NOT mirror_worker_context() THEN
			RAISE EXCEPTION 'only the worker lists the traced dams' USING ERRCODE = 'insufficient_privilege';
		END IF;
		RETURN QUERY
			SELECT f.id, f.project_id, f.geometry, f.area_m2, f.updated_at,
				m.status, m.uid,
				m.feature_id IS NULL OR m.matched_at < coalesce((SELECT max(r.loaded_at) FROM waterbody_reference r), '-infinity'),
				(SELECT max(o.obs_date) FROM dam_observation o WHERE o.feature_id = f.id AND o.source = 'waterbodies'),
				(SELECT max(o.obs_date) FROM dam_observation o WHERE o.feature_id = f.id AND o.source = 'wofs')
			FROM map_feature f
			LEFT JOIN dam_waterbody_match m ON m.feature_id = f.id
			WHERE f.kind = 'dam' AND f.geometry ->> 'type' IN ('Polygon', 'MultiPolygon')
			ORDER BY f.id
			LIMIT 5000;
	END
	$$;
COMMENT ON FUNCTION app_dam_outlines() IS
	'Every traced dam polygon with its waterbody match and newest observation per source (249), for the worker (no user) only.';
REVOKE ALL ON FUNCTION app_dam_outlines() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_dam_outlines() TO water_app;

-- The waterbodies whose bounding box meets the box given (at most 200, those
-- whose boxes share the most area with it first), for the match's overlap in
-- the backend. Worker only (the table's policy needs a user).
CREATE FUNCTION app_waterbody_candidates(p_w double precision, p_s double precision, p_e double precision, p_n double precision)
	RETURNS TABLE (uid text, geometry jsonb, area_m2 double precision)
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NOT mirror_worker_context() THEN
			RAISE EXCEPTION 'only the worker matches dams to waterbodies' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_w IS NULL OR p_s IS NULL OR p_e IS NULL OR p_n IS NULL OR p_w > p_e OR p_s > p_n OR p_e - p_w > 1 OR p_n - p_s > 1 THEN
			RAISE EXCEPTION 'not a box of at most 1° a side' USING ERRCODE = 'check_violation';
		END IF;
		RETURN QUERY
			SELECT r.uid, r.geometry, r.area_m2
			FROM waterbody_reference r
			WHERE r.min_lon <= p_e AND r.max_lon >= p_w AND r.min_lat <= p_n AND r.max_lat >= p_s
			ORDER BY greatest(0, least(r.max_lon, p_e) - greatest(r.min_lon, p_w)) * greatest(0, least(r.max_lat, p_n) - greatest(r.min_lat, p_s)) DESC, r.uid
			LIMIT 200;
	END
	$$;
COMMENT ON FUNCTION app_waterbody_candidates(double precision, double precision, double precision, double precision) IS
	'The waterbodies whose box meets a box (249): the dam match''s first pass, for the worker (no user) only.';
REVOKE ALL ON FUNCTION app_waterbody_candidates(double precision, double precision, double precision, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_waterbody_candidates(double precision, double precision, double precision, double precision) TO water_app;

-- Record a dam's match. A dam that was matched and now isn't (or is matched to
-- another waterbody) loses its Waterbodies observations; the loader adds the
-- new waterbody's. p_feature_at is the feature's updated_at as the tick read
-- it (compared to the millisecond, as JavaScript reads it): a feature changed
-- since is left alone (applied = false), and matched again next tick. Worker only.
CREATE FUNCTION app_dam_match_write(
	p_feature_id uuid, p_status text, p_uid text, p_dam_share double precision, p_waterbody_share double precision, p_feature_at timestamptz,
	OUT applied boolean, OUT dropped integer
)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		f map_feature%ROWTYPE;
		prev dam_waterbody_match%ROWTYPE;
	BEGIN
		IF NOT mirror_worker_context() THEN
			RAISE EXCEPTION 'only the worker matches dams to waterbodies' USING ERRCODE = 'insufficient_privilege';
		END IF;
		dropped := 0;
		-- Serialised with a redraw (the PATCH's row lock) and with the loader, which locks the same row first.
		SELECT * INTO f FROM map_feature WHERE id = p_feature_id FOR NO KEY UPDATE;
		IF f.id IS NULL OR f.kind <> 'dam' OR f.geometry ->> 'type' NOT IN ('Polygon', 'MultiPolygon') OR date_trunc('milliseconds', f.updated_at) IS DISTINCT FROM date_trunc('milliseconds', p_feature_at) THEN
			applied := false;
			RETURN;
		END IF;
		SELECT * INTO prev FROM dam_waterbody_match WHERE feature_id = p_feature_id;
		IF prev.feature_id IS NOT NULL AND prev.status = 'matched' AND (p_status <> 'matched' OR p_uid IS DISTINCT FROM prev.uid) THEN
			DELETE FROM dam_observation WHERE feature_id = p_feature_id AND source = 'waterbodies';
			GET DIAGNOSTICS dropped = ROW_COUNT;
		END IF;
		-- The table's CHECKs bound the status, uid and shares (23514).
		INSERT INTO dam_waterbody_match (feature_id, project_id, status, uid, dam_share, waterbody_share, matched_at)
			VALUES (p_feature_id, f.project_id, p_status, p_uid, p_dam_share, p_waterbody_share, now())
			ON CONFLICT (feature_id) DO UPDATE SET status = EXCLUDED.status, uid = EXCLUDED.uid, dam_share = EXCLUDED.dam_share,
				waterbody_share = EXCLUDED.waterbody_share, matched_at = EXCLUDED.matched_at;
		applied := true;
	END
	$$;
COMMENT ON FUNCTION app_dam_match_write(uuid, text, text, double precision, double precision, timestamptz) IS
	'Record which waterbody a traced dam is (249), for the worker (no user) only; a dam no longer matched loses its Waterbodies observations.';
REVOKE ALL ON FUNCTION app_dam_match_write(uuid, text, text, double precision, double precision, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_dam_match_write(uuid, text, text, double precision, double precision, timestamptz) TO water_app;

-- Load one observation file the weekly pass wrote (backend/src/dams/observed/handover.ts ObservationFile):
--   p_source 'waterbodies': p_key is a uid; the rows go to every dam matched to it.
--   p_source 'wofs':        p_key is a dam feature's id; the rows go to it, unless the feature
--                           changed after p_fetched_at (its outline may be another), or it is no
--                           longer a dam polygon (applied = false). p_fetched_at is when the
--                           fetch started, so a redraw during the fetch counts as after it.
-- Rows are upserted by (feature, source, date): a file never removes a row (a
-- pass may cover only the days since the newest held), and a row whose
-- values are unchanged isn't rewritten. `written` counts the rows inserted or
-- changed, over every dam the file reached.
--
-- Bounds (else 23514): a known source; the arrays of one length, at most
-- 20000 rows, each date from 1984 to tomorrow in UTC and listed once; each
-- wet area finite, 0 to 1e12 m²; each share 0 to 100; each upstream key 1–200
-- printable characters; p_fetched_at not in the future. Worker only.
CREATE FUNCTION app_dam_observation_load(
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
		IF p_source IS NULL OR p_source NOT IN ('waterbodies', 'wofs') THEN
			RAISE EXCEPTION 'not a dam observation source' USING ERRCODE = 'check_violation';
		END IF;
		IF p_key IS NULL OR (p_source = 'waterbodies' AND p_key !~ '^[0-9a-z]{6,12}$') THEN
			RAISE EXCEPTION 'not a waterbody uid' USING ERRCODE = 'check_violation';
		END IF;
		IF p_source = 'wofs' AND p_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
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
	'Load one weekly pass file of dam observations (249): a Waterbodies uid''s series into every dam matched to it, or a dam''s WOfS rows. For the worker (no user) only.';
REVOKE ALL ON FUNCTION app_dam_observation_load(text, text, date[], double precision[], double precision[], text[], timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_dam_observation_load(text, text, date[], double precision[], double precision[], text[], timestamptz) TO water_app;
