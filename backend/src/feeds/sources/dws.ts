// DWS (South Africa's Department of Water and Sanitation) verified daily
// gauge flow, from the Hydrological Services site's HyData.aspx page.
//
// There is no documented API. The request is the one two independent
// open-source clients make (RivRetrieve-Python, rivretrieve/southafrica.py;
// aquascope, collectors/south_africa_dws.py, checked 2026-09); the page layout
// is from an archived daily page (web.archive.org, HyData.aspx DataType=Daily,
// captured 2024-05), since the site answers our network with HTTP 403.
// Only river gauges (H codes) are read, with SiteType=RIV (dwsSiteType): an
// archived reservoir page (SiteType=RES, captured 2024-05) has the same
// layout, but its daily "flow" is the spillway discharge, not the river's.
//
//   GET https://www.dws.gov.za/Hydrology/Verified/HyData.aspx
//         ?Station=<code>100.00&DataType=Daily&StartDT=YYYY-MM-DD&EndDT=YYYY-MM-DD&SiteType=RIV
//   → <p><pre> first (the ASP.NET document follows the </pre>), holding a
//     format block and a fixed-width table:
//       POS.  1-8   = Date of daily flow  CCYYMMDD
//       POS. 10-18  = Daily avg flow rate in cubic metres/sec 99999.999
//       POS. 20-24  = Quality code
//       …
//       DATE     D AVG F/R  QUAL
//       20230101     1.234     1
//       20230102             170        ← a gap: flow blank, code only
//       ZZZZZZZZZZZZ
//     one row per day, the daily mean flow in m³/s and a DWS quality code
//     (legend: Verified/HyCodes.aspx); "No data for this period" when there
//     is none. The clients call the column D_AVG_FR, which is accepted too.
//     At most 20 years per request, the site's limit, which both clients ask
//     for (daily data in 20-year chunks; point data, many readings a day, in
//     1-year ones). The feed asks for far less (DWS_WINDOW_DAYS). The site can
//     answer HTTP 200 with a Kisters "ScriptServer" error page instead of data
//     (aquascope reads it as the downstream ScriptServer being unavailable).
//
// Parsed defensively: no <pre>, a different header, or a format block giving
// the flow in another unit fails the fetch (FeedFormatError) and writes
// nothing; each failure's message starts with one of DWS_FORMAT_FAILURES, so
// the fetcher can log which check failed (dwsFailureLabel). The ScriptServer
// error page is the site's backend failing, not a changed layout: it fails
// the fetch as a FeedServerError (unavailable), which the scheduler retries. A row whose value
// isn't a non-negative number is a gap (null), counted in the result. A gap
// row can leave the flow column blank and still carry a quality code
// ("20210102             170"): the code is read by its column, never as a flow.
import { toEpochDay } from '@water-management/engine/calendar';
import { DWS_GAP_CODES, DWS_HEADER, DWS_ROW, dwsColumns, dwsTableText, parseDwsRow, stripHtmlComments } from '@water-management/engine/dws';
import { DWS_RIVER_GAUGE, DWS_RIVER_GAUGE_MESSAGE } from '../config.js';
import { FeedFormatError, FeedServerError } from '../errors.js';

export const DWS_BASE = 'https://www.dws.gov.za/Hydrology/Verified/HyData.aspx';

/** The most one DWS request may span (the site's limit for daily data). */
export const DWS_MAX_YEARS = 20;

/**
 * The most days one feed fetch asks DWS for: two years. Production's first
 * fetch asked for ten (2026-10-26, station A2H012) and got the ScriptServer
 * error page twice; from outside South Africa we can't tell whether the site
 * was down or failed on the span, so the feed asks for little at a time, as
 * the CHIRPS backfill does, and walks a longer history window by window
 * across fetches (fetch.ts fetchWindow; the ingest queues the next window a
 * minute later). Two years, not one: a caught-up feed re-reads the year
 * before its newest day (DWS_REVISION_DAYS, fetch.ts), and verified flow lags
 * months behind today, so its daily window is one to two years and still
 * fits one request. It is ~730 rows, a tenth of the 20-year daily chunks the
 * open-source clients ask for and fewer rows than the one-year chunks they
 * ask of point data.
 */
export const DWS_WINDOW_DAYS = 730;

/**
 * The HyData.aspx SiteType for a station, from its code's third letter. Only
 * a river gauge (H → RIV) is fed (DWS_RIVER_GAUGE, config.ts); archived pages
 * ask for a reservoir (R) with RES and a weather station (E) with MET, so
 * sending RIV for those would ask the wrong question. The config schema
 * refuses them first; this refuses them again rather than guess.
 */
export function dwsSiteType(station: string): 'RIV' {
	if (DWS_RIVER_GAUGE.test(station)) return 'RIV';
	throw new RangeError(`${station} is not a DWS river gauge (an H code): ${DWS_RIVER_GAUGE_MESSAGE}`);
}

export function dwsUrl(station: string, start: string, end: string): string {
	const q = new URLSearchParams({ Station: `${station}100.00`, DataType: 'Daily', StartDT: start, EndDT: end, SiteType: dwsSiteType(station) });
	return `${DWS_BASE}?${q}`;
}

export interface DwsDays {
	/** Null when the page has no rows. */
	startDate: string | null;
	values: (number | null)[];
	/** Rows by quality code, as DWS gave them. */
	quality: Record<string, number>;
	/** Rows whose value was missing, not a usable number, or coded as missing (DWS_GAP_CODES): kept as gaps. */
	rejected: number;
	/** Rows dated outside the window asked for: dropped, not counted above. */
	outside: number;
}

/** Inclusive ISO dates. */
export interface DwsWindow {
	start: string;
	end: string;
}

/** Re-exported for the feed's callers; defined once in the engine's DWS module. */
export { DWS_GAP_CODES };

const SERVER_ERROR = /scriptserver|can't connect to|unable to establish connection/i;

/** What the feed says of the ScriptServer error page (errors.ts FeedServerError), and the fetcher's log label for it. */
export const DWS_SERVER_ERROR = 'the DWS site answered with its ScriptServer error page instead of data';
export const DWS_SERVER_ERROR_LABEL = 'ScriptServer error page';

/**
 * How each DWS format failure's message starts, with the fixed label the
 * fetcher logs for it (lambda-fetcher.ts failureDetail): the message itself
 * can quote the page (its header, a date), so it never goes to a log.
 */
export const DWS_FORMAT_FAILURES = {
	notFound: ['the DWS page was not found', 'page not found'],
	noTable: ['the DWS page has no data table', 'no data table'],
	noHeader: ['the DWS table has no DATE header', 'no DATE header'],
	columns: ['the DWS table’s columns changed', 'columns changed'],
	unit: ['the DWS table’s values are not a daily mean flow in m³/s', 'not a flow in m3/s'],
	badDate: ['the DWS table has an impossible date', 'impossible date'],
	twice: ['the DWS table lists a day twice', 'a day listed twice'],
	tooManyRows: ['the DWS table has more rows than one request can hold', 'too many rows'],
	tooLong: ['the DWS table spans more days than one request can hold', 'too many days']
} as const satisfies Record<string, readonly [string, string]>;

/** The log label of a DWS failure's message (a format failure's, after its stored prefix), or null for any other message. */
export function dwsFailureLabel(message: string): string | null {
	for (const [start, label] of Object.values(DWS_FORMAT_FAILURES)) if (message === start || message.startsWith(`${start} `) || message.startsWith(`${start}:`)) return label;
	return null;
}
const F = DWS_FORMAT_FAILURES;
const MAX_ROWS = 20 * 366 + 10;
/**
 * The daily table's header, spaces collapsed. The site prints "D AVG F/R"
 * (an archived page, 2024); the open-source clients call the column D_AVG_FR,
 * so that spelling is accepted too.
 */
const M3S = /cubic met(re|er)s?\s*(\/|per)\s*s(ec(ond)?)?\b|\bm(3|³)\s*\/\s*s\b|\bcumecs\b/i;
const DAILY_HEADER = /^DATE (D AVG F\/R|D_AVG_FR) QUAL( |$)/;

/** One listed day of a DWS daily table: its flow (null for a gap) and its quality code as listed (null when none). */
export interface DwsRowDay {
	day: string;
	value: number | null;
	quality: string | null;
}

/** A DWS daily table's rows, oldest first, with the counts DwsDays carries. */
export interface DwsRows {
	rows: DwsRowDay[];
	quality: Record<string, number>;
	rejected: number;
	outside: number;
}

/**
 * Parse a HyData.aspx daily page into its listed rows, each with its own
 * quality code: what the gauge record store keeps (247_gauge_record,
 * ingest/dws.ts). The checks are parseDwsDaily's (below), which is built on
 * it. With a window, rows dated outside it are dropped (and counted).
 */
export function parseDwsRows(raw: string, window?: DwsWindow): DwsRows {
	// A comment is not content: one that mentions <pre> must not be taken for the table.
	const page = stripHtmlComments(raw);
	if (SERVER_ERROR.test(page)) throw new FeedServerError(DWS_SERVER_ERROR, DWS_SERVER_ERROR_LABEL);
	const body = dwsTableText(page);
	if (body === null) {
		if (/no data for this period/i.test(page)) return { rows: [], quality: {}, rejected: 0, outside: 0 };
		throw new FeedFormatError(F.noTable[0]);
	}
	if (/no data for this period/i.test(body)) return { rows: [], quality: {}, rejected: 0, outside: 0 };
	// Lines keep their leading spaces: a row's columns are read against the header's.
	const lines = body.split(/\r?\n/).map((l) => l.trimEnd());
	const h = lines.findIndex((l) => DWS_HEADER.test(l));
	if (h === -1) throw new FeedFormatError(F.noHeader[0]);
	const headerLine = lines[h]!.toUpperCase();
	const header = headerLine.trim().split(/\s+/).join(' ');
	if (!DAILY_HEADER.test(header)) {
		throw new FeedFormatError(`${F.columns[0]} (expected DATE D AVG F/R QUAL, got ${header.slice(0, 60)})`);
	}
	const cols = dwsColumns(headerLine);
	// The page states the flow column's unit in its format block ("POS. 10-18 =
	// Daily avg flow rate in cubic metres/sec"). The feed writes m³/s series, so
	// a page that says otherwise is refused rather than merged in the wrong unit.
	const valueSpec = lines.slice(0, h).find((l) => /^\s*POS\.\s*10\s*-\s*18\s*=/i.test(l));
	if (valueSpec !== undefined && !(/flow rate/i.test(valueSpec) && M3S.test(valueSpec))) {
		throw new FeedFormatError(`${F.unit[0]} (${valueSpec.replace(/^\s*POS\.\s*10\s*-\s*18\s*=\s*/i, '').slice(0, 60)})`);
	}
	const from = window ? toEpochDay(window.start) : -Infinity;
	const to = window ? toEpochDay(window.end) : Infinity;

	const byDay = new Map<number, DwsRowDay>();
	const quality: Record<string, number> = {};
	let rejected = 0;
	let outside = 0;
	for (const text of lines.slice(h + 1)) {
		if (!DWS_ROW.test(text.trim())) continue;
		const row = parseDwsRow(text, cols);
		if (row.iso === null) throw new FeedFormatError(`${F.badDate[0]} ${row.date}`);
		const iso = row.iso;
		const day = toEpochDay(iso);
		if (day < from || day > to) {
			outside++;
			continue;
		}
		if (byDay.has(day)) throw new FeedFormatError(`${F.twice[0]}: ${iso}`);
		if (byDay.size >= MAX_ROWS) throw new FeedFormatError(F.tooManyRows[0]);
		// A missing-data code, a blank, text or a negative (-999) value is a gap (parseDwsRow).
		byDay.set(day, { day: iso, value: row.value, quality: row.quality ?? null });
		if (row.gap !== null) rejected++;
		if (row.quality) quality[row.quality] = (quality[row.quality] ?? 0) + 1;
	}
	if (byDay.size === 0) return { rows: [], quality, rejected, outside };
	const days = [...byDay.keys()];
	const first = Math.min(...days);
	const last = Math.max(...days);
	// Rows are few, but their dates come from the page: bound the span before allocating it.
	if (last - first + 1 > MAX_ROWS) throw new FeedFormatError(F.tooLong[0]);
	return { rows: days.sort((a, b) => a - b).map((d) => byDay.get(d)!), quality, rejected, outside };
}

/** Rows (oldest first) laid out by date from the first: a day not listed is a gap. */
export function dwsRowValues(rows: readonly DwsRowDay[]): { startDate: string | null; values: (number | null)[] } {
	if (!rows.length) return { startDate: null, values: [] };
	const first = toEpochDay(rows[0]!.day);
	const values = new Array<number | null>(toEpochDay(rows.at(-1)!.day) - first + 1).fill(null);
	for (const r of rows) values[toEpochDay(r.day) - first] = r.value;
	return { startDate: rows[0]!.day, values };
}

/**
 * Parse a HyData.aspx daily page. Rows are placed by date; a missing date is a
 * gap. With a window, rows dated outside it are dropped (and counted): a page
 * that ignores the dates asked for, or carries a mistyped future date, must
 * not write days nobody asked for or move the feed's newest day past today.
 */
export function parseDwsDaily(raw: string, window?: DwsWindow): DwsDays {
	const r = parseDwsRows(raw, window);
	return { ...dwsRowValues(r.rows), quality: r.quality, rejected: r.rejected, outside: r.outside };
}
