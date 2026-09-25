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
// isn't a non-negative number is a gap (null), counted in the result.
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
	const lines = body.split(/\r?\n/).map((l) => l.trim());
	const h = lines.findIndex((l) => /^DATE(\s|$)/i.test(l));
	if (h === -1) throw new FeedFormatError('the DWS table has no DATE header');
	const header = lines[h]!.toUpperCase().split(/\s+/);
	if (header[0] !== 'DATE' || header[1] !== 'D_AVG_FR') {
		throw new FeedFormatError(`the DWS table’s columns changed (expected DATE D_AVG_FR, got ${header.slice(0, 3).join(' ').slice(0, 60)})`);
	}

	const byDay = new Map<number, number | null>();
	const quality: Record<string, number> = {};
	let rejected = 0;
	for (const line of lines.slice(h + 1)) {
		if (!/^\d{8}(\s|$)/.test(line)) continue;
		const [d, v, q] = line.split(/\s+/);
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
	const values = Array.from({ length: last - first + 1 }, (_, i) => byDay.get(first + i) ?? null);
	return { startDate: fromEpochDay(first), values, quality, rejected };
}
