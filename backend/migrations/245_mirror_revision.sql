-- 245_mirror_revision — a revision of our copy of CHIRPS reaches the cell
-- cache without a feed (issue #604 R1-E, design D9; docs/data-model.md §
-- Mirror revisions, docs/architecture.md § Data feeds → Re-checking finals).
--
-- Issue #604 moves CHIRPS onto a copy we control (a Zarr store per product,
-- with a manifest.json beside it). When the ingest finds that CHC rewrote a
-- file and the values really changed, it bumps the product's manifest
-- `revision` and appends a `changes` entry ({revision, days:[from,to],
-- cellsChanged, maxAbsDiff}). The worker's tick (R2-D) reads the manifest
-- and calls app_mirror_apply_revision, which:
--   * marks stale (chirps_cell_stale, 210) every cached FINAL value of the
--     changed days inside the manifest's region (or an entry's own narrower
--     region): the cells some feed asked for, never a cell nobody cached;
--   * records the revision applied (mirror_manifest).
-- From there the 210 machinery is unchanged: the next fetch of a feed over a
-- marked cell claims its stale days (chirps_recheck_claim 'reread'), reads
-- them again (from the copy), and chirps_recheck_apply replaces the finals
-- that differ, clears the stale rows and logs each changed day in
-- chirps_revision, from which every feed over the cell refreshes its series
-- (feeds/ingest.ts refreshRevisedDays).
--
-- It does not log chirps_revision itself. chirps_revision means "these
-- cached finals changed" (cells_changed > 0, the tags before and after), and
-- every feed recomputes its series from the cache for each logged day: a row
-- logged here, before any value moved, would make every CHIRPS feed recompute
-- up to a whole revision's days from the old values for nothing, and the day
-- would be logged a second time when the re-read lands. The record of the
-- revision itself is mirror_manifest (the manifest as applied, its changes).
--
-- Which cells: the manifest's `changes` carry no cell list (cellsChanged is a
-- count), and a list for a region-wide rewrite would be 341,000 cells. So
-- every cached final of those days in the region is marked. Over-marking
-- costs one re-read from the copy of a value that turns out unchanged (which
-- clears the stale row and logs nothing); under-marking would keep a wrong
-- value cached for good, which is the failure that matters. The cache holds
-- only cells some feed asked for, so the marking is small. An entry may carry
-- an optional `region` {w,s,e,n} to narrow it, inside the manifest's.
--
-- Callable by water_app with no user and no API key only (the worker tick,
-- db/tx.ts withoutUser): a signed-in request can't mark the shared cache.

-- One row per origin and product: the revision of the copy the cache was
-- last brought up to. Reference data like chirps_cell_year (no project_id).
CREATE TABLE mirror_manifest (
	origin     text NOT NULL CHECK (origin IN ('chc', 'fixtures')),
	product    text NOT NULL CHECK (product IN ('sat', 'rnl')),
	revision   integer NOT NULL CHECK (revision >= 1),
	applied_at timestamptz NOT NULL DEFAULT now(),
	manifest   jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
	PRIMARY KEY (origin, product)
);
COMMENT ON TABLE mirror_manifest IS
	'The revision of our CHIRPS copy each product''s cached finals were last brought up to, with the manifest as applied (245). Read by any signed-in session; written only through app_mirror_apply_revision.';

ALTER TABLE mirror_manifest ENABLE ROW LEVEL SECURITY;
CREATE POLICY mirror_manifest_select ON mirror_manifest FOR SELECT USING (app_current_user_id() IS NOT NULL);
GRANT SELECT ON mirror_manifest TO water_app;

-- Whether this transaction is the worker's own: no user, no API key
-- (db/tx.ts withoutUser), as 051's alert_worker_context.
CREATE FUNCTION mirror_worker_context() RETURNS boolean
	LANGUAGE sql STABLE SET search_path = public
	AS $$ SELECT app_current_user_id() IS NULL AND app_current_api_key_id() IS NULL $$;
REVOKE ALL ON FUNCTION mirror_worker_context() FROM PUBLIC, water_app;

-- The CHC grid cells (208: row 0 at 60° N, column 0 at 180° W, 0.05°) a
-- region {w,s,e,n} in degrees covers, as inclusive index ranges; NULL when it
-- is not a region of the grid (missing or non-numeric bounds, w >= e or
-- s >= n, off the 60° S – 60° N, 180° W – 180° E grid, or edges off the
-- 0.05° lattice). jsonb numbers are numeric, so the arithmetic is exact.
CREATE FUNCTION mirror_region_cells(p_region jsonb, OUT r0 integer, OUT r1 integer, OUT c0 integer, OUT c1 integer)
	LANGUAGE plpgsql IMMUTABLE SET search_path = public
	AS $$
	DECLARE
		w numeric;
		s numeric;
		e numeric;
		n numeric;
	BEGIN
		IF jsonb_typeof(p_region) IS DISTINCT FROM 'object'
			OR jsonb_typeof(p_region -> 'w') IS DISTINCT FROM 'number' OR jsonb_typeof(p_region -> 's') IS DISTINCT FROM 'number'
			OR jsonb_typeof(p_region -> 'e') IS DISTINCT FROM 'number' OR jsonb_typeof(p_region -> 'n') IS DISTINCT FROM 'number' THEN
			RETURN;
		END IF;
		w := (p_region ->> 'w')::numeric;
		s := (p_region ->> 's')::numeric;
		e := (p_region ->> 'e')::numeric;
		n := (p_region ->> 'n')::numeric;
		IF NOT (w >= -180 AND e <= 180 AND w < e AND s >= -60 AND n <= 60 AND s < n)
			OR w % 0.05 <> 0 OR s % 0.05 <> 0 OR e % 0.05 <> 0 OR n % 0.05 <> 0 THEN
			RETURN;
		END IF;
		r0 := ((60 - n) / 0.05)::integer;
		r1 := ((60 - s) / 0.05)::integer - 1;
		c0 := ((w + 180) / 0.05)::integer;
		c1 := ((e + 180) / 0.05)::integer - 1;
	END
	$$;
REVOKE ALL ON FUNCTION mirror_region_cells(jsonb) FROM PUBLIC;

-- The revision of p_origin / p_product the cache was last brought up to
-- (NULL: none yet), for the worker tick, which can't read mirror_manifest
-- (no user): it calls app_mirror_apply_revision only when the manifest's is
-- newer.
CREATE FUNCTION app_mirror_revision(p_origin text, p_product text) RETURNS integer
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NOT mirror_worker_context() THEN
			RAISE EXCEPTION 'only the worker reads the copy''s revision this way' USING ERRCODE = 'insufficient_privilege';
		END IF;
		RETURN (SELECT m.revision FROM mirror_manifest m WHERE m.origin = p_origin AND m.product = p_product);
	END
	$$;
COMMENT ON FUNCTION app_mirror_revision(text, text) IS
	'The revision of the CHIRPS copy a product''s cached finals were last brought up to (245), for the worker (no user) only.';
REVOKE ALL ON FUNCTION app_mirror_revision(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_mirror_revision(text, text) TO water_app;

-- Bring the cache of p_origin / p_product up to revision p_revision of the
-- copy, whose manifest (as read, `changes` and all) is p_manifest. p_changes
-- is a jsonb array of the manifest's `changes` entries:
--   {revision, days: [from, to], cellsChanged, maxAbsDiff, region?}
-- Entries at or below the stored revision are skipped (so the caller may pass
-- the manifest's whole list); one above p_revision refuses the call. Each
-- applied entry with cellsChanged > 0 marks stale every cached final of its
-- days in its region (the entry's own `region`, which must sit inside the
-- manifest's, else the manifest's `region`).
--
-- p_revision at or below the stored one changes nothing and returns the
-- stored revision with applied = false (a tick that raced another, or a
-- manifest read from before the last apply). Otherwise the stored revision
-- becomes p_revision (applied = true), and `marked` is how many cell-days
-- were newly marked.
--
-- Bounds (else 23514, the whole call refused): origin and product known; the
-- manifest an object of at most 4 MB naming the same product and revision,
-- with a region on the 0.05° grid and grid.step 0.05; at most 1000 entries,
-- each with an integer revision, a [from, to] of ISO dates from the
-- product's first day to today (UTC), at most 366 days, a non-negative
-- integer cellsChanged and a non-negative maxAbsDiff; at most 4000 distinct
-- days marked in one call.
--
-- Lock order as 210's: an advisory lock on the product (serialising two ticks), then
-- each day's chirps_file row in day order, under which that day's stale rows
-- are written (210's rule, so this never waits on a re-check's stale rows
-- while it holds them). No cell row is locked: the cached values are only
-- read.
CREATE FUNCTION app_mirror_apply_revision(p_origin text, p_product text, p_revision integer, p_changes jsonb, p_manifest jsonb)
	RETURNS TABLE (revision integer, applied boolean, marked integer)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	DECLARE
		stored integer;
		first_day date := CASE p_product WHEN 'sat' THEN date '1998-01-01' ELSE date '1981-01-01' END;
		today date := (now() AT TIME ZONE 'UTC')::date;
		region record;
		er record;
		ch jsonb;
		ch_rev integer;
		d_from date;
		d_to date;
		n_marked integer := 0;
		n integer;
		spans jsonb := '[]';
		n_days integer;
	BEGIN
		IF NOT mirror_worker_context() THEN
			RAISE EXCEPTION 'a revision of the copy is applied only by the worker' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_origin IS NULL OR p_origin NOT IN ('chc', 'fixtures') OR p_product IS NULL OR p_product NOT IN ('sat', 'rnl') THEN
			RAISE EXCEPTION 'not a CHIRPS origin and product' USING ERRCODE = 'check_violation';
		END IF;
		IF p_revision IS NULL OR p_revision < 1 THEN
			RAISE EXCEPTION 'not a revision of the copy' USING ERRCODE = 'check_violation';
		END IF;
		IF jsonb_typeof(p_manifest) IS DISTINCT FROM 'object' OR octet_length(p_manifest::text) > 4194304
			OR p_manifest ->> 'product' IS DISTINCT FROM p_product
			OR jsonb_typeof(p_manifest -> 'revision') IS DISTINCT FROM 'number' OR (p_manifest ->> 'revision') IS DISTINCT FROM p_revision::text
			OR jsonb_typeof(p_manifest -> 'grid' -> 'step') IS DISTINCT FROM 'number' OR (p_manifest #>> '{grid,step}')::numeric <> 0.05 THEN
			RAISE EXCEPTION 'not the manifest of revision % of CHIRPS %', p_revision, p_product USING ERRCODE = 'check_violation';
		END IF;
		SELECT * INTO region FROM mirror_region_cells(p_manifest -> 'region');
		IF region.r0 IS NULL THEN
			RAISE EXCEPTION 'the manifest''s region is not one of the CHIRPS grid' USING ERRCODE = 'check_violation';
		END IF;
		IF jsonb_typeof(p_changes) IS DISTINCT FROM 'array' OR jsonb_array_length(p_changes) > 1000 THEN
			RAISE EXCEPTION 'the changes are a list of at most 1000 entries' USING ERRCODE = 'check_violation';
		END IF;

		-- Serialise two ticks over the same product, even before its first row exists.
		PERFORM pg_advisory_xact_lock(hashtext('mirror_manifest'), hashtext(p_origin || '/' || p_product));
		SELECT m.revision INTO stored FROM mirror_manifest m WHERE m.origin = p_origin AND m.product = p_product;
		stored := coalesce(stored, 0);
		IF p_revision <= stored THEN
			RETURN QUERY SELECT stored, false, 0;
			RETURN;
		END IF;

		-- Every entry checked before anything is marked; the spans to mark collected.
		FOR ch IN SELECT x FROM jsonb_array_elements(p_changes) AS t(x) LOOP
			IF jsonb_typeof(ch) IS DISTINCT FROM 'object'
				OR jsonb_typeof(ch -> 'revision') IS DISTINCT FROM 'number' OR (ch ->> 'revision') !~ '^[0-9]{1,9}$'
				OR jsonb_typeof(ch -> 'days') IS DISTINCT FROM 'array' OR jsonb_array_length(ch -> 'days') <> 2
				OR jsonb_typeof(ch -> 'days' -> 0) IS DISTINCT FROM 'string' OR jsonb_typeof(ch -> 'days' -> 1) IS DISTINCT FROM 'string'
				OR (ch -> 'days' ->> 0) !~ '^\d{4}-\d{2}-\d{2}$' OR (ch -> 'days' ->> 1) !~ '^\d{4}-\d{2}-\d{2}$'
				OR jsonb_typeof(ch -> 'cellsChanged') IS DISTINCT FROM 'number' OR (ch ->> 'cellsChanged') !~ '^[0-9]{1,9}$'
				OR jsonb_typeof(ch -> 'maxAbsDiff') IS DISTINCT FROM 'number' OR (ch ->> 'maxAbsDiff')::numeric < 0 THEN
				RAISE EXCEPTION 'not a change of the copy: {revision, days: [from, to], cellsChanged, maxAbsDiff}' USING ERRCODE = 'check_violation';
			END IF;
			BEGIN
				d_from := (ch -> 'days' ->> 0)::date;
				d_to := (ch -> 'days' ->> 1)::date;
			EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
				RAISE EXCEPTION 'a change''s days are not dates' USING ERRCODE = 'check_violation';
			END;
			IF to_char(d_from, 'YYYY-MM-DD') <> ch -> 'days' ->> 0 OR to_char(d_to, 'YYYY-MM-DD') <> ch -> 'days' ->> 1
				OR d_from > d_to OR d_from < first_day OR d_to > today OR d_to - d_from + 1 > 366 THEN
				RAISE EXCEPTION 'a change''s days must run forwards, at most 366 of them, from CHIRPS %''s first day to today', p_product USING ERRCODE = 'check_violation';
			END IF;
			ch_rev := (ch ->> 'revision')::integer;
			IF ch_rev > p_revision THEN
				RAISE EXCEPTION 'a change of revision % in the manifest of revision %', ch_rev, p_revision USING ERRCODE = 'check_violation';
			END IF;
			IF ch ? 'region' THEN
				SELECT * INTO er FROM mirror_region_cells(ch -> 'region');
				IF er.r0 IS NULL OR er.r0 < region.r0 OR er.r1 > region.r1 OR er.c0 < region.c0 OR er.c1 > region.c1 THEN
					RAISE EXCEPTION 'a change''s region must be one of the CHIRPS grid inside the manifest''s' USING ERRCODE = 'check_violation';
				END IF;
			ELSE
				er := region;
			END IF;
			-- Already applied, or nothing changed: nothing to mark.
			CONTINUE WHEN ch_rev <= stored OR (ch ->> 'cellsChanged')::integer = 0;
			spans := spans || jsonb_build_array(jsonb_build_object('from', d_from, 'to', d_to, 'r0', er.r0, 'r1', er.r1, 'c0', er.c0, 'c1', er.c1));
		END LOOP;

		SELECT count(DISTINCT g.day) INTO n_days
			FROM jsonb_array_elements(spans) AS s(x), generate_series((s.x ->> 'from')::date, (s.x ->> 'to')::date, interval '1 day') AS g(day);
		IF n_days > 4000 THEN
			RAISE EXCEPTION 'a revision of % days is more than one call marks (4000): apply it in parts', n_days USING ERRCODE = 'check_violation';
		END IF;

		IF n_days > 0 THEN
			-- Each day's file row, in day order (210's lock order), then its stale rows.
			PERFORM 1 FROM chirps_file cf
				WHERE cf.origin = p_origin AND cf.product = p_product
					AND cf.day IN (SELECT g.day::date FROM jsonb_array_elements(spans) AS s(x), generate_series((s.x ->> 'from')::date, (s.x ->> 'to')::date, interval '1 day') AS g(day))
				ORDER BY cf.day
				FOR UPDATE;
			INSERT INTO chirps_cell_stale (origin, product, row_idx, col_idx, day)
				SELECT DISTINCT r.origin, r.product, r.row_idx, r.col_idx, k.day
				FROM (
					SELECT g.day::date AS day, (s.x ->> 'r0')::integer AS r0, (s.x ->> 'r1')::integer AS r1, (s.x ->> 'c0')::integer AS c0, (s.x ->> 'c1')::integer AS c1
					FROM jsonb_array_elements(spans) AS s(x), generate_series((s.x ->> 'from')::date, (s.x ->> 'to')::date, interval '1 day') AS g(day)
				) k
				JOIN chirps_cell_year r ON r.origin = p_origin AND r.product = p_product AND r.year = extract(year FROM k.day)::integer
					AND r.row_idx BETWEEN k.r0 AND k.r1 AND r.col_idx BETWEEN k.c0 AND k.c1
				WHERE r.final[k.day - make_date(r.year, 1, 1) + 1] AND r.vals[k.day - make_date(r.year, 1, 1) + 1] IS NOT NULL
				ORDER BY k.day, r.row_idx, r.col_idx
				ON CONFLICT DO NOTHING;
			GET DIAGNOSTICS n = ROW_COUNT;
			n_marked := n;
		END IF;

		INSERT INTO mirror_manifest AS m (origin, product, revision, applied_at, manifest)
			VALUES (p_origin, p_product, p_revision, now(), p_manifest)
			ON CONFLICT (origin, product) DO UPDATE SET revision = EXCLUDED.revision, applied_at = EXCLUDED.applied_at, manifest = EXCLUDED.manifest;
		RETURN QUERY SELECT p_revision, true, n_marked;
	END
	$$;
COMMENT ON FUNCTION app_mirror_apply_revision(text, text, integer, jsonb, jsonb) IS
	'Brings the CHIRPS cell cache up to a revision of our copy (245): every cached final of the changed days in the region marked stale (chirps_cell_stale), for the feeds'' re-check to read again, and the revision recorded in mirror_manifest. An older or equal revision changes nothing. From the worker (no user) only.';
REVOKE ALL ON FUNCTION app_mirror_apply_revision(text, text, integer, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_mirror_apply_revision(text, text, integer, jsonb, jsonb) TO water_app;
