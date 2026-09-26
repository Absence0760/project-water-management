// DWS (South Africa's Department of Water and Sanitation) verified daily
// gauge flow, from the Hydrological Services site's HyData.aspx page.
//
// There is no documented API. The request is the one two independent
// open-source clients make (RivRetrieve-Python, rivretrieve/southafrica.py;
// aquascope, collectors/south_africa_dws.py, checked 2026-09); the page layout
// is from an archived daily page (web.archive.org, HyData.aspx DataType=Daily,
// captured 2024-05), since the site answers our network with HTTP 403:
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
//     At most 20 years per request. The site can answer HTTP 200 with a
//     Kisters "ScriptServer" error page instead of data.
//
// Parsed defensively: no <pre>, a different header, a format block giving the
// flow in another unit, or a server error page
// fails the fetch (FeedFormatError) and writes nothing. A row whose value
// isn't a non-negative number is a gap (null), counted in the result. A gap
// row can leave the flow column blank and still carry a quality code
// ("20210102             170"): the code is read by its column, never as a flow.
import { fromEpochDay, toEpochDay } from '@water-management/engine';
import { FeedFormatError } from '../errors.js';

export const DWS_BASE = 'https://www.dws.gov.za/Hydrology/Verified/HyData.aspx';

/** The most one DWS request may span (the site's limit for daily data). */
export const DWS_MAX_YEARS = 20;

export function dwsUrl(station: string, start: string, end: string): string {
	const q = new URLSearchParams({ Station: `${station}100.00`, DataType: 'Daily', StartDT: start, EndDT: end, SiteType: 'RIV' });
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

const decode = (s: string) =>
	s
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<[^>]*>/g, '')
		.replace(/&nbsp;/g, ' ')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');

/**
 * Quality codes that say the day has no flow, whatever number sits in the
 * flow column (DWS's legend, Verified/HyCodes.aspx): print code M (151 and
 * 255 "Data Missing", 170 "Permanent Gap", 172 "Temporary Gap", 246 "No
 * cross-sectional area upstream of notch/structure"), 165 "no flow
 * calculated" and 247 "no calculation performed". Such a row is a gap, so a
 * placeholder 0.000 never lands as a dry day. Other codes (above rating,
 * estimates, unaudited) are real if uncertain flows: kept and counted.
 */
export const DWS_GAP_CODES: ReadonlySet<string> = new Set(['151', '165', '170', '172', '246', '247', '255']);

const SERVER_ERROR = /scriptserver|can't connect to|unable to establish connection/i;
const MAX_ROWS = 20 * 366 + 10;
/**
 * The daily table's header, spaces collapsed. The site prints "D AVG F/R"
 * (an archived page, 2024); the open-source clients call the column D_AVG_FR,
 * so that spelling is accepted too.
 */
const M3S = /cubic met(re|er)s?\s*(\/|per)\s*s(ec(ond)?)?\b|\bm(3|³)\s*\/\s*s\b|\bcumecs\b/i;
const DAILY_HEADER =/^DATE (D AVG F\/R|D_AVG_FR) QUAL( |$)/;

interface Columns {
	/** Where the flow column's label ends and the QUAL label ends (exclusive), in the header line. */
	valueEnd: number;
	qualEnd: number;
}

function headerColumns(headerLine: string): Columns | null {
	const qual = headerLine.search(/\bQUAL\b/);
	if (qual === -1) return null;
	return { valueEnd: headerLine.slice(0, qual).trimEnd().length, qualEnd: qual + 4 };
}

/**
 * A row's date, flow and quality code. The page is fixed-width with numbers
 * right-aligned under their labels, and a gap row leaves the flow blank
 * ("20210102             170"), so a row with one field after the date is
 * placed by where that field ends: a whole number ending under QUAL is the
 * code, anything else is the flow.
 */
function rowFields(raw: string, cols: Columns | null): [string, string | undefined, string | undefined] {
	const fields = [...raw.matchAll(/\S+/g)].map((m) => ({ text: m[0], end: m.index + m[0].length }));
	const [d, a, b] = fields;
	if (!a) return [d!.text, undefined, undefined];
	if (b) return [d!.text, a.text, b.text];
	const underQual = cols !== null && /^\d+$/.test(a.text) && Math.abs(a.end - cols.qualEnd) < Math.abs(a.end - cols.valueEnd);
	return underQual ? [d!.text, undefined, a.text] : [d!.text, a.text, undefined];
}

/**
 * Parse a HyData.aspx daily page. Rows are placed by date; a missing date is a
 * gap. With a window, rows dated outside it are dropped (and counted): a page
 * that ignores the dates asked for, or carries a mistyped future date, must
 * not write days nobody asked for or move the feed's newest day past today.
 */
export function parseDwsDaily(raw: string, window?: DwsWindow): DwsDays {
	// A comment is not content: one that mentions <pre> must not be taken for the table.
	const page = raw.replace(/<!--[\s\S]*?-->/g, '');
	if (SERVER_ERROR.test(page)) throw new FeedFormatError('the DWS site answered with a server error page');
	const pre = page.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
	const body = pre ? decode(pre[1]!) : /^\s*DATE\s/m.test(page) && !/<html/i.test(page) ? page : null;
	if (body === null) {
		if (/no data for this period/i.test(page)) return { startDate: null, values: [], quality: {}, rejected: 0, outside: 0 };
		throw new FeedFormatError('the DWS page has no data table');
	}
	if (/no data for this period/i.test(body)) return { startDate: null, values: [], quality: {}, rejected: 0, outside: 0 };
	// Lines keep their leading spaces: a row's columns are read against the header's.
	const lines = body.split(/\r?\n/).map((l) => l.trimEnd());
	const h = lines.findIndex((l) => /^\s*DATE(\s|$)/i.test(l));
	if (h === -1) throw new FeedFormatError('the DWS table has no DATE header');
	const headerLine = lines[h]!.toUpperCase();
	const header = headerLine.trim().split(/\s+/).join(' ');
	if (!DAILY_HEADER.test(header)) {
		throw new FeedFormatError(`the DWS table’s columns changed (expected DATE D AVG F/R QUAL, got ${header.slice(0, 60)})`);
	}
	const cols = headerColumns(headerLine);
	// The page states the flow column's unit in its format block ("POS. 10-18 =
	// Daily avg flow rate in cubic metres/sec"). The feed writes m³/s series, so
	// a page that says otherwise is refused rather than merged in the wrong unit.
	const valueSpec = lines.slice(0, h).find((l) => /^\s*POS\.\s*10\s*-\s*18\s*=/i.test(l));
	if (valueSpec !== undefined && !(/flow rate/i.test(valueSpec) && M3S.test(valueSpec))) {
		throw new FeedFormatError(`the DWS table’s values are not a daily mean flow in m³/s (${valueSpec.replace(/^\s*POS\.\s*10\s*-\s*18\s*=\s*/i, '').slice(0, 60)})`);
	}
	const from = window ? toEpochDay(window.start) : -Infinity;
	const to = window ? toEpochDay(window.end) : Infinity;

	const byDay = new Map<number, number | null>();
	const quality: Record<string, number> = {};
	let rejected = 0;
	let outside = 0;
	for (const text of lines.slice(h + 1)) {
		if (!/^\d{8}(\s|$)/.test(text.trim())) continue;
		const [d, v, q] = rowFields(text, cols);
		const iso = `${d!.slice(0, 4)}-${d!.slice(4, 6)}-${d!.slice(6, 8)}`;
		let day = NaN;
		try {
			day = toEpochDay(iso);
		} catch {
			// Not a date: refused below.
		}
		if (!Number.isFinite(day) || fromEpochDay(day) !== iso) throw new FeedFormatError(`the DWS table has an impossible date ${d}`);
		if (day < from || day > to) {
			outside++;
			continue;
		}
		if (byDay.has(day)) throw new FeedFormatError(`the DWS table lists ${iso} twice`);
		if (byDay.size >= MAX_ROWS) throw new FeedFormatError('the DWS table has more rows than one request can hold');
		const n = v !== undefined && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v) ? Number(v) : NaN;
		if (Number.isFinite(n) && n >= 0 && !DWS_GAP_CODES.has(q ?? '')) {
			byDay.set(day, n);
		} else {
			byDay.set(day, null);
			rejected++;
		}
		if (q) quality[q] = (quality[q] ?? 0) + 1;
	}
	if (byDay.size === 0) return { startDate: null, values: [], quality, rejected, outside };
	const days = [...byDay.keys()];
	const first = Math.min(...days);
	const last = Math.max(...days);
	// Rows are few, but their dates come from the page: bound the span before allocating it.
	if (last - first + 1 > MAX_ROWS) throw new FeedFormatError('the DWS table spans more days than one request can hold');
	const values = Array.from({ length: last - first + 1 }, (_, i) => byDay.get(first + i) ?? null);
	return { startDate: fromEpochDay(first), values, quality, rejected, outside };
}
