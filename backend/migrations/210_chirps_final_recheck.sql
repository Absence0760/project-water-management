-- 210_chirps_final_recheck — re-check the cached CHIRPS finals that CHC
-- rewrites in place (issue #482's gotchas; docs/architecture.md § Data feeds
-- → Re-checking finals, docs/data-model.md § The CHIRPS cell cache).
--
-- CHC rewrites published final files without a version bump: the 2024
-- dailies in 2025-12, the COGs in 2026-04, the annual NetCDFs in 2026-08.
-- Until now a cached final (208_chirps_cell_cache) was never read again, so
-- a rewrite never reached a feed. Now:
--
-- * chirps_file: one row per origin, product and day (one final file), with
--   the file's tag (its ETag, else `lm:` + its Last-Modified) as of the read
--   the cached values came from. Per file, not per cell-year row: one file
--   covers every cell, and a cell-year row holds 366 files' values, so
--   208's reserved chirps_cell_year.source_etag (never written) was the
--   wrong grain and is dropped here.
-- * A slow re-check, piggybacked on CHIRPS feed fetches (the only path to
--   the internet in production is the fetcher Lambda, driven by a feed's
--   fetch, and only a running feed job may write the cache):
--   chirps_recheck_claim gives a fetch a few files to HEAD (tagged, oldest
--   checked first, not within p_interval_days) and a few days to read again
--   (its own cells' stale days first, then untagged files its cells hold).
--   chirps_recheck_apply takes the answer: a changed tag marks every cached
--   final value of that day stale (chirps_cell_stale), and a read replaces
--   a stale cell's final value with the file's new one. That is the only
--   way a final now replaces a different final: chirps_cache_merge (below)
--   keeps the cached final and flags the file to be checked first instead.
-- * chirps_revision: one row per day and apply whose final values changed
--   (the record of the revision). Each CHIRPS feed recomputes the days
--   logged since it last looked (by the writing transaction's id, so no row
--   committed late is skipped: feeds/ingest.ts refreshRevisedDays) and
--   merges them into its series, with a series.merged History event.
--
-- All three are reference data like chirps_cell_year: no project_id, read
-- by any signed-in session, written only by these SECURITY DEFINER
-- functions from a running data-feed job of a CHIRPS feed.

ALTER TABLE chirps_cell_year DROP COLUMN source_etag;

-- One final file. tag NULL: not known (a row cached before this migration,
-- or read by a fetcher that sent no tag): the re-check reads such a day
-- again and compares values. checked_at: when an answer last read or
-- HEADed it (NULL: check it first). claim_job / claim_until: the fetch job
-- asked to check it, and until when no other fetch may take it (a lease, so
-- a fetch that never answers — an outage, a dropped answer — frees its files
-- in half an hour rather than deferring them a whole interval; no foreign
-- key: a job row is purged, and an old claim is only overwritten).
CREATE TABLE chirps_file (
	origin      text NOT NULL CHECK (origin IN ('chc', 'fixtures')),
	product     text NOT NULL CHECK (product IN ('sat', 'rnl')),
	day         date NOT NULL,
	tag         text CHECK (char_length(tag) BETWEEN 1 AND 200),
	checked_at  timestamptz,
	claim_job   uuid,
	claim_until timestamptz,
	revised_at  timestamptz,
	revisions   integer NOT NULL DEFAULT 0 CHECK (revisions >= 0),
	PRIMARY KEY (origin, product, day),
	CONSTRAINT chirps_file_day CHECK (day >= CASE product WHEN 'sat' THEN date '1998-01-01' ELSE date '1981-01-01' END)
);
-- The claim's picking order: oldest checked first.
CREATE INDEX chirps_file_due ON chirps_file (origin, product, checked_at NULLS FIRST, day);
COMMENT ON TABLE chirps_file IS
	'One CHIRPS final file per origin, product and day (210): the tag the cached values came from, and when it was last checked. Written only by chirps_cache_merge, chirps_recheck_claim and chirps_recheck_apply.';

-- A cached final value whose file changed since it was read: read again by
-- the next fetch of a feed over that cell (chirps_recheck_claim).
CREATE TABLE chirps_cell_stale (
	origin    text NOT NULL CHECK (origin IN ('chc', 'fixtures')),
	product   text NOT NULL CHECK (product IN ('sat', 'rnl')),
	row_idx   integer NOT NULL CHECK (row_idx BETWEEN 0 AND 2399),
	col_idx   integer NOT NULL CHECK (col_idx BETWEEN 0 AND 7199),
	day       date NOT NULL,
	marked_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (origin, product, row_idx, col_idx, day)
);
COMMENT ON TABLE chirps_cell_stale IS
	'Cached CHIRPS final values whose file CHC rewrote since they were read (210): read again by a feed over the cell. Written only by chirps_recheck_apply.';

-- A day whose cached final values changed (a rewrite reached the cache).
-- xid: the writing transaction, so a reader can take exactly the rows
-- committed since it last looked (feeds/ingest.ts refreshRevisedDays).
CREATE TABLE chirps_revision (
	seq           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	origin        text NOT NULL CHECK (origin IN ('chc', 'fixtures')),
	product       text NOT NULL CHECK (product IN ('sat', 'rnl')),
	day           date NOT NULL,
	cells_changed integer NOT NULL CHECK (cells_changed > 0),
	tag_before    text CHECK (char_length(tag_before) <= 200),
	tag_after     text CHECK (char_length(tag_after) <= 200),
	xid           xid8 NOT NULL DEFAULT pg_current_xact_id(),
	detected_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chirps_revision_xid ON chirps_revision (origin, product, xid);
COMMENT ON TABLE chirps_revision IS
	'Days whose cached CHIRPS final values changed because CHC rewrote the file (210): the record of the revision, and what each feed refreshes its series from.';

ALTER TABLE chirps_file ENABLE ROW LEVEL SECURITY;
ALTER TABLE chirps_cell_stale ENABLE ROW LEVEL SECURITY;
ALTER TABLE chirps_revision ENABLE ROW LEVEL SECURITY;
CREATE POLICY chirps_file_select ON chirps_file FOR SELECT USING (app_current_user_id() IS NOT NULL);
CREATE POLICY chirps_cell_stale_select ON chirps_cell_stale FOR SELECT USING (app_current_user_id() IS NOT NULL);
CREATE POLICY chirps_revision_select ON chirps_revision FOR SELECT USING (app_current_user_id() IS NOT NULL);
GRANT SELECT ON chirps_file, chirps_cell_stale, chirps_revision TO water_app;

-- Every final already cached: a file whose tag isn't known, to be read again once.
INSERT INTO chirps_file (origin, product, day)
SELECT DISTINCT r.origin, r.product, make_date(r.year, 1, 1) + (d.o - 1)::integer
FROM chirps_cell_year r, unnest(r.final, r.vals) WITH ORDINALITY AS d(f, v, o)
WHERE d.f AND d.v IS NOT NULL
ON CONFLICT DO NOTHING;

-- The caller's running data-feed job of CHIRPS feed p_feed of p_product (one
-- of p_kinds, its lease live), its acting user still an editor; NULL when
-- there is none. The check chirps_cache_merge has made since 208, shared by
-- the functions below (each a SECURITY DEFINER, so this runs as the owner).
CREATE FUNCTION chirps_feed_job(p_feed uuid, p_product text, p_kinds text[])
	RETURNS uuid
	LANGUAGE sql STABLE SET search_path = public
	AS $$
		SELECT j.id FROM job j JOIN data_feed f ON f.id = p_feed AND f.project_id = j.project_id
		WHERE app_current_user_id() IS NOT NULL AND j.acting_user_id = app_current_user_id()
			AND j.status = 'running' AND j.locked_until > now()
			AND j.kind = ANY (p_kinds) AND j.payload ->> 'feedId' = p_feed::text
			AND f.source = 'chirps' AND coalesce(f.config ->> 'product', 'sat') = p_product
			AND app_has_role(j.project_id, 'editor')
		ORDER BY j.id LIMIT 1
	$$;
REVOKE ALL ON FUNCTION chirps_feed_job(uuid, text, text[]) FROM PUBLIC;

-- Whether t is a tag we keep: 1–200 printable ASCII characters, no edge spaces.
CREATE FUNCTION chirps_tag_ok(t text) RETURNS boolean
	LANGUAGE sql IMMUTABLE SET search_path = public
	AS $$ SELECT t IS NULL OR (char_length(t) <= 200 AND t ~ '^[!-~]([ -~]*[!-~])?$') $$;
REVOKE ALL ON FUNCTION chirps_tag_ok(text) FROM PUBLIC;

-- A cell-year row's final_through (208): the day before its first
-- preliminary value, else 31 December.
CREATE FUNCTION chirps_final_through(p_vals real[], p_final boolean[], p_year integer) RETURNS date
	LANGUAGE sql IMMUTABLE SET search_path = public
	AS $$
		SELECT coalesce(make_date(p_year, 1, 1) + min(o)::integer - 2, make_date(p_year, 12, 31))
		FROM unnest(p_vals, p_final) WITH ORDINALITY AS x(v, f, o) WHERE NOT x.f AND x.v IS NOT NULL
	$$;
REVOKE ALL ON FUNCTION chirps_final_through(real[], boolean[], integer) FROM PUBLIC;

-- chirps_cache_merge, from 208's definition (its only one), with two changes:
--   * p_tags (new, last, optional so a caller of the 208 form still works
--     through a rollout): per day of p_read, the final file's tag on an 'f'
--     day, NULL on any other. A day's file row is made with it; a known tag
--     that differs flags the file to be checked first (checked_at NULL).
--   * A final no longer replaces a different final here. CHC rewrites finals
--     in place, so it may differ: the cached value stays, the file is
--     flagged, and the re-check (chirps_recheck_apply) replaces it, recorded.
DROP FUNCTION chirps_cache_merge(uuid, text, text, date, text, integer[], integer[], real[]);
CREATE FUNCTION chirps_cache_merge(p_feed uuid, p_origin text, p_product text, p_first date, p_read text, p_rows integer[], p_cols integer[], p_vals real[], p_tags text[] DEFAULT NULL)
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
	BEGIN
		-- Only a data feed's own fetch, as its acting user, still an editor of its project.
		IF p_feed IS NULL OR p_product IS NULL OR chirps_feed_job(p_feed, p_product, ARRAY['feed_fetch', 'feed_ingest']) IS NULL THEN
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
		RETURN changed;
	END
	$$;
COMMENT ON FUNCTION chirps_cache_merge(uuid, text, text, date, text, integer[], integer[], real[], text[]) IS
	'Merges one CHIRPS fetch''s cell values into the shared cell cache (208, 210), from a running job of that CHIRPS feed only: every value checked (0–2000 mm or NaN), a final value never replaced by a preliminary one nor by a different final (the re-check does that), and each final file''s tag recorded. Returns the cell-days changed.';
REVOKE ALL ON FUNCTION chirps_cache_merge(uuid, text, text, date, text, integer[], integer[], real[], text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chirps_cache_merge(uuid, text, text, date, text, integer[], integer[], real[], text[]) TO water_app;

-- What one fetch of feed p_feed re-checks, claimed for its job (a running
-- feed_fetch job of the caller): up to p_reads days to read again for the
-- cells p_rows / p_cols (the feed's own, worked out in TypeScript, as for the
-- merge) — first the days any of them holds stale ('reread'), then untagged
-- files any of them holds final, not checked in the last day ('verify') —
-- and up to p_heads tagged files of the product to HEAD ('head'), any cells',
-- not checked within p_interval_days, oldest checked first. A claimed file is
-- leased to the job for 30 minutes (claim_until), so no other fetch takes it
-- meanwhile; its checked_at moves only when the answer is applied. A stale
-- day is not claimed (chirps_recheck_apply takes a read of it from any feed
-- over the cell). SKIP LOCKED: two fetches at once take different files.
-- In an inline fetch (local dev) the claim's file-row locks are held through
-- the merge, which takes cell rows then file rows: two inline fetches over
-- shared cells and files may then deadlock, which fails one job and retries
-- it. In production the claim commits with the fetch job, before the answer.
CREATE FUNCTION chirps_recheck_claim(p_feed uuid, p_origin text, p_product text, p_rows integer[], p_cols integer[], p_heads integer, p_reads integer, p_interval_days integer)
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
		IF p_origin IS NULL OR p_origin NOT IN ('chc', 'fixtures') OR p_product NOT IN ('sat', 'rnl')
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
COMMENT ON FUNCTION chirps_recheck_claim(uuid, text, text, integer[], integer[], integer, integer, integer) IS
	'Claims what one CHIRPS feed fetch re-checks (210): its cells'' stale days and untagged files to read again, and tagged files to HEAD, oldest checked first. From a running feed_fetch job of that feed only.';
REVOKE ALL ON FUNCTION chirps_recheck_claim(uuid, text, text, integer[], integer[], integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chirps_recheck_claim(uuid, text, text, integer[], integer[], integer, integer, integer) TO water_app;

-- Apply a re-check's answer, for feed p_feed, whose fetch job p_fetch_job
-- claimed it (the ingest has checked that the answer is that fetch's: the
-- same job inline, store.ts takeFeedFetch in production). The caller must be
-- running a data-feed job of p_feed, as for the merge.
--
--   p_head_days / p_head_tags: each HEADed file's tag now (NULL: gone, or it
--     sent none). Only a file this fetch claimed counts. A tag that differs
--     from the one recorded means CHC rewrote it: every cached final value
--     of that day becomes stale, to be read again, and the file takes the
--     new tag (revised_at, revisions).
--   p_read_days / p_read_tags / p_vals: each day read again, for the cells
--     p_rows / p_cols in (row, column) order, p_vals cell by cell (cell 1's
--     days, then cell 2's, …), every value 0–2000 mm or NaN, or NULL on every
--     cell of a day whose file is gone. Only a day this fetch claimed, or a
--     stale day of one of these cells, is taken; any other is left alone (a
--     late answer whose claim lapsed). A malformed answer is refused whole. Each
--     value lands as final, replacing a different final (the one path that
--     does), and the cell-day is no longer stale. A day whose values changed
--     is logged in chirps_revision; when its tag was not known, or changed
--     since recorded, the other cells' cached finals of that day become stale.
--
-- Lock order as the merge's: the cell rows (cell, then year), then the file
-- rows by day; a day's stale rows are written only under its file row's
-- lock (here and by a HEAD), so two applies never wait on each other's.
-- Returns the days logged as revised.
CREATE FUNCTION chirps_recheck_apply(p_feed uuid, p_fetch_job uuid, p_origin text, p_product text, p_head_days date[], p_head_tags text[], p_read_days date[], p_read_tags text[], p_rows integer[], p_cols integer[], p_vals real[])
	RETURNS integer
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	#variable_conflict use_column
	DECLARE
		n_heads integer := coalesce(array_length(p_head_days, 1), 0);
		n_reads integer := coalesce(array_length(p_read_days, 1), 0);
		n_cells integer := coalesce(array_length(p_rows, 1), 0);
		today date := (now() AT TIME ZONE 'UTC')::date;
		first_day date := CASE p_product WHEN 'sat' THEN date '1998-01-01' ELSE date '1981-01-01' END;
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
		IF p_origin IS NULL OR p_origin NOT IN ('chc', 'fixtures') OR p_product NOT IN ('sat', 'rnl') THEN
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
			IF p_rows[c] IS NULL OR p_cols[c] IS NULL OR p_rows[c] NOT BETWEEN 0 AND 2399 OR p_cols[c] NOT BETWEEN 0 AND 7199
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
					ON CONFLICT DO NOTHING;
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
			DELETE FROM chirps_cell_stale st USING unnest(p_rows, p_cols) AS k(r, c)
				WHERE st.origin = p_origin AND st.product = p_product AND st.row_idx = k.r AND st.col_idx = k.c AND st.day = f.d;
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
					ON CONFLICT DO NOTHING;
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
		RETURN logged;
	END
	$$;
COMMENT ON FUNCTION chirps_recheck_apply(uuid, uuid, text, text, date[], text[], date[], text[], integer[], integer[], real[]) IS
	'Applies one CHIRPS re-check answer (210): a rewritten file''s cached finals marked stale, and stale or unverified days read again replacing their finals, each revised day logged in chirps_revision. From a running data-feed job of that feed, for the days its fetch claimed or its cells hold stale only.';
REVOKE ALL ON FUNCTION chirps_recheck_apply(uuid, uuid, text, text, date[], text[], date[], text[], integer[], integer[], real[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chirps_recheck_apply(uuid, uuid, text, text, date[], text[], date[], text[], integer[], integer[], real[]) TO water_app;
