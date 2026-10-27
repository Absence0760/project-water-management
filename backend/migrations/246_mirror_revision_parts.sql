-- 246_mirror_revision_parts — a revision of our CHIRPS copy applied in parts,
-- and a fetch that read before it can no longer undo it (issue #604 R2-D;
-- docs/data-model.md § Mirror revisions).
--
-- 1. Parts. 245's app_mirror_apply_revision marks at most 4000 days a call,
--    and the revision it records must be the manifest's, so a revision CHC
--    makes of years of data (it has rewritten the 2024 dailies and the annual
--    NetCDFs) was refused for good. Now one call marks the next run of the
--    revision's days, up to 4000 days and 1,000,000 estimated cell-days (an
--    entry split by days if it must), logs each run it marked in
--    mirror_change (one transaction per call), and records the revision only
--    when the last entry is marked: `remaining` says how many are left. A
--    worker that dies between calls leaves the runs it marked logged, and
--    the next call (the next tick) carries on after them. One call per part
--    rather than all of a revision in one transaction: a 45-year rewrite is
--    16,000 days, and one transaction holding every day's file row that long
--    would stall every CHIRPS fetch behind it, and start again from nothing
--    after a timeout.
--
--    The baseline. The first manifest of an origin and product the cache
--    sees (no revision stored: the cutover to CHIRPS_SOURCE=mirror) marks
--    every cached final inside the region, in the same parts, rather than its
--    `changes`: the cache holds finals read from CHC's own files, CHC may
--    have rewritten some before the copy existed, and the copy's `changes`
--    start with its own history, so nothing else would ever read them again
--    (with the copy as source no fetch HEADs CHC's files).
--
-- 2. The stale-mark race. A fetch that read a value before a revision
--    reached the copy, and lands it after the revision was applied, wrote the
--    old value back as current:
--    * chirps_recheck_apply cleared the revision's stale marks for the days it
--      re-read. Now it clears only a mark made no later than its fetch job was
--      queued (job.created_at: every read of that job comes after it, and
--      every retry of it too); a later mark stays, and the day is read again.
--      A revision, or a HEAD that finds a rewritten file, now refreshes the
--      marked_at of a mark already there (210 and 245 left it as it was).
--    * chirps_cache_merge (and chirps_recheck_apply's re-read) could cache an
--      old final for a cell the revision didn't mark because nobody had
--      cached it yet. Now each marks stale the finals it read inside a change
--      applied after its fetch was queued (mirror_mark_raced). Both take a
--      lock the apply holds exclusively, shared, so the apply either sees the
--      fetch's cells and marks them, or committed before the fetch looks.
--    Over-marking costs one more read of an unchanged value; under-marking
--    kept a wrong value cached for good.
--
-- chirps_cache_merge and chirps_recheck_apply keep their signatures (callers
-- unchanged); app_mirror_apply_revision gains a `remaining` column, so it is
-- dropped and made again (worker only, as 245).

-- One row per run of days of an entry of a revision's `changes` a call
-- marked (an entry larger than a part is split by days, a row each): which
-- revision it was applied for (target_revision) and the entry's place among
-- that revision's entries to mark (idx), its own revision, the days of the
-- run and the grid cells. What a
-- resumed apply skips, and what a fetch queued before applied_at checks its
-- finals against. Pruned 30 days after its revision is recorded.
CREATE TABLE mirror_change (
	origin          text NOT NULL CHECK (origin IN ('chc', 'fixtures')),
	product         text NOT NULL CHECK (product IN ('sat', 'rnl')),
	target_revision integer NOT NULL CHECK (target_revision >= 1),
	idx             integer NOT NULL CHECK (idx BETWEEN 1 AND 1000),
	revision        integer NOT NULL CHECK (revision BETWEEN 1 AND target_revision),
	day_from        date NOT NULL,
	day_to          date NOT NULL,
	r0              integer NOT NULL CHECK (r0 BETWEEN 0 AND 2399),
	r1              integer NOT NULL CHECK (r1 BETWEEN r0 AND 2399),
	c0              integer NOT NULL CHECK (c0 BETWEEN 0 AND 7199),
	c1              integer NOT NULL CHECK (c1 BETWEEN c0 AND 7199),
	applied_at      timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (origin, product, target_revision, idx, day_from),
	CHECK (day_from <= day_to AND day_to - day_from < 366)
);
CREATE INDEX mirror_change_applied ON mirror_change (origin, product, applied_at);
COMMENT ON TABLE mirror_change IS
	'Each run of days of an entry of a revision of our CHIRPS copy an apply marked (246): what a resumed apply skips, and what a fetch queued before it checks its finals against. Written only by app_mirror_apply_revision.';

ALTER TABLE mirror_change ENABLE ROW LEVEL SECURITY;
CREATE POLICY mirror_change_select ON mirror_change FOR SELECT USING (app_current_user_id() IS NOT NULL);
GRANT SELECT ON mirror_change TO water_app;

-- 3. What the copy holds, for the API. The data feeds panel shows how far
--    each product of the copy runs (finalThrough, prelimThrough), but only
--    the worker can reach the copy (the API has no MIRROR_URL, no bucket
--    grant, no endpoint statement). So the worker's tick records each
--    product's manifest summary here whenever the manifest changes, a new
--    month as well as a revision, the preliminary product too, and a
--    signed-in request reads this table.
CREATE TABLE mirror_copy (
	origin         text NOT NULL CHECK (origin IN ('chc', 'fixtures')),
	product        text NOT NULL CHECK (product IN ('sat', 'rnl', 'prelim')),
	revision       integer NOT NULL CHECK (revision >= 1),
	final_through  date,
	prelim_through date,
	seen_at        timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (origin, product),
	CHECK (product <> 'prelim' OR final_through IS NULL),
	CHECK (product <> 'rnl' OR prelim_through IS NULL)
);
COMMENT ON TABLE mirror_copy IS
	'How far each product of our CHIRPS copy runs, from its manifest as the worker''s tick last read it (246): for the data feeds panel, since only the worker reaches the copy. Written only by app_mirror_record_copy.';

ALTER TABLE mirror_copy ENABLE ROW LEVEL SECURITY;
CREATE POLICY mirror_copy_select ON mirror_copy FOR SELECT USING (app_current_user_id() IS NOT NULL);
GRANT SELECT ON mirror_copy TO water_app;

-- Record product p_product's manifest p_manifest (as read from the copy) in
-- mirror_copy: its revision, finalThrough and prelimThrough. Worker only (no
-- user, no API key). Bounds (else 23514): origin and product known; the
-- manifest an object of at most 4 MB naming the product, with an integer
-- revision >= 1, and each day null or an ISO date from 1981-01-01 to today
-- (UTC), finalThrough null for prelim and prelimThrough null for rnl.
CREATE FUNCTION app_mirror_record_copy(p_origin text, p_product text, p_manifest jsonb) RETURNS void
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
		IF p_origin IS NULL OR p_origin NOT IN ('chc', 'fixtures') OR p_product IS NULL OR p_product NOT IN ('sat', 'rnl', 'prelim')
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
		IF (f IS NOT NULL AND (to_char(f, 'YYYY-MM-DD') <> p_manifest ->> 'finalThrough' OR f < date '1981-01-01' OR f > (now() AT TIME ZONE 'UTC')::date))
			OR (p IS NOT NULL AND (to_char(p, 'YYYY-MM-DD') <> p_manifest ->> 'prelimThrough' OR p < date '1981-01-01' OR p > (now() AT TIME ZONE 'UTC')::date))
			OR (p_product = 'prelim' AND f IS NOT NULL) OR (p_product = 'rnl' AND p IS NOT NULL) THEN
			RAISE EXCEPTION 'the manifest''s days are not CHIRPS %''s', p_product USING ERRCODE = 'check_violation';
		END IF;
		INSERT INTO mirror_copy AS c (origin, product, revision, final_through, prelim_through, seen_at)
			VALUES (p_origin, p_product, (p_manifest ->> 'revision')::integer, f, p, now())
			ON CONFLICT (origin, product) DO UPDATE SET revision = EXCLUDED.revision, final_through = EXCLUDED.final_through,
				prelim_through = EXCLUDED.prelim_through, seen_at = EXCLUDED.seen_at;
	END
	$$;
COMMENT ON FUNCTION app_mirror_record_copy(text, text, jsonb) IS
	'Records how far a product of our CHIRPS copy runs (revision, finalThrough, prelimThrough) from its manifest, in mirror_copy (246), for the API to read. From the worker (no user) only.';
REVOKE ALL ON FUNCTION app_mirror_record_copy(text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_mirror_record_copy(text, text, jsonb) TO water_app;

-- When the fetch behind data-feed job p_job was queued: the job's own
-- created_at for a feed_fetch (it reads after that, every attempt), and for a
-- feed_ingest the created_at of the feed_fetch its answer is to (the fetcher
-- read after that), else -infinity (nothing known: assume the read is old).
CREATE FUNCTION chirps_read_since(p_job uuid) RETURNS timestamptz
	LANGUAGE sql STABLE SET search_path = public
	AS $$
		SELECT CASE j.kind
			WHEN 'feed_ingest' THEN coalesce((
				SELECT f.created_at FROM job f
				WHERE f.project_id = j.project_id AND f.kind = 'feed_fetch'
					AND f.id::text = j.payload ->> 'fetchJobId'), '-infinity')
			ELSE j.created_at END
		FROM job j WHERE j.id = p_job
	$$;
REVOKE ALL ON FUNCTION chirps_read_since(uuid) FROM PUBLIC;

-- Mark stale the cached finals of cells p_rows / p_cols on days p_days (what
-- a fetch just read) that fall inside a change of our copy applied after
-- p_since (the fetch's chirps_read_since): the fetch may have read them
-- before the copy changed. Each day's file row is locked first, in day order
-- (210's rule for writing stale rows). Called by chirps_cache_merge and
-- chirps_recheck_apply, as their owner; returns the cell-days marked.
CREATE FUNCTION mirror_mark_raced(p_origin text, p_product text, p_since timestamptz, p_days date[], p_rows integer[], p_cols integer[])
	RETURNS integer
	LANGUAGE plpgsql SET search_path = public
	AS $$
	DECLARE
		hit date[];
		n integer;
	BEGIN
		IF p_since IS NULL OR coalesce(cardinality(p_days), 0) = 0 OR coalesce(cardinality(p_rows), 0) = 0
			OR NOT EXISTS (SELECT 1 FROM mirror_change mc WHERE mc.origin = p_origin AND mc.product = p_product AND mc.applied_at > p_since) THEN
			RETURN 0;
		END IF;
		SELECT coalesce(array_agg(DISTINCT d.day ORDER BY d.day), '{}') INTO hit
			FROM unnest(p_days) AS d(day)
			WHERE EXISTS (SELECT 1 FROM mirror_change mc WHERE mc.origin = p_origin AND mc.product = p_product AND mc.applied_at > p_since
				AND d.day BETWEEN mc.day_from AND mc.day_to);
		IF cardinality(hit) = 0 THEN
			RETURN 0;
		END IF;
		PERFORM 1 FROM chirps_file cf WHERE cf.origin = p_origin AND cf.product = p_product AND cf.day = ANY (hit) ORDER BY cf.day FOR UPDATE;
		INSERT INTO chirps_cell_stale (origin, product, row_idx, col_idx, day)
			SELECT DISTINCT p_origin, p_product, k.r, k.c, d.day
			FROM unnest(hit) AS d(day)
			CROSS JOIN unnest(p_rows, p_cols) AS k(r, c)
			JOIN chirps_cell_year y ON y.origin = p_origin AND y.product = p_product AND y.row_idx = k.r AND y.col_idx = k.c
				AND y.year = extract(year FROM d.day)::integer
			WHERE y.final[d.day - make_date(y.year, 1, 1) + 1] AND y.vals[d.day - make_date(y.year, 1, 1) + 1] IS NOT NULL
				AND EXISTS (SELECT 1 FROM mirror_change mc WHERE mc.origin = p_origin AND mc.product = p_product AND mc.applied_at > p_since
					AND d.day BETWEEN mc.day_from AND mc.day_to AND k.r BETWEEN mc.r0 AND mc.r1 AND k.c BETWEEN mc.c0 AND mc.c1)
			ORDER BY 5, 3, 4
			ON CONFLICT (origin, product, row_idx, col_idx, day) DO UPDATE SET marked_at = now();
		GET DIAGNOSTICS n = ROW_COUNT;
		RETURN n;
	END
	$$;
REVOKE ALL ON FUNCTION mirror_mark_raced(text, text, timestamptz, date[], integer[], integer[]) FROM PUBLIC;

-- app_mirror_apply_revision, from 245's definition (its only one), now in
-- parts. p_changes is the manifest's `changes` list, or the part of it the
-- caller hasn't applied (the tick passes only the entries above the stored
-- revision, at most 1000, mirror-tick.ts nextBatch), checked whole on every
-- call (bounds as 245's, else 23514). The entries to mark are those above the
-- stored revision with cellsChanged > 0, in list order.
--
-- The baseline: with no stored revision (the first manifest of this origin
-- and product the cache sees, at the cutover to CHIRPS_SOURCE=mirror) the
-- entries are not what is marked. The cache holds finals read from CHC's own
-- files, and CHC may have rewritten some before the copy existed (the copy
-- holds them revised, and its `changes` start with its own history), so
-- every cached final inside the region is marked instead: one entry per year
-- the cache holds a cell of, the whole region, in year order.
--
-- A part is bounded twice: at most 4000 days (each day's chirps_file row is
-- locked), and at most 1,000,000 estimated cell-days. The estimate is a day
-- times the cell-year rows the cache holds that year inside the manifest's
-- region (counted once per call): an upper bound on the stale rows the part
-- inserts. One part's stale rows are one statement in one transaction, so it
-- must finish well inside the worker's time (300 s, the tick's own 60 s):
-- a million rows on the minimal tier's database take seconds, where the
-- days bound alone, with a few thousand cached cells, came to tens of
-- millions, and a part that times out rolls back, logs nothing, and is tried
-- again the same way for ever. A part takes at least one day (progress), and
-- an entry that doesn't fit is split by days: mirror_change logs each run of
-- days marked, an entry in one or more rows.
--
-- A call skips what mirror_change already logged for this p_revision (a
-- resumed apply: the log must be a prefix of this call's entries, run after
-- run, else it is dropped and the revision starts again, re-marking), marks
-- the next part, logs it, and returns:
--   revision  the stored revision after the call (NULL: none yet);
--   applied   true when this call recorded p_revision (the last part);
--   marked    cell-days marked (or re-marked) by this call;
--   remaining entries not wholly marked yet: 0 when the revision is
--             recorded, or when p_revision is not newer than the stored one
--             (applied false: nothing changes).
-- A mark already there takes this call's time (marked_at), so a fetch queued
-- before it doesn't clear it (chirps_recheck_apply).
--
-- Locks: the product's advisory lock, exclusive (two ticks never apply at
-- once; every fetch's merge and re-check of the product takes it shared),
-- waiting at most 30 s; then each day's chirps_file row in day order (210's
-- rule), waiting at most 500 ms: a fetch that holds a day's file row (an
-- inline fetch's claim) and waits for the shared lock would otherwise
-- deadlock with this call. On a timeout (55P03) the call is refused whole,
-- and the tick tries again next time.
DROP FUNCTION app_mirror_apply_revision(text, text, integer, jsonb, jsonb);
CREATE FUNCTION app_mirror_apply_revision(p_origin text, p_product text, p_revision integer, p_changes jsonb, p_manifest jsonb)
	RETURNS TABLE (revision integer, applied boolean, marked integer, remaining integer)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public SET lock_timeout = '30s'
	AS $$
	#variable_conflict use_column
	DECLARE
		part_days constant integer := 4000;
		part_cell_days constant bigint := 1000000;
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
				SELECT * INTO er FROM mirror_region_cells(ch -> 'region');
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
COMMENT ON FUNCTION app_mirror_apply_revision(text, text, integer, jsonb, jsonb) IS
	'Brings the CHIRPS cell cache up to a revision of our copy (245, in parts since 246): each call marks stale every cached final of the next changed days in the region (every cached final in the region, year by year, when no revision is stored yet: the baseline), up to 4000 days and 1,000,000 estimated cell-days, logs them in mirror_change, and records the revision in mirror_manifest when the last is marked. An older or equal revision changes nothing. From the worker (no user) only.';
REVOKE ALL ON FUNCTION app_mirror_apply_revision(text, text, integer, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_mirror_apply_revision(text, text, integer, jsonb, jsonb) TO water_app;

-- chirps_cache_merge, from 210's definition (its latest): it takes the
-- revision apply's lock shared, and marks the finals it read inside a change
-- applied since its fetch was queued (mirror_mark_raced).
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
COMMENT ON FUNCTION chirps_cache_merge(uuid, text, text, date, text, integer[], integer[], real[], text[]) IS
	'Merges one CHIRPS fetch''s cell values into the shared cell cache (208, 210), from a running job of that CHIRPS feed only: every value checked (0–2000 mm or NaN), a final value never replaced by a preliminary one nor by a different final (the re-check does that), each final file''s tag recorded, and a final read before a revision of our copy applied since marked stale (246). Returns the cell-days changed.';
REVOKE ALL ON FUNCTION chirps_cache_merge(uuid, text, text, date, text, integer[], integer[], real[], text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chirps_cache_merge(uuid, text, text, date, text, integer[], integer[], real[], text[]) TO water_app;

-- chirps_recheck_apply, from 210's definition (its only one): a stale mark made
-- after its fetch was queued is kept, a revision's or a HEAD's mark refreshes
-- marked_at, and it takes the apply's lock shared and marks as the merge does.
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
COMMENT ON FUNCTION chirps_recheck_apply(uuid, uuid, text, text, date[], text[], date[], text[], integer[], integer[], real[]) IS
	'Applies one CHIRPS re-check answer (210): a rewritten file''s cached finals marked stale, and stale or unverified days read again replacing their finals, each revised day logged in chirps_revision; a stale mark made after the fetch was queued kept, and a day read before a revision of our copy applied since marked again (246). From a running data-feed job of that feed, for the days its fetch claimed or its cells hold stale only.';
REVOKE ALL ON FUNCTION chirps_recheck_apply(uuid, uuid, text, text, date[], text[], date[], text[], integer[], integer[], real[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chirps_recheck_apply(uuid, uuid, text, text, date[], text[], date[], text[], integer[], integer[], real[]) TO water_app;
