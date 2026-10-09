-- 208_chirps_cell_cache — one shared cache of CHIRPS v3 daily values per grid
-- cell, so every CHIRPS feed over a cell reads it from CHC once, for every
-- project (issue #482 part A; docs/architecture.md § Data feeds → The CHIRPS
-- cell cache, docs/security.md § Input handling → The shared CHIRPS cell
-- cache, docs/data-model.md § The CHIRPS cell cache).
--
-- Before this, each feed read its own cells' days from CHC's daily GeoTIFFs
-- and kept only their weighted mean in its series: a second project over the
-- same cells downloaded the same bytes again, at one 120-day window a minute.
-- Now a fetch works out which of its cells' days this table lacks or holds
-- only as preliminary (feeds/cellCache.ts planFetch), the fetcher reads just
-- those (each cell's own value, never the mean), the worker merges them here
-- through chirps_cache_merge, and the feed's days are computed from here with
-- the same arithmetic as before.
--
-- Reference data, global, with no project_id: any signed-in session reads it
-- (it holds public CHIRPS values, nothing about anyone), and nobody writes it
-- but chirps_cache_merge, a SECURITY DEFINER function that only a running
-- data-feed job may call. Because a row is shared by every tenant, a wrong
-- value written by one would reach every project over that cell: so the
-- function refuses any value outside 0–2000 mm (NaN marks no data, the sea),
-- any day CHIRPS can't have, and any preliminary value over a final one.
--
-- One row per origin, product, cell and year:
--   origin         'chc' (the real files) or 'fixtures' (FEED_SOURCE=fixtures,
--                  the synthetic grids of dev, CI and e2e), so a database that
--                  ran on the fixtures never serves their values to a live feed.
--   product        'sat' or 'rnl' (feeds/config.ts CHIRPS_DAILY_PRODUCTS),
--                  never mixed: their daily timing differs.
--   row_idx, col_idx  the CHC grid's 0.05° cell, row 0 at 60° N, column 0 at
--                  180° W (feeds/cellCache.ts chcCell).
--   vals           366 float32 values from 1 January: NULL = not fetched (or
--                  not published), NaN = no data (the sea). 31 December of a
--                  common year is the 365th; the 366th stays NULL.
--   final          366 booleans: whether each day's value came from the final
--                  file. A final value is never read again; a preliminary one
--                  is read again from its final file until that is out. Per
--                  day, so a preliminary value filling a gap in the archive
--                  never makes the finals after it look preliminary.
--   final_through  the day before the row's first preliminary value (31
--                  December when it holds none): a summary of `final`, every
--                  value on or before it final.
--   source_etag    reserved for re-checking finals CHC rewrites in place
--                  (issue #482's gotchas); not written yet.
--   fetched_at     when a merge last changed the row.
-- About 1.5 KB a row: a 100-cell project over 1981–2026 is about 7 MB.
CREATE TABLE chirps_cell_year (
	origin        text NOT NULL CHECK (origin IN ('chc', 'fixtures')),
	product       text NOT NULL CHECK (product IN ('sat', 'rnl')),
	row_idx       integer NOT NULL CHECK (row_idx BETWEEN 0 AND 2399),
	col_idx       integer NOT NULL CHECK (col_idx BETWEEN 0 AND 7199),
	year          integer NOT NULL,
	vals          real[] NOT NULL,
	final         boolean[] NOT NULL,
	final_through date NOT NULL,
	source_etag   text CHECK (char_length(source_etag) <= 200),
	fetched_at    timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (origin, product, row_idx, col_idx, year),
	-- sat begins in 1998, rnl in 1981 (feeds/config.ts CHIRPS_PRODUCT_FIRST_DAY).
	CONSTRAINT chirps_cell_year_year CHECK (year BETWEEN (CASE product WHEN 'sat' THEN 1998 ELSE 1981 END) AND 2200),
	CONSTRAINT chirps_cell_year_shape CHECK (array_ndims(vals) = 1 AND array_lower(vals, 1) = 1 AND array_length(vals, 1) = 366
		AND array_ndims(final) = 1 AND array_lower(final, 1) = 1 AND array_length(final, 1) = 366 AND array_position(final, NULL) IS NULL),
	CONSTRAINT chirps_cell_year_final CHECK (final_through BETWEEN make_date(year, 1, 1) - 1 AND make_date(year, 12, 31))
);
COMMENT ON TABLE chirps_cell_year IS
	'Shared CHIRPS v3 daily values per 0.05° cell and year (208): reference data for every project. Read by any signed-in session; written only through chirps_cache_merge.';

ALTER TABLE chirps_cell_year ENABLE ROW LEVEL SECURITY;
CREATE POLICY chirps_cell_year_select ON chirps_cell_year FOR SELECT USING (app_current_user_id() IS NOT NULL);
GRANT SELECT ON chirps_cell_year TO water_app;

-- Merge one fetch's cell values, for feed p_feed. p_rows / p_cols name the
-- cells, strictly in (row, column) order, so two merges lock shared rows in
-- the same order and never deadlock. p_read has one character per day from
-- p_first: 'f' read from the final file, 'p' from the preliminary one, '-'
-- not read. p_vals holds each cell's days in turn (cell 1's days, then cell
-- 2's, …): a value (or NaN, no data) on every day read, NULL on every day not
-- read.
--
-- The caller must be running a data-feed job of p_feed (feed_fetch or
-- feed_ingest, its lease live), still an editor of its project, and p_feed a
-- CHIRPS feed of p_product. That the cells are the feed's own and the days
-- inside the window it asked for is checked by the ingest before the call
-- (feeds/ingest.ts fromCells): the cells a config names (a bounding box's
-- area weights, a boundary's clipping) are worked out in TypeScript only.
--
-- A final value always lands (CHC may rewrite a final in place). A
-- preliminary one lands only on a day whose value isn't final: a final is
-- never replaced by a preliminary value. Returns how many cell-days changed.
CREATE FUNCTION chirps_cache_merge(p_feed uuid, p_origin text, p_product text, p_first date, p_read text, p_rows integer[], p_cols integer[], p_vals real[])
	RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		uid uuid := app_current_user_id();
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
		day date;
		jan1 date;
		cellv real[];
		cur real[];
		fin boolean[];
		first_prelim integer;
	BEGIN
		-- Only a data feed's own fetch, as its acting user, still an editor of its project.
		IF uid IS NULL OR p_feed IS NULL OR NOT EXISTS (
			SELECT 1 FROM job j JOIN data_feed f ON f.id = p_feed AND f.project_id = j.project_id
			WHERE j.acting_user_id = uid AND j.status = 'running' AND j.locked_until > now()
				AND j.kind IN ('feed_fetch', 'feed_ingest') AND j.payload ->> 'feedId' = p_feed::text
				AND f.source = 'chirps' AND coalesce(f.config ->> 'product', 'sat') = p_product
				AND app_has_role(j.project_id, 'editor')
		) THEN
			RAISE EXCEPTION 'the CHIRPS cell cache is written only by a data feed''s fetch' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_origin IS NULL OR p_origin NOT IN ('chc', 'fixtures') OR p_product NOT IN ('sat', 'rnl') OR p_first IS NULL THEN
			RAISE EXCEPTION 'not a CHIRPS origin and product' USING ERRCODE = 'check_violation';
		END IF;
		IF n_cells = 0 OR n_days = 0 THEN
			RETURN 0;
		END IF;
		IF p_read !~ '^[-fp]+$' OR n_days > 366 OR n_cells > 100 THEN
			RAISE EXCEPTION 'not a fetch of at most 100 cells over at most 366 days' USING ERRCODE = 'check_violation';
		END IF;
		IF p_product = 'rnl' AND strpos(p_read, 'p') > 0 THEN
			RAISE EXCEPTION 'rnl has no preliminary values' USING ERRCODE = 'check_violation';
		END IF;
		IF array_ndims(p_rows) <> 1 OR array_ndims(p_cols) <> 1 OR array_length(p_cols, 1) IS DISTINCT FROM n_cells
			OR array_ndims(p_vals) <> 1 OR array_length(p_vals, 1) IS DISTINCT FROM n_cells * n_days
			OR array_lower(p_rows, 1) <> 1 OR array_lower(p_cols, 1) <> 1 OR array_lower(p_vals, 1) <> 1 THEN
			RAISE EXCEPTION 'one value per cell and day' USING ERRCODE = 'check_violation';
		END IF;
		last_day := p_first + n_days - 1;
		-- No day before the product begins, nor after today (UTC): CHIRPS can't have it.
		IF p_first < (CASE p_product WHEN 'sat' THEN date '1998-01-01' ELSE date '1981-01-01' END) OR last_day > (now() AT TIME ZONE 'UTC')::date THEN
			RAISE EXCEPTION 'a day CHIRPS % does not have', p_product USING ERRCODE = 'check_violation';
		END IF;
		FOR c IN 1 .. n_cells LOOP
			IF p_rows[c] IS NULL OR p_cols[c] IS NULL OR p_rows[c] NOT BETWEEN 0 AND 2399 OR p_cols[c] NOT BETWEEN 0 AND 7199 THEN
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
		RETURN changed;
	END
	$$;
COMMENT ON FUNCTION chirps_cache_merge(uuid, text, text, date, text, integer[], integer[], real[]) IS
	'Merges one CHIRPS fetch''s cell values into the shared cell cache (208), from a running job of that CHIRPS feed only: every value checked (0–2000 mm or NaN), and a final value never replaced by a preliminary one. Returns the cell-days changed.';
REVOKE ALL ON FUNCTION chirps_cache_merge(uuid, text, text, date, text, integer[], integer[], real[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chirps_cache_merge(uuid, text, text, date, text, integer[], integer[], real[]) TO water_app;
