-- 252_cache_products — the cell cache and the copy's revision machinery take
-- the copy's other rain products, each on its own grid (issue #604 R4-B;
-- docs/data-model.md § The cell cache's products and grids,
-- docs/architecture.md § Our copy of the rain data).
--
-- Round 4 adds two products to our copy, both on a 0.1° grid over the same
-- D1 region: `era5l` (ERA5-Land daily total precipitation, D15, finals
-- layout, from 1950) and `imerg_late` (IMERG Late V07 daily, D16, daily
-- layout, from June 2000). They reach the cache through the same tables and
-- functions as CHIRPS's `sat` and `rnl` (208, 210, 245, 246), so a revision
-- of either marks and replays as CHIRPS's do. What changes:
--
-- 1. The products. Every CHECK on `product` takes `era5l` and `imerg_late`:
--    chirps_cell_year, chirps_cell_stale, chirps_file, chirps_revision,
--    mirror_manifest, mirror_change and mirror_copy (which also keeps
--    `prelim`). In the copy's manifests ERA5-Land's days run through
--    finalThrough and IMERG Late's through prelimThrough (Late is never
--    final), so mirror_copy holds no prelim_through for era5l and no
--    final_through for imerg_late. In the cache both are final (no later
--    product replaces either; a new version of a day is a revision of the
--    copy, which marks and replays it), so the merge refuses a 'p' day.
--
-- 2. The grids. A cache row's (row_idx, col_idx) is a cell of its product's
--    global grid, row 0 at 60° N and column 0 at 180° W: CHC's 0.05° grid
--    (2400 × 7200) for sat and rnl, a 0.1° grid (1200 × 3600) for era5l and
--    imerg_late (feeds/cellCache.ts productCell: a feed's 0.05° cell (r, c)
--    lies in the 0.1° cell (r/2, c/2), rounded down). The column CHECKs keep
--    the 0.05° bounds; a new CHECK per table (chirps_cell_year_grid,
--    chirps_cell_stale_grid, mirror_change_grid) holds a 0.1° product's rows
--    and columns inside its grid, so a 0.05° index written as a 0.1° one by
--    mistake is refused rather than cached as some other place's rain. The
--    manifest's grid.step must be the product's (0.05 or 0.1), and a region's
--    edges must lie on its lattice (mirror_region_cells, now by step).
--
-- 3. First days. sat 1998-01-01, rnl 1981-01-01, era5l 1950-01-01,
--    imerg_late 2000-06-01 (mirror_product_first_day; the same table as
--    backend/src/mirror/grid.ts PRODUCT_GRIDS): the year CHECK on
--    chirps_cell_year, the day CHECK on chirps_file, and every function's
--    "a day the product does not have".
--
-- 4. Who writes. chirps_feed_job (210) named a running job of a CHIRPS feed
--    *of that product*. No feed's config names era5l or imerg_late (the
--    engine decides how a project uses them, a later piece), so for those
--    two it names a running job of any CHIRPS feed: the cells are the feed's
--    own, read from our copy (feeds/fromMirror.ts fillProductCache), checked
--    value by value as CHIRPS's are. sat and rnl are as before.
--
-- Every function that validated the product is replaced from its latest
-- definition, its signature, grants and the rest of its body unchanged:
-- chirps_feed_job and chirps_recheck_claim (210), chirps_cache_merge,
-- chirps_recheck_apply, app_mirror_apply_revision and app_mirror_record_copy
-- (246). app_mirror_revision (245) and mirror_mark_raced (246) take any
-- product as given and are unchanged.

-- The cache's products, their first days and their grids' steps.
CREATE FUNCTION mirror_cache_product(p text) RETURNS boolean
	LANGUAGE sql IMMUTABLE SET search_path = public
	AS $$ SELECT coalesce(p IN ('sat', 'rnl', 'era5l', 'imerg_late'), false) $$;
REVOKE ALL ON FUNCTION mirror_cache_product(text) FROM PUBLIC;

CREATE FUNCTION mirror_product_first_day(p text) RETURNS date
	LANGUAGE sql IMMUTABLE SET search_path = public
	AS $$ SELECT CASE p WHEN 'sat' THEN date '1998-01-01' WHEN 'rnl' THEN date '1981-01-01' WHEN 'era5l' THEN date '1950-01-01' WHEN 'imerg_late' THEN date '2000-06-01' END $$;
REVOKE ALL ON FUNCTION mirror_product_first_day(text) FROM PUBLIC;

CREATE FUNCTION mirror_product_step(p text) RETURNS numeric
	LANGUAGE sql IMMUTABLE SET search_path = public
	AS $$ SELECT CASE WHEN p IN ('sat', 'rnl', 'prelim') THEN 0.05 WHEN p IN ('era5l', 'imerg_late') THEN 0.1 END $$;
REVOKE ALL ON FUNCTION mirror_product_step(text) FROM PUBLIC;

-- Whether (r, c) is a cell of p's global grid (60° S – 60° N, 180° W – 180° E).
CREATE FUNCTION mirror_product_cell_ok(p text, r integer, c integer) RETURNS boolean
	LANGUAGE sql IMMUTABLE SET search_path = public
	AS $$ SELECT coalesce(r >= 0 AND c >= 0 AND r < round(120 / mirror_product_step(p)) AND c < round(360 / mirror_product_step(p)), false) $$;
REVOKE ALL ON FUNCTION mirror_product_cell_ok(text, integer, integer) FROM PUBLIC;

-- 1–3: the tables' CHECKs. The CASEs are written out rather than calling the
-- functions above, so a constraint never depends on a function's body.
ALTER TABLE chirps_cell_year
	DROP CONSTRAINT chirps_cell_year_product_check,
	DROP CONSTRAINT chirps_cell_year_year,
	ADD CONSTRAINT chirps_cell_year_product_check CHECK (product IN ('sat', 'rnl', 'era5l', 'imerg_late')),
	ADD CONSTRAINT chirps_cell_year_year CHECK (year BETWEEN (CASE product WHEN 'sat' THEN 1998 WHEN 'era5l' THEN 1950 WHEN 'imerg_late' THEN 2000 ELSE 1981 END) AND 2200),
	ADD CONSTRAINT chirps_cell_year_grid CHECK (product IN ('sat', 'rnl') OR (row_idx <= 1199 AND col_idx <= 3599));

ALTER TABLE chirps_cell_stale
	DROP CONSTRAINT chirps_cell_stale_product_check,
	ADD CONSTRAINT chirps_cell_stale_product_check CHECK (product IN ('sat', 'rnl', 'era5l', 'imerg_late')),
	ADD CONSTRAINT chirps_cell_stale_grid CHECK (product IN ('sat', 'rnl') OR (row_idx <= 1199 AND col_idx <= 3599));

ALTER TABLE chirps_file
	DROP CONSTRAINT chirps_file_product_check,
	DROP CONSTRAINT chirps_file_day,
	ADD CONSTRAINT chirps_file_product_check CHECK (product IN ('sat', 'rnl', 'era5l', 'imerg_late')),
	ADD CONSTRAINT chirps_file_day CHECK (day >= CASE product WHEN 'sat' THEN date '1998-01-01' WHEN 'era5l' THEN date '1950-01-01' WHEN 'imerg_late' THEN date '2000-06-01' ELSE date '1981-01-01' END);

ALTER TABLE chirps_revision
	DROP CONSTRAINT chirps_revision_product_check,
	ADD CONSTRAINT chirps_revision_product_check CHECK (product IN ('sat', 'rnl', 'era5l', 'imerg_late'));

ALTER TABLE mirror_manifest
	DROP CONSTRAINT mirror_manifest_product_check,
	ADD CONSTRAINT mirror_manifest_product_check CHECK (product IN ('sat', 'rnl', 'era5l', 'imerg_late'));

ALTER TABLE mirror_change
	DROP CONSTRAINT mirror_change_product_check,
	ADD CONSTRAINT mirror_change_product_check CHECK (product IN ('sat', 'rnl', 'era5l', 'imerg_late')),
	ADD CONSTRAINT mirror_change_grid CHECK (product IN ('sat', 'rnl') OR (r1 <= 1199 AND c1 <= 3599));

ALTER TABLE mirror_copy
	DROP CONSTRAINT mirror_copy_product_check,
	DROP CONSTRAINT mirror_copy_check,
	DROP CONSTRAINT mirror_copy_check1,
	ADD CONSTRAINT mirror_copy_product_check CHECK (product IN ('sat', 'rnl', 'prelim', 'era5l', 'imerg_late')),
	ADD CONSTRAINT mirror_copy_no_final CHECK (product NOT IN ('prelim', 'imerg_late') OR final_through IS NULL),
	ADD CONSTRAINT mirror_copy_no_prelim CHECK (product NOT IN ('rnl', 'era5l') OR prelim_through IS NULL);

COMMENT ON TABLE chirps_cell_year IS
	'Shared daily rain values per grid cell and year (208; other products since 252): CHIRPS v3 sat and rnl on CHC''s 0.05° grid, ERA5-Land (era5l) and IMERG Late (imerg_late) on a 0.1° grid. Reference data for every project. Read by any signed-in session; written only through chirps_cache_merge and chirps_recheck_apply.';

-- The cells of p_step's global grid (row 0 at 60° N, column 0 at 180° W) a
-- region {w,s,e,n} in degrees covers, as inclusive index ranges; NULL when it
-- is not a region of that grid (missing or non-numeric bounds, w >= e or
-- s >= n, off 60° S – 60° N, 180° W – 180° E, or edges off the p_step
-- lattice, or no step). 245's one-argument form, by step; it replaces it.
CREATE FUNCTION mirror_region_cells(p_region jsonb, p_step numeric, OUT r0 integer, OUT r1 integer, OUT c0 integer, OUT c1 integer)
	LANGUAGE plpgsql IMMUTABLE SET search_path = public
	AS $$
	DECLARE
		w numeric;
		s numeric;
		e numeric;
		n numeric;
	BEGIN
		IF p_step IS NULL OR p_step <= 0 OR jsonb_typeof(p_region) IS DISTINCT FROM 'object'
			OR jsonb_typeof(p_region -> 'w') IS DISTINCT FROM 'number' OR jsonb_typeof(p_region -> 's') IS DISTINCT FROM 'number'
			OR jsonb_typeof(p_region -> 'e') IS DISTINCT FROM 'number' OR jsonb_typeof(p_region -> 'n') IS DISTINCT FROM 'number' THEN
			RETURN;
		END IF;
		w := (p_region ->> 'w')::numeric;
		s := (p_region ->> 's')::numeric;
		e := (p_region ->> 'e')::numeric;
		n := (p_region ->> 'n')::numeric;
		IF NOT (w >= -180 AND e <= 180 AND w < e AND s >= -60 AND n <= 60 AND s < n)
			OR w % p_step <> 0 OR s % p_step <> 0 OR e % p_step <> 0 OR n % p_step <> 0 THEN
			RETURN;
		END IF;
		r0 := ((60 - n) / p_step)::integer;
		r1 := ((60 - s) / p_step)::integer - 1;
		c0 := ((w + 180) / p_step)::integer;
		c1 := ((e + 180) / p_step)::integer - 1;
	END
	$$;
REVOKE ALL ON FUNCTION mirror_region_cells(jsonb, numeric) FROM PUBLIC;

-- chirps_feed_job, from 210's definition (its only one): for era5l and
-- imerg_late, a running job of any CHIRPS feed (4. above).
CREATE OR REPLACE FUNCTION chirps_feed_job(p_feed uuid, p_product text, p_kinds text[])
	RETURNS uuid
	LANGUAGE sql STABLE SET search_path = public
	AS $$
		SELECT j.id FROM job j JOIN data_feed f ON f.id = p_feed AND f.project_id = j.project_id
		WHERE app_current_user_id() IS NOT NULL AND j.acting_user_id = app_current_user_id()
			AND j.status = 'running' AND j.locked_until > now()
			AND j.kind = ANY (p_kinds) AND j.payload ->> 'feedId' = p_feed::text
			AND f.source = 'chirps'
			AND (coalesce(f.config ->> 'product', 'sat') = p_product OR p_product IN ('era5l', 'imerg_late'))
			AND app_has_role(j.project_id, 'editor')
		ORDER BY j.id LIMIT 1
	$$;

-- chirps_recheck_claim, from 210's definition (its only one): any cache product.
CREATE OR REPLACE FUNCTION chirps_recheck_claim(p_feed uuid, p_origin text, p_product text, p_rows integer[], p_cols integer[], p_heads integer, p_reads integer, p_interval_days integer)
	RETURNS TABLE (kind text, day date)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	DECLARE
		v_job uuid;
		n_cells integer := coalesce(array_length(p_rows, 1), 0);
		rereads date[];
	BEGIN
		v_job := CASE WHEN p_feed IS NULL OR p_product IS NULL THEN NULL ELSE chirps_feed_job(p_feed, p_product, ARRAY['feed_fetch']) END;
		IF v_job IS NULL THEN
			RAISE EXCEPTION 'CHIRPS files are re-checked only by a data feed''s fetch' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_origin IS NULL OR p_origin NOT IN ('chc', 'fixtures') OR NOT mirror_cache_product(p_product)
			OR p_heads IS NULL OR p_heads NOT BETWEEN 0 AND 40 OR p_reads IS NULL OR p_reads NOT BETWEEN 0 AND 10
			OR p_interval_days IS NULL OR p_interval_days NOT BETWEEN 1 AND 3650
			OR n_cells > 100 OR coalesce(array_length(p_cols, 1), 0) <> n_cells THEN
			RAISE EXCEPTION 'not a CHIRPS re-check of at most 40 files and 10 days over at most 100 cells' USING ERRCODE = 'check_violation';
		END IF;

		SELECT coalesce(array_agg(s.day ORDER BY s.day), '{}') INTO rereads FROM (
			SELECT DISTINCT st.day FROM chirps_cell_stale st
			JOIN unnest(p_rows, p_cols) AS k(r, c) ON st.row_idx = k.r AND st.col_idx = k.c
			WHERE st.origin = p_origin AND st.product = p_product
			ORDER BY st.day LIMIT p_reads
		) s;
		RETURN QUERY SELECT 'reread'::text, u.d FROM unnest(rereads) AS u(d);

		RETURN QUERY
			WITH picked AS (
				SELECT cf.day FROM chirps_file cf
				WHERE cf.origin = p_origin AND cf.product = p_product AND cf.tag IS NULL
					AND (cf.checked_at IS NULL OR cf.checked_at < now() - interval '1 day')
					AND (cf.claim_until IS NULL OR cf.claim_until < now())
					AND NOT cf.day = ANY (rereads)
					AND EXISTS (
						SELECT 1 FROM chirps_cell_year r JOIN unnest(p_rows, p_cols) AS k(r, c) ON r.row_idx = k.r AND r.col_idx = k.c
						WHERE r.origin = cf.origin AND r.product = cf.product AND r.year = extract(year FROM cf.day)::integer
							AND r.final[cf.day - make_date(r.year, 1, 1) + 1]
					)
				ORDER BY cf.checked_at NULLS FIRST, cf.day
				LIMIT greatest(0, p_reads - cardinality(rereads))
				FOR UPDATE OF cf SKIP LOCKED
			), claimed AS (
				UPDATE chirps_file cf SET claim_job = v_job, claim_until = now() + interval '30 minutes'
				FROM picked WHERE cf.origin = p_origin AND cf.product = p_product AND cf.day = picked.day
				RETURNING cf.day
			)
			SELECT 'verify'::text, claimed.day FROM claimed;

		RETURN QUERY
			WITH picked AS (
				SELECT cf.day FROM chirps_file cf
				WHERE cf.origin = p_origin AND cf.product = p_product AND cf.tag IS NOT NULL
					AND (cf.checked_at IS NULL OR cf.checked_at < now() - make_interval(days => p_interval_days))
					AND (cf.claim_until IS NULL OR cf.claim_until < now())
					AND NOT cf.day = ANY (rereads)
				ORDER BY cf.checked_at NULLS FIRST, cf.day
				LIMIT p_heads
				FOR UPDATE OF cf SKIP LOCKED
			), claimed AS (
				UPDATE chirps_file cf SET claim_job = v_job, claim_until = now() + interval '30 minutes'
				FROM picked WHERE cf.origin = p_origin AND cf.product = p_product AND cf.day = picked.day
				RETURNING cf.day
			)
			SELECT 'head'::text, claimed.day FROM claimed;
	END
	$$;

-- chirps_cache_merge, from 246's definition (its latest): any cache product, its
-- first day, its grid's cells, and no preliminary day but sat's.
CREATE OR REPLACE FUNCTION chirps_cache_merge(p_feed uuid, p_origin text, p_product text, p_first date, p_read text, p_rows integer[], p_cols integer[], p_vals real[], p_tags text[] DEFAULT NULL)
	RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	DECLARE
		n_days integer := coalesce(char_length(p_read), 0);
		n_cells integer := coalesce(array_length(p_rows, 1), 0);
		last_day date;
		changed integer := 0;
		row_changed boolean;
		c integer;
		d integer;
		i integer;
		y integer;
		doy integer;
		kind text;
		v real;
		t text;
		day date;
		jan1 date;
		cellv real[];
		cur real[];
		fin boolean[];
		first_prelim integer;
		suspect date[] := '{}';
		v_job uuid;
	BEGIN
		-- Only a data feed's own fetch, as its acting user, still an editor of its project.
		v_job := CASE WHEN p_feed IS NULL OR p_product IS NULL THEN NULL ELSE chirps_feed_job(p_feed, p_product, ARRAY['feed_fetch', 'feed_ingest']) END;
		IF v_job IS NULL THEN
			RAISE EXCEPTION 'the CHIRPS cell cache is written only by a data feed''s fetch' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_origin IS NULL OR p_origin NOT IN ('chc', 'fixtures') OR NOT mirror_cache_product(p_product) OR p_first IS NULL THEN
			RAISE EXCEPTION 'not a CHIRPS origin and product' USING ERRCODE = 'check_violation';
		END IF;
		IF n_cells = 0 OR n_days = 0 THEN
			RETURN 0;
		END IF;
		IF p_read !~ '^[-fp]+$' OR n_days > 366 OR n_cells > 100 THEN
			RAISE EXCEPTION 'not a fetch of at most 100 cells over at most 366 days' USING ERRCODE = 'check_violation';
		END IF;
		IF p_product <> 'sat' AND strpos(p_read, 'p') > 0 THEN
			RAISE EXCEPTION '% has no preliminary values', p_product USING ERRCODE = 'check_violation';
		END IF;
		IF array_ndims(p_rows) <> 1 OR array_ndims(p_cols) <> 1 OR array_length(p_cols, 1) IS DISTINCT FROM n_cells
			OR array_ndims(p_vals) <> 1 OR array_length(p_vals, 1) IS DISTINCT FROM n_cells * n_days
			OR array_lower(p_rows, 1) <> 1 OR array_lower(p_cols, 1) <> 1 OR array_lower(p_vals, 1) <> 1 THEN
			RAISE EXCEPTION 'one value per cell and day' USING ERRCODE = 'check_violation';
		END IF;
		-- A tag only on a day read from its final file, and only one we keep.
		IF p_tags IS NOT NULL THEN
			IF array_ndims(p_tags) <> 1 OR array_lower(p_tags, 1) <> 1 OR array_length(p_tags, 1) <> n_days THEN
				RAISE EXCEPTION 'one tag per day' USING ERRCODE = 'check_violation';
			END IF;
			FOR d IN 1 .. n_days LOOP
				t := p_tags[d];
				IF t IS NOT NULL AND (substr(p_read, d, 1) <> 'f' OR NOT chirps_tag_ok(t)) THEN
					RAISE EXCEPTION 'a file tag that is not one' USING ERRCODE = 'check_violation';
				END IF;
			END LOOP;
		END IF;
		last_day := p_first + n_days - 1;
		-- No day before the product begins, nor after today (UTC): the product can't have it.
		IF p_first < mirror_product_first_day(p_product) OR last_day > (now() AT TIME ZONE 'UTC')::date THEN
			RAISE EXCEPTION 'a day CHIRPS % does not have', p_product USING ERRCODE = 'check_violation';
		END IF;
		FOR c IN 1 .. n_cells LOOP
			IF p_rows[c] IS NULL OR p_cols[c] IS NULL OR NOT mirror_product_cell_ok(p_product, p_rows[c], p_cols[c]) THEN
				RAISE EXCEPTION 'not a cell of the CHIRPS grid' USING ERRCODE = 'check_violation';
			END IF;
			IF c > 1 AND (p_rows[c], p_cols[c]) <= (p_rows[c - 1], p_cols[c - 1]) THEN
				RAISE EXCEPTION 'the cells must be in (row, column) order, each once' USING ERRCODE = 'check_violation';
			END IF;
		END LOOP;
		-- Every value: a day read has one for every cell, 0–2000 mm or NaN (no
		-- data); a day not read has none. FOREACH walks the array once (a
		-- subscript into an array holding NULLs costs a scan from its start).
		i := 0;
		FOREACH v IN ARRAY p_vals LOOP
			kind := substr(p_read, i % n_days + 1, 1);
			i := i + 1;
			IF kind = '-' THEN
				IF v IS NOT NULL THEN
					RAISE EXCEPTION 'a value for a day not read' USING ERRCODE = 'check_violation';
				END IF;
			-- NaN = NaN in Postgres, and NaN is above every number, so the range test refuses it and infinities.
			ELSIF v IS NULL OR NOT (v = 'NaN'::real OR (v >= 0 AND v <= 2000)) THEN
				RAISE EXCEPTION 'an implausible CHIRPS value' USING ERRCODE = 'check_violation';
			END IF;
		END LOOP;

		-- 246: shared with every other fetch, exclusive to an apply of a revision of
		-- our copy, so the apply either sees this merge's cells (and marks them)
		-- or committed before mirror_mark_raced below looks (which marks them).
		PERFORM pg_advisory_xact_lock_shared(hashtext('mirror_manifest'), hashtext(p_origin || '/' || p_product));

		FOR c IN 1 .. n_cells LOOP
			cellv := p_vals[(c - 1) * n_days + 1 : c * n_days];
			FOR y IN extract(year FROM p_first)::integer .. extract(year FROM last_day)::integer LOOP
				jan1 := make_date(y, 1, 1);
				-- A year this fetch read no day of is left as it is (no empty row is made for it).
				CONTINUE WHEN substr(p_read, greatest(1, jan1 - p_first + 1), least(n_days, make_date(y, 12, 31) - p_first + 1) - greatest(1, jan1 - p_first + 1) + 1) !~ '[fp]';
				-- Lock the row, creating it empty first, so a concurrent merge waits for this one and then sees its days.
				INSERT INTO chirps_cell_year (origin, product, row_idx, col_idx, year, vals, final, final_through)
					VALUES (p_origin, p_product, p_rows[c], p_cols[c], y, array_fill(NULL::real, ARRAY[366]), array_fill(false, ARRAY[366]), make_date(y, 12, 31))
					ON CONFLICT DO NOTHING;
				SELECT r.vals, r.final INTO cur, fin FROM chirps_cell_year r
					WHERE r.origin = p_origin AND r.product = p_product AND r.row_idx = p_rows[c] AND r.col_idx = p_cols[c] AND r.year = y
					FOR UPDATE;
				row_changed := false;
				FOR d IN greatest(1, jan1 - p_first + 1) .. least(n_days, make_date(y, 12, 31) - p_first + 1) LOOP
					kind := substr(p_read, d, 1);
					CONTINUE WHEN kind = '-';
					day := p_first + d - 1;
					doy := day - jan1 + 1;
					v := cellv[d];
					-- A preliminary value never lands on a final one.
					CONTINUE WHEN kind = 'p' AND fin[doy];
					-- Nor a final on a different final: CHC rewrote the file. Keep
					-- the cached value and have the re-check look at the file first.
					IF kind = 'f' AND fin[doy] AND cur[doy] IS DISTINCT FROM v THEN
						IF NOT day = ANY (suspect) THEN
							suspect := suspect || day;
						END IF;
						CONTINUE;
					END IF;
					IF cur[doy] IS DISTINCT FROM v THEN
						changed := changed + 1;
						row_changed := true;
						cur[doy] := v;
					END IF;
					IF fin[doy] <> (kind = 'f') THEN
						row_changed := true;
						fin[doy] := kind = 'f';
					END IF;
				END LOOP;
				IF row_changed THEN
					-- final_through: the day before the first preliminary value, else 31 December.
					first_prelim := NULL;
					FOR doy IN 1 .. 366 LOOP
						IF NOT fin[doy] AND cur[doy] IS NOT NULL THEN
							first_prelim := doy;
							EXIT;
						END IF;
					END LOOP;
					UPDATE chirps_cell_year r
						SET vals = cur, final = fin, fetched_at = now(),
							final_through = CASE WHEN first_prelim IS NULL THEN make_date(y, 12, 31) ELSE jan1 + first_prelim - 2 END
						WHERE r.origin = p_origin AND r.product = p_product AND r.row_idx = p_rows[c] AND r.col_idx = p_cols[c] AND r.year = y;
				END IF;
			END LOOP;
		END LOOP;

		-- Each final file read: its row, with the tag the values came from. A
		-- row already there keeps its tag (an unknown one stays unknown until
		-- the re-check reads the day); a different known tag, or a final that
		-- differed from the cached one, puts the file first in the re-check.
		-- In day order, after the cell rows: the lock order of every writer.
		INSERT INTO chirps_file AS cf (origin, product, day, tag, checked_at)
			SELECT p_origin, p_product, p_first + (x.o - 1)::integer, x.t, CASE WHEN x.t IS NULL THEN NULL ELSE now() END
			FROM unnest(string_to_array(p_read, NULL), coalesce(p_tags, array_fill(NULL::text, ARRAY[n_days]))) WITH ORDINALITY AS x(k, t, o)
			WHERE x.k = 'f'
			ORDER BY 3
			ON CONFLICT (origin, product, day) DO UPDATE SET checked_at = NULL
				WHERE (cf.tag IS NOT NULL AND EXCLUDED.tag IS NOT NULL AND cf.tag <> EXCLUDED.tag) OR EXCLUDED.day = ANY (suspect);
		-- 246: a final read before a revision of our copy that was applied since
		-- (the read may be the old value) is marked stale, to be read again.
		PERFORM mirror_mark_raced(p_origin, p_product, chirps_read_since(v_job),
			ARRAY(SELECT p_first + (x.o - 1)::integer FROM unnest(string_to_array(p_read, NULL)) WITH ORDINALITY AS x(k, o) WHERE x.k = 'f'),
			p_rows, p_cols);
		RETURN changed;
	END
	$$;

-- chirps_recheck_apply, from 246's definition (its latest): any cache product,
-- its first day and its grid's cells.
CREATE OR REPLACE FUNCTION chirps_recheck_apply(p_feed uuid, p_fetch_job uuid, p_origin text, p_product text, p_head_days date[], p_head_tags text[], p_read_days date[], p_read_tags text[], p_rows integer[], p_cols integer[], p_vals real[])
	RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	DECLARE
		n_heads integer := coalesce(array_length(p_head_days, 1), 0);
		n_reads integer := coalesce(array_length(p_read_days, 1), 0);
		n_cells integer := coalesce(array_length(p_rows, 1), 0);
		today date := (now() AT TIME ZONE 'UTC')::date;
		first_day date := mirror_product_first_day(p_product);
		changed integer[];
		got boolean[];
		asked boolean[];
		logged integer := 0;
		c integer;
		i integer;
		y integer;
		doy integer;
		v real;
		day date;
		cur real;
		fin boolean;
		prev text;
		t text;
		f record;
		since timestamptz;
	BEGIN
		IF p_feed IS NULL OR p_fetch_job IS NULL OR p_product IS NULL OR chirps_feed_job(p_feed, p_product, ARRAY['feed_fetch', 'feed_ingest']) IS NULL THEN
			RAISE EXCEPTION 'the CHIRPS cell cache is written only by a data feed''s fetch' USING ERRCODE = 'insufficient_privilege';
		END IF;
		-- p_fetch_job must be this feed's own fetch, queued as the caller in its project: a claim
		-- (chirps_file.claim_job, readable by any session) names only the fetch that may answer it.
		IF NOT EXISTS (
			SELECT 1 FROM job j JOIN data_feed f ON f.id = p_feed AND f.project_id = j.project_id
			WHERE j.id = p_fetch_job AND j.kind = 'feed_fetch' AND j.payload ->> 'feedId' = p_feed::text AND j.acting_user_id = app_current_user_id()
		) THEN
			RAISE EXCEPTION 'not this feed''s fetch' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_origin IS NULL OR p_origin NOT IN ('chc', 'fixtures') OR NOT mirror_cache_product(p_product) THEN
			RAISE EXCEPTION 'not a CHIRPS origin and product' USING ERRCODE = 'check_violation';
		END IF;
		IF n_heads > 40 OR n_reads > 10 OR n_cells > 100
			OR coalesce(array_length(p_head_tags, 1), 0) <> n_heads OR coalesce(array_length(p_read_tags, 1), 0) <> n_reads
			OR coalesce(array_length(p_cols, 1), 0) <> n_cells OR coalesce(array_length(p_vals, 1), 0) <> n_cells * n_reads
			OR (n_reads > 0 AND n_cells = 0) THEN
			RAISE EXCEPTION 'not a re-check of at most 40 files and 10 days over at most 100 cells, one value per cell and day' USING ERRCODE = 'check_violation';
		END IF;
		FOR i IN 1 .. n_heads LOOP
			IF p_head_days[i] IS NULL OR p_head_days[i] NOT BETWEEN first_day AND today OR NOT chirps_tag_ok(p_head_tags[i])
				OR (i > 1 AND p_head_days[i] <= p_head_days[i - 1]) THEN
				RAISE EXCEPTION 'not a file of CHIRPS %, each once in day order, with a tag we keep', p_product USING ERRCODE = 'check_violation';
			END IF;
		END LOOP;
		FOR i IN 1 .. n_reads LOOP
			IF p_read_days[i] IS NULL OR p_read_days[i] NOT BETWEEN first_day AND today OR NOT chirps_tag_ok(p_read_tags[i])
				OR (i > 1 AND p_read_days[i] <= p_read_days[i - 1]) OR p_read_days[i] = ANY (p_head_days) THEN
				RAISE EXCEPTION 'not a day of CHIRPS %, each once in day order, with a tag we keep', p_product USING ERRCODE = 'check_violation';
			END IF;
		END LOOP;
		FOR c IN 1 .. n_cells LOOP
			IF p_rows[c] IS NULL OR p_cols[c] IS NULL OR NOT mirror_product_cell_ok(p_product, p_rows[c], p_cols[c])
				OR (c > 1 AND (p_rows[c], p_cols[c]) <= (p_rows[c - 1], p_cols[c - 1])) THEN
				RAISE EXCEPTION 'the cells must be cells of the CHIRPS grid in (row, column) order, each once' USING ERRCODE = 'check_violation';
			END IF;
		END LOOP;
		-- Each day read: one this fetch claimed, or a stale day of these cells; a value on every cell or on none.
		got := array_fill(false, ARRAY[greatest(n_reads, 1)]);
		asked := array_fill(false, ARRAY[greatest(n_reads, 1)]);
		FOR i IN 1 .. n_reads LOOP
			day := p_read_days[i];
			asked[i] := EXISTS (SELECT 1 FROM chirps_file cf WHERE cf.origin = p_origin AND cf.product = p_product AND cf.day = p_read_days[i] AND cf.claim_job = p_fetch_job)
				OR EXISTS (SELECT 1 FROM chirps_cell_stale st JOIN unnest(p_rows, p_cols) AS k(r, c) ON st.row_idx = k.r AND st.col_idx = k.c
					WHERE st.origin = p_origin AND st.product = p_product AND st.day = p_read_days[i]);
			FOR c IN 1 .. n_cells LOOP
				v := p_vals[(c - 1) * n_reads + i];
				IF c = 1 THEN
					got[i] := v IS NOT NULL;
				ELSIF (v IS NOT NULL) <> got[i] THEN
					RAISE EXCEPTION 'a value on every cell of a day read, or on none' USING ERRCODE = 'check_violation';
				END IF;
				IF v IS NOT NULL AND NOT (v = 'NaN'::real OR (v >= 0 AND v <= 2000)) THEN
					RAISE EXCEPTION 'an implausible CHIRPS value' USING ERRCODE = 'check_violation';
				END IF;
			END LOOP;
			IF NOT got[i] AND p_read_tags[i] IS NOT NULL THEN
				RAISE EXCEPTION 'a tag for a file that is gone' USING ERRCODE = 'check_violation';
			END IF;
		END LOOP;

		-- 246: when this fetch's job was queued (its reads came later), and the
		-- revision apply's lock, shared (as the merge's).
		since := chirps_read_since(p_fetch_job);
		PERFORM pg_advisory_xact_lock_shared(hashtext('mirror_manifest'), hashtext(p_origin || '/' || p_product));

		-- The values, cell by cell, each cell's days in order (so its years in order).
		changed := array_fill(0, ARRAY[greatest(n_reads, 1)]);
		FOR c IN 1 .. n_cells LOOP
			FOR i IN 1 .. n_reads LOOP
				CONTINUE WHEN NOT got[i] OR NOT asked[i];
				day := p_read_days[i];
				y := extract(year FROM day)::integer;
				doy := day - make_date(y, 1, 1) + 1;
				v := p_vals[(c - 1) * n_reads + i];
				INSERT INTO chirps_cell_year (origin, product, row_idx, col_idx, year, vals, final, final_through)
					VALUES (p_origin, p_product, p_rows[c], p_cols[c], y, array_fill(NULL::real, ARRAY[366]), array_fill(false, ARRAY[366]), make_date(y, 12, 31))
					ON CONFLICT DO NOTHING;
				SELECT r.vals[doy], r.final[doy] INTO cur, fin FROM chirps_cell_year r
					WHERE r.origin = p_origin AND r.product = p_product AND r.row_idx = p_rows[c] AND r.col_idx = p_cols[c] AND r.year = y
					FOR UPDATE;
				IF fin AND cur IS NOT NULL AND cur IS DISTINCT FROM v THEN
					changed[i] := changed[i] + 1;
				END IF;
				IF NOT fin OR cur IS DISTINCT FROM v THEN
					UPDATE chirps_cell_year r SET vals[doy] = v, final[doy] = true, fetched_at = now()
						WHERE r.origin = p_origin AND r.product = p_product AND r.row_idx = p_rows[c] AND r.col_idx = p_cols[c] AND r.year = y;
					UPDATE chirps_cell_year r SET final_through = chirps_final_through(r.vals, r.final, y)
						WHERE r.origin = p_origin AND r.product = p_product AND r.row_idx = p_rows[c] AND r.col_idx = p_cols[c] AND r.year = y;
				END IF;
			END LOOP;
		END LOOP;

		-- The files, by day: the reads' and the heads' (never the same day).
		FOR f IN
			SELECT x.d, x.t, x.o, false AS head FROM unnest(p_read_days, p_read_tags) WITH ORDINALITY AS x(d, t, o)
			UNION ALL
			SELECT h.d, h.t, h.o, true FROM unnest(p_head_days, p_head_tags) WITH ORDINALITY AS h(d, t, o)
			ORDER BY 1
		LOOP
			day := f.d;
			t := f.t;
			y := extract(year FROM day)::integer;
			doy := day - make_date(y, 1, 1) + 1;
			IF f.head THEN
				SELECT cf.tag INTO prev FROM chirps_file cf
					WHERE cf.origin = p_origin AND cf.product = p_product AND cf.day = f.d AND cf.claim_job = p_fetch_job FOR UPDATE;
				CONTINUE WHEN NOT FOUND;
				UPDATE chirps_file cf SET claim_job = NULL, claim_until = NULL, checked_at = now() WHERE cf.origin = p_origin AND cf.product = p_product AND cf.day = f.d;
				-- Gone or untagged: nothing to compare. The same tag: unchanged.
				CONTINUE WHEN t IS NULL OR t = prev;
				-- Rewritten: every cached final value of the day is read again by a feed over its cell.
				INSERT INTO chirps_cell_stale (origin, product, row_idx, col_idx, day)
					SELECT r.origin, r.product, r.row_idx, r.col_idx, f.d FROM chirps_cell_year r
					WHERE r.origin = p_origin AND r.product = p_product AND r.year = y AND r.final[doy] AND r.vals[doy] IS NOT NULL
					ON CONFLICT (origin, product, row_idx, col_idx, day) DO UPDATE SET marked_at = now();
				UPDATE chirps_file cf SET tag = t, revised_at = now(), revisions = cf.revisions + 1
					WHERE cf.origin = p_origin AND cf.product = p_product AND cf.day = f.d;
				CONTINUE;
			END IF;
			-- A day this fetch wasn't asked (its claim lapsed and went to another fetch, or another feed read it first): left alone.
			CONTINUE WHEN NOT asked[f.o];
			INSERT INTO chirps_file (origin, product, day) VALUES (p_origin, p_product, f.d) ON CONFLICT DO NOTHING;
			SELECT cf.tag INTO prev FROM chirps_file cf WHERE cf.origin = p_origin AND cf.product = p_product AND cf.day = f.d FOR UPDATE;
			-- Read or gone, the cells' day is no longer stale (a file CHC took down keeps its cached value).
			-- Under the file row's lock, as a HEAD's marking is, so the two never wait on each other's stale rows.
			-- 246: not a mark made after this fetch was queued: this read may be older than it.
			DELETE FROM chirps_cell_stale st USING unnest(p_rows, p_cols) AS k(r, c)
				WHERE st.origin = p_origin AND st.product = p_product AND st.row_idx = k.r AND st.col_idx = k.c AND st.day = f.d
					AND st.marked_at <= since;
			IF NOT got[f.o] THEN
				UPDATE chirps_file cf SET claim_job = NULL, claim_until = NULL WHERE cf.origin = p_origin AND cf.product = p_product AND cf.day = f.d AND cf.claim_job = p_fetch_job;
				CONTINUE;
			END IF;
			-- The file changed since its tag was recorded, or its tag wasn't known and the values differ:
			-- the other cells' cached finals of the day came from the old file too.
			IF (prev IS NOT NULL AND t IS NOT NULL AND t <> prev) OR (prev IS NULL AND changed[f.o] > 0) THEN
				INSERT INTO chirps_cell_stale (origin, product, row_idx, col_idx, day)
					SELECT r.origin, r.product, r.row_idx, r.col_idx, f.d FROM chirps_cell_year r
					WHERE r.origin = p_origin AND r.product = p_product AND r.year = y AND r.final[doy] AND r.vals[doy] IS NOT NULL
						AND (r.row_idx, r.col_idx) NOT IN (SELECT k.r, k.c FROM unnest(p_rows, p_cols) AS k(r, c))
					ON CONFLICT (origin, product, row_idx, col_idx, day) DO UPDATE SET marked_at = now();
				UPDATE chirps_file cf SET revised_at = now(), revisions = cf.revisions + 1
					WHERE cf.origin = p_origin AND cf.product = p_product AND cf.day = f.d;
			END IF;
			UPDATE chirps_file cf SET tag = coalesce(t, cf.tag), checked_at = now(),
					claim_job = CASE WHEN cf.claim_job = p_fetch_job THEN NULL ELSE cf.claim_job END,
					claim_until = CASE WHEN cf.claim_job = p_fetch_job THEN NULL ELSE cf.claim_until END
				WHERE cf.origin = p_origin AND cf.product = p_product AND cf.day = f.d;
			IF changed[f.o] > 0 THEN
				INSERT INTO chirps_revision (origin, product, day, cells_changed, tag_before, tag_after)
					VALUES (p_origin, p_product, f.d, changed[f.o], prev, coalesce(t, prev));
				logged := logged + 1;
			END IF;
		END LOOP;
		-- 246: as the merge, a day read before a revision of our copy applied since is read again.
		PERFORM mirror_mark_raced(p_origin, p_product, since,
			ARRAY(SELECT p_read_days[g.n] FROM generate_series(1, n_reads) AS g(n) WHERE got[g.n] AND asked[g.n]), p_rows, p_cols);
		RETURN logged;
	END
	$$;

-- app_mirror_apply_revision, from 246's definition (its latest): any cache
-- product, with its grid's step, its region's cells on that grid, and its first day.
CREATE OR REPLACE FUNCTION app_mirror_apply_revision(p_origin text, p_product text, p_revision integer, p_changes jsonb, p_manifest jsonb)
	RETURNS TABLE (revision integer, applied boolean, marked integer, remaining integer)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public SET lock_timeout = '30s'
	AS $$
	#variable_conflict use_column
	DECLARE
		part_days constant integer := 4000;
		part_cell_days constant bigint := 1000000;
		stored integer;
		first_day date := mirror_product_first_day(p_product);
		today date := (now() AT TIME ZONE 'UTC')::date;
		region record;
		er record;
		ch jsonb;
		ch_rev integer;
		d_from date;
		d_to date;
		n_marked integer := 0;
		todo jsonb := '[]';
		part jsonb := '[]';
		cells jsonb;
		n_todo integer;
		n_days integer := 0;
		est bigint := 0;
		cnt bigint;
		ent jsonb;
		e_to date;
		run_from date;
		day_at date;
		cur date;
		last_idx integer;
		last_to date;
		full_part boolean := false;
		i integer;
	BEGIN
		IF NOT mirror_worker_context() THEN
			RAISE EXCEPTION 'a revision of the copy is applied only by the worker' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_origin IS NULL OR p_origin NOT IN ('chc', 'fixtures') OR p_product IS NULL OR NOT mirror_cache_product(p_product) THEN
			RAISE EXCEPTION 'not a CHIRPS origin and product' USING ERRCODE = 'check_violation';
		END IF;
		IF p_revision IS NULL OR p_revision < 1 THEN
			RAISE EXCEPTION 'not a revision of the copy' USING ERRCODE = 'check_violation';
		END IF;
		IF jsonb_typeof(p_manifest) IS DISTINCT FROM 'object' OR octet_length(p_manifest::text) > 4194304
			OR p_manifest ->> 'product' IS DISTINCT FROM p_product
			OR jsonb_typeof(p_manifest -> 'revision') IS DISTINCT FROM 'number' OR (p_manifest ->> 'revision') IS DISTINCT FROM p_revision::text
			OR jsonb_typeof(p_manifest -> 'grid' -> 'step') IS DISTINCT FROM 'number' OR (p_manifest #>> '{grid,step}')::numeric <> mirror_product_step(p_product) THEN
			RAISE EXCEPTION 'not the manifest of revision % of CHIRPS %', p_revision, p_product USING ERRCODE = 'check_violation';
		END IF;
		SELECT * INTO region FROM mirror_region_cells(p_manifest -> 'region', mirror_product_step(p_product));
		IF region.r0 IS NULL THEN
			RAISE EXCEPTION 'the manifest''s region is not one of the CHIRPS grid' USING ERRCODE = 'check_violation';
		END IF;
		IF jsonb_typeof(p_changes) IS DISTINCT FROM 'array' OR jsonb_array_length(p_changes) > 1000 THEN
			RAISE EXCEPTION 'the changes are a list of at most 1000 entries' USING ERRCODE = 'check_violation';
		END IF;

		-- Serialise two ticks over the same product, even before its first row exists, and keep fetches out meanwhile.
		PERFORM pg_advisory_xact_lock(hashtext('mirror_manifest'), hashtext(p_origin || '/' || p_product));
		SELECT m.revision INTO stored FROM mirror_manifest m WHERE m.origin = p_origin AND m.product = p_product;
		IF p_revision <= coalesce(stored, 0) THEN
			RETURN QUERY SELECT stored, false, 0, 0;
			RETURN;
		END IF;

		-- Every entry checked before anything is marked; the ones to mark collected, in list order.
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
				SELECT * INTO er FROM mirror_region_cells(ch -> 'region', mirror_product_step(p_product));
				IF er.r0 IS NULL OR er.r0 < region.r0 OR er.r1 > region.r1 OR er.c0 < region.c0 OR er.c1 > region.c1 THEN
					RAISE EXCEPTION 'a change''s region must be one of the CHIRPS grid inside the manifest''s' USING ERRCODE = 'check_violation';
				END IF;
			ELSE
				er := region;
			END IF;
			-- The baseline marks everything instead; an entry already applied, or of no cells, marks nothing.
			CONTINUE WHEN stored IS NULL OR ch_rev <= stored OR (ch ->> 'cellsChanged')::integer = 0;
			todo := todo || jsonb_build_array(jsonb_build_object('rev', ch_rev, 'from', d_from, 'to', d_to, 'r0', er.r0, 'r1', er.r1, 'c0', er.c0, 'c1', er.c1));
		END LOOP;

		-- The cell-year rows the cache holds inside the region, by year: the estimate of a part's cell-days.
		SELECT coalesce(jsonb_object_agg(y.year::text, y.n), '{}') INTO cells
			FROM (SELECT cy.year, count(*) AS n FROM chirps_cell_year cy
				WHERE cy.origin = p_origin AND cy.product = p_product
					AND cy.row_idx BETWEEN region.r0 AND region.r1 AND cy.col_idx BETWEEN region.c0 AND region.c1
				GROUP BY cy.year) y;
		IF stored IS NULL THEN
			-- The baseline: each year the cache holds a cell of inside the region, whole, the whole region.
			SELECT coalesce(jsonb_agg(jsonb_build_object('rev', p_revision, 'from', b.bf, 'to', b.bt,
					'r0', region.r0, 'r1', region.r1, 'c0', region.c0, 'c1', region.c1) ORDER BY b.bf), '[]') INTO todo
				FROM (SELECT greatest(make_date(k::integer, 1, 1), first_day) AS bf, least(make_date(k::integer, 12, 31), today) AS bt
					FROM jsonb_object_keys(cells) AS k) b
				WHERE b.bf <= b.bt;
		END IF;
		n_todo := jsonb_array_length(todo);

		-- A resumed apply: what calls before this one logged for this revision, if it is a prefix of these entries, run after
		-- run (each entry's runs back to back from its first day, each entry whole before the next); else dropped.
		IF EXISTS (
			SELECT 1
			FROM (
				SELECT mc.idx, mc.revision AS rev, mc.day_from, mc.day_to, mc.r0, mc.r1, mc.c0, mc.c1,
					lag(mc.idx) OVER w AS p_idx, lag(mc.day_to) OVER w AS p_to
				FROM mirror_change mc
				WHERE mc.origin = p_origin AND mc.product = p_product AND mc.target_revision = p_revision
				WINDOW w AS (ORDER BY mc.idx, mc.day_from)
			) l
			CROSS JOIN LATERAL (SELECT todo -> (l.idx - 1) AS t, todo -> (l.p_idx - 1) AS pt) x
			WHERE l.idx > n_todo
				OR (x.t ->> 'rev')::integer <> l.rev OR (x.t ->> 'r0')::integer <> l.r0 OR (x.t ->> 'r1')::integer <> l.r1
				OR (x.t ->> 'c0')::integer <> l.c0 OR (x.t ->> 'c1')::integer <> l.c1 OR l.day_to > (x.t ->> 'to')::date
				OR CASE
					WHEN l.p_idx IS NULL THEN l.idx <> 1 OR l.day_from <> (x.t ->> 'from')::date
					WHEN l.p_idx = l.idx THEN l.day_from <> l.p_to + 1
					ELSE l.idx <> l.p_idx + 1 OR l.p_to <> (x.pt ->> 'to')::date OR l.day_from <> (x.t ->> 'from')::date
				END
		) THEN
			DELETE FROM mirror_change mc WHERE mc.origin = p_origin AND mc.product = p_product AND mc.target_revision = p_revision;
		END IF;
		SELECT mc.idx, mc.day_to INTO last_idx, last_to FROM mirror_change mc
			WHERE mc.origin = p_origin AND mc.product = p_product AND mc.target_revision = p_revision
			ORDER BY mc.idx DESC, mc.day_to DESC LIMIT 1;
		IF last_idx IS NULL THEN
			i := 0;
		ELSIF last_to >= (todo -> (last_idx - 1) ->> 'to')::date THEN
			i := last_idx;
		ELSE
			i := last_idx - 1;
			cur := last_to + 1;
		END IF;

		-- This call's part: the next days, entry by entry, up to 4000 days and the cell-day budget (at least one day).
		WHILE i < n_todo AND NOT full_part LOOP
			ent := todo -> i;
			e_to := (ent ->> 'to')::date;
			run_from := coalesce(cur, (ent ->> 'from')::date);
			cur := NULL;
			day_at := run_from;
			WHILE day_at <= e_to LOOP
				cnt := coalesce((cells ->> extract(year FROM day_at)::integer::text)::bigint, 0);
				IF n_days > 0 AND (n_days >= part_days OR est + cnt > part_cell_days) THEN
					full_part := true;
					EXIT;
				END IF;
				n_days := n_days + 1;
				est := est + cnt;
				day_at := day_at + 1;
			END LOOP;
			IF day_at > run_from THEN
				part := part || jsonb_build_array(ent || jsonb_build_object('idx', i + 1, 'from', run_from, 'to', day_at - 1));
			END IF;
			IF NOT full_part THEN
				i := i + 1;
			END IF;
		END LOOP;

		IF n_days > 0 THEN
			-- Each day's file row, in day order (210's lock order), then its stale rows; not waiting long on a fetch's.
			PERFORM set_config('lock_timeout', '500ms', true);
			PERFORM 1 FROM chirps_file cf
				WHERE cf.origin = p_origin AND cf.product = p_product
					AND cf.day IN (SELECT g.day::date FROM jsonb_array_elements(part) AS s(x), generate_series((s.x ->> 'from')::date, (s.x ->> 'to')::date, interval '1 day') AS g(day))
				ORDER BY cf.day
				FOR UPDATE;
			INSERT INTO chirps_cell_stale (origin, product, row_idx, col_idx, day)
				SELECT DISTINCT r.origin, r.product, r.row_idx, r.col_idx, k.day
				FROM (
					SELECT g.day::date AS day, (s.x ->> 'r0')::integer AS r0, (s.x ->> 'r1')::integer AS r1, (s.x ->> 'c0')::integer AS c0, (s.x ->> 'c1')::integer AS c1
					FROM jsonb_array_elements(part) AS s(x), generate_series((s.x ->> 'from')::date, (s.x ->> 'to')::date, interval '1 day') AS g(day)
				) k
				JOIN chirps_cell_year r ON r.origin = p_origin AND r.product = p_product AND r.year = extract(year FROM k.day)::integer
					AND r.row_idx BETWEEN k.r0 AND k.r1 AND r.col_idx BETWEEN k.c0 AND k.c1
				WHERE r.final[k.day - make_date(r.year, 1, 1) + 1] AND r.vals[k.day - make_date(r.year, 1, 1) + 1] IS NOT NULL
				ORDER BY k.day, r.row_idx, r.col_idx
				ON CONFLICT (origin, product, row_idx, col_idx, day) DO UPDATE SET marked_at = now();
			GET DIAGNOSTICS n_marked = ROW_COUNT;
			INSERT INTO mirror_change (origin, product, target_revision, idx, revision, day_from, day_to, r0, r1, c0, c1)
				SELECT p_origin, p_product, p_revision, (x.e ->> 'idx')::integer, (x.e ->> 'rev')::integer, (x.e ->> 'from')::date, (x.e ->> 'to')::date,
					(x.e ->> 'r0')::integer, (x.e ->> 'r1')::integer, (x.e ->> 'c0')::integer, (x.e ->> 'c1')::integer
				FROM jsonb_array_elements(part) AS x(e);
		END IF;

		IF i < n_todo THEN
			RETURN QUERY SELECT stored, false, n_marked, n_todo - i;
			RETURN;
		END IF;
		INSERT INTO mirror_manifest AS m (origin, product, revision, applied_at, manifest)
			VALUES (p_origin, p_product, p_revision, now(), p_manifest)
			ON CONFLICT (origin, product) DO UPDATE SET revision = EXCLUDED.revision, applied_at = EXCLUDED.applied_at, manifest = EXCLUDED.manifest;
		-- The log is needed only by fetches queued before it (minutes) and by a resumed apply of a revision not yet recorded.
		DELETE FROM mirror_change mc WHERE mc.origin = p_origin AND mc.product = p_product
			AND mc.target_revision <= p_revision AND mc.applied_at < now() - interval '30 days';
		RETURN QUERY SELECT p_revision, true, n_marked, 0;
	END
	$$;

-- app_mirror_record_copy, from 246's definition (its only one): era5l and
-- imerg_late too, their days from their first; era5l with no prelimThrough,
-- imerg_late (as prelim) with no finalThrough.
CREATE OR REPLACE FUNCTION app_mirror_record_copy(p_origin text, p_product text, p_manifest jsonb) RETURNS void
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		f date;
		p date;
		k text;
		v jsonb;
	BEGIN
		IF NOT mirror_worker_context() THEN
			RAISE EXCEPTION 'the copy''s manifests are recorded only by the worker' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_origin IS NULL OR p_origin NOT IN ('chc', 'fixtures') OR p_product IS NULL OR (p_product <> 'prelim' AND NOT mirror_cache_product(p_product))
			OR jsonb_typeof(p_manifest) IS DISTINCT FROM 'object' OR octet_length(p_manifest::text) > 4194304
			OR p_manifest ->> 'product' IS DISTINCT FROM p_product
			OR jsonb_typeof(p_manifest -> 'revision') IS DISTINCT FROM 'number' OR (p_manifest ->> 'revision') !~ '^[1-9][0-9]{0,8}$' THEN
			RAISE EXCEPTION 'not a manifest of CHIRPS %', p_product USING ERRCODE = 'check_violation';
		END IF;
		FOREACH k IN ARRAY ARRAY['finalThrough', 'prelimThrough'] LOOP
			v := p_manifest -> k;
			CONTINUE WHEN v IS NULL OR jsonb_typeof(v) = 'null';
			IF jsonb_typeof(v) <> 'string' OR v #>> '{}' !~ '^\d{4}-\d{2}-\d{2}$' THEN
				RAISE EXCEPTION 'the manifest''s % is not a date', k USING ERRCODE = 'check_violation';
			END IF;
			BEGIN
				IF k = 'finalThrough' THEN f := (v #>> '{}')::date; ELSE p := (v #>> '{}')::date; END IF;
			EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
				RAISE EXCEPTION 'the manifest''s % is not a date', k USING ERRCODE = 'check_violation';
			END;
		END LOOP;
		IF (f IS NOT NULL AND (to_char(f, 'YYYY-MM-DD') <> p_manifest ->> 'finalThrough' OR f < coalesce(mirror_product_first_day(p_product), date '1981-01-01') OR f > (now() AT TIME ZONE 'UTC')::date))
			OR (p IS NOT NULL AND (to_char(p, 'YYYY-MM-DD') <> p_manifest ->> 'prelimThrough' OR p < coalesce(mirror_product_first_day(p_product), date '1981-01-01') OR p > (now() AT TIME ZONE 'UTC')::date))
			OR (p_product IN ('prelim', 'imerg_late') AND f IS NOT NULL) OR (p_product IN ('rnl', 'era5l') AND p IS NOT NULL) THEN
			RAISE EXCEPTION 'the manifest''s days are not CHIRPS %''s', p_product USING ERRCODE = 'check_violation';
		END IF;
		INSERT INTO mirror_copy AS c (origin, product, revision, final_through, prelim_through, seen_at)
			VALUES (p_origin, p_product, (p_manifest ->> 'revision')::integer, f, p, now())
			ON CONFLICT (origin, product) DO UPDATE SET revision = EXCLUDED.revision, final_through = EXCLUDED.final_through,
				prelim_through = EXCLUDED.prelim_through, seen_at = EXCLUDED.seen_at;
	END
	$$;

-- Nothing calls 245's one-argument form any more (app_mirror_apply_revision took it).
DROP FUNCTION mirror_region_cells(jsonb);
