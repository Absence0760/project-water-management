// DWS (South Africa's Department of Water and Sanitation) verified daily
// gauge flow, from the Hydrological Services site's HyData.aspx page.
//
// There is no documented API. The format below is the one two independent
// open-source clients parse (RivRetrieve-Python, rivretrieve/southafrica.py;
// aquascope, collectors/south_africa_dws.py), checked 2026-09:
//
//   GET https://www.dws.gov.za/Hydrology/Verified/HyData.aspx
//         ?Station=<code>100.00&DataType=Daily&StartDT=YYYY-MM-DD&EndDT=YYYY-MM-DD&SiteType=RIV
//   → an HTML page whose <pre> holds a whitespace table:
//       DATE       D_AVG_FR  QUAL
//       20230101      1.234     1
//     one row per day, the daily mean flow in m³/s and a DWS quality code;
//     "No data for this period" when there is none. At most 20 years per
//     request. The site can answer HTTP 200 with a Kisters "ScriptServer"
//     error page instead of data.
//
// Parsed defensively: no <pre>, a different header, or a server error page
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
	/** Rows by quality code, as DWS gave them (not interpreted). */
	quality: Record<string, number>;
	/** Rows whose value was missing or not a usable number (kept as gaps). */
	rejected: number;
}

const decode = (s: string) =>
	s
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<[^>]*>/g, '')
		.replace(/&nbsp;/g, ' ')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');

const SERVER_ERROR = /scriptserver|can't connect to|unable to establish connection/i;
const MAX_ROWS = 20 * 366 + 10;

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

/** Parse a HyData.aspx daily page. Rows are placed by date; a missing date is a gap. */
export function parseDwsDaily(page: string): DwsDays {
	if (SERVER_ERROR.test(page)) throw new FeedFormatError('the DWS site answered with a server error page');
	const pre = page.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
	const body = pre ? decode(pre[1]!) : /^\s*DATE\s/m.test(page) && !/<html/i.test(page) ? page : null;
	if (body === null) {
		if (/no data for this period/i.test(page)) return { startDate: null, values: [], quality: {}, rejected: 0 };
		throw new FeedFormatError('the DWS page has no data table');
	}
	if (/no data for this period/i.test(body)) return { startDate: null, values: [], quality: {}, rejected: 0 };
	// Lines keep their leading spaces: a row's columns are read against the header's.
	const lines = body.split(/\r?\n/).map((l) => l.trimEnd());
	const h = lines.findIndex((l) => /^\s*DATE(\s|$)/i.test(l));
	if (h === -1) throw new FeedFormatError('the DWS table has no DATE header');
	const headerLine = lines[h]!.toUpperCase();
	const header = headerLine.trim().split(/\s+/);
	if (header[0] !== 'DATE' || header[1] !== 'D_AVG_FR') {
		throw new FeedFormatError(`the DWS table’s columns changed (expected DATE D_AVG_FR, got ${header.slice(0, 3).join(' ').slice(0, 60)})`);
	}
	const cols = headerColumns(headerLine);

	const byDay = new Map<number, number | null>();
	const quality: Record<string, number> = {};
	let rejected = 0;
	for (const raw of lines.slice(h + 1)) {
		const line = raw.trim();
		if (!/^\d{8}(\s|$)/.test(line)) continue;
		const [d, v, q] = rowFields(raw, cols);
		const iso = `${d!.slice(0, 4)}-${d!.slice(4, 6)}-${d!.slice(6, 8)}`;
		let day = NaN;
		try {
			day = toEpochDay(iso);
		} catch {
			// Not a date: refused below.
		}
		if (!Number.isFinite(day) || fromEpochDay(day) !== iso) throw new FeedFormatError(`the DWS table has an impossible date ${d}`);
		if (byDay.has(day)) throw new FeedFormatError(`the DWS table lists ${iso} twice`);
		if (byDay.size >= MAX_ROWS) throw new FeedFormatError('the DWS table has more rows than one request can hold');
		const n = v !== undefined && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v) ? Number(v) : NaN;
		if (Number.isFinite(n) && n >= 0) {
			byDay.set(day, n);
		} else {
			byDay.set(day, null);
			rejected++;
		}
		if (q) quality[q] = (quality[q] ?? 0) + 1;
	}
	if (byDay.size === 0) return { startDate: null, values: [], quality, rejected };
	const days = [...byDay.keys()];
	const first = Math.min(...days);
	const last = Math.max(...days);
	// Rows are few, but their dates come from the page: bound the span before allocating it.
	if (last - first + 1 > MAX_ROWS) throw new FeedFormatError('the DWS table spans more days than one request can hold');
	const values = Array.from({ length: last - first + 1 }, (_, i) => byDay.get(first + i) ?? null);
	return { startDate: fromEpochDay(first), values, quality, rejected };
}
