-- 247_gauge_record — our own store of DWS verified daily gauge flow (issue
-- #604 R3-B, design D14; docs/data-model.md § DWS gauge records).
--
-- Issue #604's rule: the app never fetches from someone else's server because
-- a feed asked. A DWS feed (018, source 'dws') read DWS's HyData.aspx page
-- per feed, through the fetcher Lambda. Now its station's days come from this
-- table instead (DWS_SOURCE=store, backend/src/feeds/fromGaugeRecord.ts),
-- which three writers fill:
--   * dws-web:     the fetcher's weekly pass (backend/src/ingest/dws.ts), the
--                  newest two years of each station some DWS feed reads,
--                  loaded by the worker through app_gauge_record_load_web.
--   * dws-request: DWS's reply to a written data request, which the operator
--                  loads with `pnpm import:dws <file>` (gauge_record_write,
--                  as the schema owner). The primary route for a station's
--                  history: it also settles storing the data and showing it
--                  in a commercial tool.
--   * upload:      any other DWS daily table the operator loads the same way
--                  (`--source upload`, e.g. a page saved by hand).
--
-- Reference data shared like the CHIRPS cell cache (208): no project, no
-- user; readable by any signed-in user, written only through the functions
-- below. water_app holds SELECT and nothing else.
--
-- Precedence. Each source keeps its own rows (one per origin, station, day
-- and source), so a load never destroys another source's values and a
-- disagreement stays visible. What a feed reads is gauge_record_current: per
-- day, the row of the best source, dws-request before dws-web before upload.
--   * dws-request first: DWS's own extract of Hydstra, sent to us in writing
--     for this use. It is the authoritative copy and the one we have
--     permission to keep.
--   * dws-web next: the same verified data, read from the public page. It is
--     fresher (weekly), so it fills every day a reply doesn't hold, but a
--     scrape whose layer DWS has seen fail (the ScriptServer page) doesn't
--     override the reply for a day both hold.
--   * upload last: a table of unknown provenance, used only where neither DWS
--     source has the day.
-- A gap row (a listed day with no value, e.g. quality 170 "permanent gap")
-- is a row like any other: DWS saying the day has no value is an answer.
--
-- Spans. A source "holds" a day once it was asked for that day (the web
-- pass's window, a reply's span), whether or not DWS listed a row for it:
-- gauge_record_span records the days each source covered. The feed reads
-- days a span covers as DWS's answer (no row is no data, as when the page
-- lists none), and waits for days no span covers yet (fromGaugeRecord.ts).
--
-- Origin, as the cell cache's: 'dws' for rows from DWS, 'fixtures' for the
-- synthetic page dev, CI and e2e feeds read (FEED_SOURCE=fixtures), so a
-- live process never reads a synthetic value.

CREATE TABLE gauge_record (
	origin     text NOT NULL CHECK (origin IN ('dws', 'fixtures')),
	-- A DWS river gauge (an H code), as the feed config allows (feeds/config.ts DWS_RIVER_GAUGE).
	station    text NOT NULL CHECK (station ~ '^[A-Z][0-9]H[0-9]{3}$'),
	day        date NOT NULL CHECK (day BETWEEN date '1900-01-01' AND date '2200-12-31'),
	source     text NOT NULL CHECK (source IN ('dws-web', 'dws-request', 'upload')),
	-- The daily mean flow in m³/s; NULL for a listed gap. NaN and ±Infinity fail the upper bound.
	value      double precision CHECK (value IS NULL OR (value >= 0 AND value <= 100000)),
	-- DWS's quality code as listed (Verified/HyCodes.aspx), if any.
	quality    text CHECK (quality IS NULL OR quality ~ '^[A-Za-z0-9]{1,8}$'),
	fetched_at timestamptz NOT NULL,
	-- dws-request: DWS's reply (its reference or letter); otherwise optional.
	reference  text CHECK (reference IS NULL OR char_length(reference) BETWEEN 1 AND 200),
	PRIMARY KEY (origin, station, day, source)
);
COMMENT ON TABLE gauge_record IS
	'DWS verified daily gauge flow, per source (247): the weekly web pass, DWS''s reply to a data request, an operator upload. Written only by gauge_record_write (operator) and app_gauge_record_load_web (worker); read through gauge_record_current.';

ALTER TABLE gauge_record ENABLE ROW LEVEL SECURITY;
CREATE POLICY gauge_record_select ON gauge_record FOR SELECT USING (app_current_user_id() IS NOT NULL);
GRANT SELECT ON gauge_record TO water_app;

-- The days each source has covered for a station: overlapping or adjacent
-- spans of one origin, station and source are merged as they are written.
CREATE TABLE gauge_record_span (
	origin     text NOT NULL CHECK (origin IN ('dws', 'fixtures')),
	station    text NOT NULL CHECK (station ~ '^[A-Z][0-9]H[0-9]{3}$'),
	source     text NOT NULL CHECK (source IN ('dws-web', 'dws-request', 'upload')),
	day_from   date NOT NULL CHECK (day_from >= date '1900-01-01'),
	day_to     date NOT NULL CHECK (day_to <= date '2200-12-31'),
	-- The newest fetch or load merged into the span.
	fetched_at timestamptz NOT NULL,
	reference  text CHECK (reference IS NULL OR char_length(reference) BETWEEN 1 AND 200),
	PRIMARY KEY (origin, station, source, day_from),
	CHECK (day_from <= day_to)
);
COMMENT ON TABLE gauge_record_span IS
	'The days each source of gauge_record has covered for a station, asked for whether or not DWS listed a row (247): a DWS feed reading the store waits for days no span covers.';

ALTER TABLE gauge_record_span ENABLE ROW LEVEL SECURITY;
CREATE POLICY gauge_record_span_select ON gauge_record_span FOR SELECT USING (app_current_user_id() IS NOT NULL);
GRANT SELECT ON gauge_record_span TO water_app;

-- The precedence of the sources (see the header): lower wins.
CREATE FUNCTION gauge_source_rank(p_source text) RETURNS integer
	LANGUAGE sql IMMUTABLE SET search_path = public
	AS $$ SELECT CASE p_source WHEN 'dws-request' THEN 1 WHEN 'dws-web' THEN 2 WHEN 'upload' THEN 3 END $$;

-- Per origin, station and day, the row of the best source. Runs as its caller, so RLS applies through it.
CREATE VIEW gauge_record_current WITH (security_invoker = true) AS
	SELECT DISTINCT ON (r.origin, r.station, r.day) r.origin, r.station, r.day, r.source, r.value, r.quality, r.fetched_at
	FROM gauge_record r
	ORDER BY r.origin, r.station, r.day, gauge_source_rank(r.source);
GRANT SELECT ON gauge_record_current TO water_app;

-- Write one source's rows for a station over the days p_from..p_to (one
-- request's worth or less): every row that source held in the span is
-- replaced by p_days/p_values/p_quality (a day the source no longer lists
-- goes), and the span is recorded as covered. Other sources' rows stay.
--
-- Bounds (else 23514): origin, source and a river gauge code known; the span
-- at most DWS's 20 years a request (7330 days) and ending no later than
-- today in South Africa; the arrays of one length, at most 7330 rows, each
-- day inside the span and listed once; each value NULL or a flow from 0 to
-- 100 000 m³/s (an order of magnitude above any South African river's
-- recorded peak), never NaN; each quality code 1–8 letters or digits;
-- p_fetched_at not in the future; a dws-request load names its reply
-- (p_reference, 1–200 characters).
--
-- A load whose p_fetched_at is no newer than the source's newest load
-- already covering the whole span changes nothing (applied = false): the
-- worker re-reading a week-old file after a restart.
--
-- The operator's (`pnpm import:dws`, as the schema owner). Invoker's rights
-- and closed to water_app, as authority_confirm_by_operator (229): the app
-- can't call it, and water_app holds no write on the tables anyway. The
-- worker's weekly load goes through app_gauge_record_load_web.
CREATE FUNCTION gauge_record_write(
	p_origin text, p_station text, p_source text, p_from date, p_to date,
	p_days date[], p_values double precision[], p_quality text[],
	p_fetched_at timestamptz, p_reference text,
	OUT written integer, OUT applied boolean
)
	LANGUAGE plpgsql SET search_path = public
	AS $$
	DECLARE
		n integer := coalesce(cardinality(p_days), 0);
		sa_today date := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
		lo date;
		hi date;
		newest timestamptz;
	BEGIN
		IF p_origin IS NULL OR p_origin NOT IN ('dws', 'fixtures') OR p_source IS NULL OR p_source NOT IN ('dws-web', 'dws-request', 'upload') THEN
			RAISE EXCEPTION 'not a gauge record origin and source' USING ERRCODE = 'check_violation';
		END IF;
		IF p_station IS NULL OR p_station !~ '^[A-Z][0-9]H[0-9]{3}$' THEN
			RAISE EXCEPTION 'not a DWS river gauge code (e.g. A2H012)' USING ERRCODE = 'check_violation';
		END IF;
		IF p_from IS NULL OR p_to IS NULL OR p_from > p_to OR p_from < date '1900-01-01' OR p_to > sa_today OR p_to - p_from >= 7330 THEN
			RAISE EXCEPTION 'the span is not 1 to 7330 days ending by today' USING ERRCODE = 'check_violation';
		END IF;
		IF n > 7330 OR coalesce(cardinality(p_values), 0) <> n OR coalesce(cardinality(p_quality), 0) <> n
			OR (n > 0 AND (array_ndims(p_days) <> 1 OR array_ndims(p_values) <> 1 OR array_ndims(p_quality) <> 1)) THEN
			RAISE EXCEPTION 'the rows are not one day, value and quality each (at most 7330)' USING ERRCODE = 'check_violation';
		END IF;
		IF p_fetched_at IS NULL OR p_fetched_at > now() + interval '5 minutes' THEN
			RAISE EXCEPTION 'the fetch time is missing or in the future' USING ERRCODE = 'check_violation';
		END IF;
		IF p_reference IS NOT NULL AND (btrim(p_reference) = '' OR char_length(p_reference) > 200) THEN
			RAISE EXCEPTION 'the reference is 1 to 200 characters' USING ERRCODE = 'check_violation';
		END IF;
		IF p_source = 'dws-request' AND p_reference IS NULL THEN
			RAISE EXCEPTION 'a DWS reply is loaded with its reference (1 to 200 characters)' USING ERRCODE = 'check_violation';
		END IF;
		IF EXISTS (SELECT 1 FROM unnest(p_days) d WHERE d IS NULL OR d < p_from OR d > p_to) THEN
			RAISE EXCEPTION 'a day is outside the span' USING ERRCODE = 'check_violation';
		END IF;
		IF (SELECT count(DISTINCT d) FROM unnest(p_days) d) <> n THEN
			RAISE EXCEPTION 'a day is listed twice' USING ERRCODE = 'check_violation';
		END IF;
		IF EXISTS (SELECT 1 FROM unnest(p_values) v WHERE v IS NOT NULL AND NOT (v >= 0 AND v <= 100000)) THEN
			RAISE EXCEPTION 'a value is not a flow from 0 to 100000 m³/s' USING ERRCODE = 'check_violation';
		END IF;
		IF EXISTS (SELECT 1 FROM unnest(p_quality) q WHERE q IS NOT NULL AND q !~ '^[A-Za-z0-9]{1,8}$') THEN
			RAISE EXCEPTION 'a quality code is not 1 to 8 letters or digits' USING ERRCODE = 'check_violation';
		END IF;

		-- One writer per station at a time: the replace and the span merge read what they change.
		PERFORM pg_advisory_xact_lock(hashtextextended('gauge_record:' || p_origin || ':' || p_station, 247));

		SELECT max(s.fetched_at) INTO newest FROM gauge_record_span s
			WHERE s.origin = p_origin AND s.station = p_station AND s.source = p_source;
		IF newest IS NOT NULL AND newest >= p_fetched_at AND EXISTS (
			SELECT 1 FROM gauge_record_span s
			WHERE s.origin = p_origin AND s.station = p_station AND s.source = p_source AND s.day_from <= p_from AND s.day_to >= p_to
		) THEN
			written := 0;
			applied := false;
			RETURN;
		END IF;

		DELETE FROM gauge_record r
			WHERE r.origin = p_origin AND r.station = p_station AND r.source = p_source AND r.day BETWEEN p_from AND p_to;
		INSERT INTO gauge_record (origin, station, day, source, value, quality, fetched_at, reference)
			SELECT p_origin, p_station, t.d, p_source, t.v, t.q, p_fetched_at, p_reference
			FROM unnest(p_days, p_values, p_quality) AS t(d, v, q);
		GET DIAGNOSTICS written = ROW_COUNT;

		-- The span, merged with the spans of this source it overlaps or touches.
		SELECT least(p_from, min(s.day_from)), greatest(p_to, max(s.day_to)), greatest(p_fetched_at, max(s.fetched_at))
			INTO lo, hi, newest
			FROM gauge_record_span s
			WHERE s.origin = p_origin AND s.station = p_station AND s.source = p_source
			  AND s.day_from <= p_to + 1 AND s.day_to >= p_from - 1;
		DELETE FROM gauge_record_span s
			WHERE s.origin = p_origin AND s.station = p_station AND s.source = p_source
			  AND s.day_from <= p_to + 1 AND s.day_to >= p_from - 1;
		INSERT INTO gauge_record_span (origin, station, source, day_from, day_to, fetched_at, reference)
			VALUES (p_origin, p_station, p_source, coalesce(lo, p_from), coalesce(hi, p_to), coalesce(newest, p_fetched_at), p_reference);
		applied := true;
	END
	$$;
COMMENT ON FUNCTION gauge_record_write(text, text, text, date, date, date[], double precision[], text[], timestamptz, text) IS
	'Replace one source''s gauge_record rows for a station over a span and record the span (247): the operator''s import (`pnpm import:dws`), as the schema owner. Closed to water_app.';
REVOKE ALL ON FUNCTION gauge_record_write(text, text, text, date, date, date[], double precision[], text[], timestamptz, text) FROM PUBLIC, water_app;

-- The worker's load of one station's weekly web pass (the file the fetcher
-- wrote, backend/src/feeds/gaugeRecordLoad.ts): gauge_record_write with
-- source dws-web, and the span at most 731 days (the pass reads two years,
-- DWS_WINDOW_DAYS = 730, ending on today in UTC or South Africa). Worker
-- only: no user, no API key (245 mirror_worker_context).
CREATE FUNCTION app_gauge_record_load_web(
	p_origin text, p_station text, p_from date, p_to date,
	p_days date[], p_values double precision[], p_quality text[], p_fetched_at timestamptz,
	OUT written integer, OUT applied boolean
)
	LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NOT mirror_worker_context() THEN
			RAISE EXCEPTION 'only the worker loads the weekly DWS pass' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF p_from IS NULL OR p_to IS NULL OR p_to - p_from >= 731 THEN
			RAISE EXCEPTION 'a web pass covers at most 731 days' USING ERRCODE = 'check_violation';
		END IF;
		SELECT w.written, w.applied INTO written, applied
			FROM gauge_record_write(p_origin, p_station, 'dws-web', p_from, p_to, p_days, p_values, p_quality, p_fetched_at, NULL) w;
	END
	$$;
COMMENT ON FUNCTION app_gauge_record_load_web(text, text, date, date, date[], double precision[], text[], timestamptz) IS
	'Load one station''s weekly DWS web pass into gauge_record (247), for the worker (no user) only.';
REVOKE ALL ON FUNCTION app_gauge_record_load_web(text, text, date, date, date[], double precision[], text[], timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_gauge_record_load_web(text, text, date, date, date[], double precision[], text[], timestamptz) TO water_app;

-- The stations the weekly pass reads: every river gauge an enabled DWS feed
-- names, in any project (at most 500). Worker only: it hands the list to the
-- fetcher through the mirror bucket, and no project's data leaves with it
-- beyond a public station code.
CREATE FUNCTION app_dws_feed_stations() RETURNS SETOF text
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NOT mirror_worker_context() THEN
			RAISE EXCEPTION 'only the worker lists the DWS feeds'' stations' USING ERRCODE = 'insufficient_privilege';
		END IF;
		RETURN QUERY
			SELECT DISTINCT f.config ->> 'station'
			FROM data_feed f
			WHERE f.source = 'dws' AND f.enabled AND (f.config ->> 'station') ~ '^[A-Z][0-9]H[0-9]{3}$'
			ORDER BY 1
			LIMIT 500;
	END
	$$;
COMMENT ON FUNCTION app_dws_feed_stations() IS
	'The river gauges enabled DWS feeds read, for the worker (no user) only (247): the weekly DWS pass''s station list.';
REVOKE ALL ON FUNCTION app_dws_feed_stations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_dws_feed_stations() TO water_app;
