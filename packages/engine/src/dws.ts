// DWS (South Africa's Department of Water and Sanitation) daily hydrology
// tables, as the Hydrological Services site's HyData.aspx page prints them:
// a fixed-width table of YYYYMMDD date, daily value and quality code.
//
//   DATE     D AVG F/R  QUAL
//   20230101     1.234     1
//   20230102             170        ← a gap: value blank, code only
//
// Pure text parsing, shared by the automatic DWS feed
// (backend/src/feeds/sources/dws.ts, which adds the page checks: server error
// pages, the header and unit it expects, the window asked for) and the manual
// series import (frontend/src/lib/series/dws.ts, a saved export). One reading
// of a row, so a -999 or a "Data Missing" code can never be a gap in one and a
// value in the other. Exposed as `@water-management/engine/dws`, not through
// the barrel: only the feed and the import chunk need it.
import { fromEpochDay, toEpochDay } from './calendar';

/**
 * Quality codes that say the day has no value, whatever number sits in the
 * value column (DWS's legend, Verified/HyCodes.aspx): print code M (151 and
 * 255 "Data Missing", 170 "Permanent Gap", 172 "Temporary Gap", 246 "No
 * cross-sectional area upstream of notch/structure"), 165 "no flow
 * calculated" and 247 "no calculation performed". Such a row is a gap, so a
 * placeholder 0.000 never lands as a dry day. Other codes (above rating,
 * estimates, unaudited) are real if uncertain values: kept and counted.
 */
export const DWS_GAP_CODES: ReadonlySet<string> = new Set(['151', '165', '170', '172', '246', '247', '255']);

/** A dated table row: eight digits, then whitespace or the end of the line (test the trimmed line). */
export const DWS_ROW = /^\d{8}(\s|$)/;

/** A header line: DATE first (indented or not). */
export const DWS_HEADER = /^\s*DATE(\s|$)/i;

const decode = (s: string) =>
	s
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<[^>]*>/g, '')
		.replace(/&nbsp;/g, ' ')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');

/** HTML comments removed: one that mentions <pre> must not be taken for the table. */
export const stripHtmlComments = (raw: string) => raw.replace(/<!--[\s\S]*?-->/g, '');

/**
 * The table text of a page: the decoded <pre> of a saved HyData.aspx page, or
 * the text itself when it is a plain table (a DATE header line and no <html>).
 * Null when it is neither (an HTML page without a table).
 */
export function dwsTableText(raw: string): string | null {
	const page = stripHtmlComments(raw);
	const pre = page.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
	if (pre) return decode(pre[1]!);
	return /^\s*DATE\s/m.test(page) && !/<html/i.test(page) ? page : null;
}

export interface DwsColumns {
	/** Where the value column's label ends and the QUAL label ends (exclusive), in the header line. */
	valueEnd: number;
	qualEnd: number;
}

/** Column ends from a header line, or null when it has no QUAL label. */
export function dwsColumns(headerLine: string): DwsColumns | null {
	const qual = headerLine.toUpperCase().search(/\bQUAL\b/);
	if (qual === -1) return null;
	return { valueEnd: headerLine.slice(0, qual).trimEnd().length, qualEnd: qual + 4 };
}

/**
 * Why a row holds no value: `code` a missing-data quality code (DWS_GAP_CODES),
 * `blank` nothing in the value column, `text` something that isn't a number,
 * `negative` a negative number (the -999 / -1 placeholders: a flow, rainfall
 * or evaporation is never below zero).
 */
export type DwsGap = 'code' | 'blank' | 'text' | 'negative';

export interface DwsRow {
	/** The date as written (YYYYMMDD). */
	date: string;
	/** The date as YYYY-MM-DD; null when it isn't a real day (20210230). */
	iso: string | null;
	/** The value; null for a gap. */
	value: number | null;
	/** The value column as written, if anything was. */
	rawValue?: string;
	/** The quality code as written, if any. */
	quality?: string;
	/** Why the value is null; null when there is a value. */
	gap: DwsGap | null;
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * A row's fields. The table is fixed-width with numbers right-aligned under
 * their labels, and a gap row leaves the value blank ("20210102        170"),
 * so a row with one field after the date is placed by where that field ends:
 * a whole number ending under QUAL is the code, anything else is the value.
 * Without a header (no columns known), a lone field is the value.
 */
function rowFields(raw: string, cols: DwsColumns | null): [string, string | undefined, string | undefined] {
	const fields = [...raw.matchAll(/\S+/g)].map((m) => ({ text: m[0], end: m.index + m[0].length }));
	const [d, a, b] = fields;
	if (!a) return [d!.text, undefined, undefined];
	if (b) return [d!.text, a.text, b.text];
	const underQual = cols !== null && /^\d+$/.test(a.text) && Math.abs(a.end - cols.qualEnd) < Math.abs(a.end - cols.valueEnd);
	return underQual ? [d!.text, undefined, a.text] : [d!.text, a.text, undefined];
}

function isoOf(d: string): string | null {
	const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
	try {
		return fromEpochDay(toEpochDay(iso)) === iso ? iso : null;
	} catch {
		return null;
	}
}

/**
 * One dated row (DWS_ROW), read against the header's columns. A value is kept
 * only when it is a non-negative number and the quality code doesn't say the
 * day is missing; otherwise it is a gap, and `gap` says why.
 */
export function parseDwsRow(line: string, cols: DwsColumns | null): DwsRow {
	const [date, v, q] = rowFields(line, cols);
	const n = v !== undefined && NUMBER.test(v) ? Number(v) : NaN;
	const gap: DwsGap | null = DWS_GAP_CODES.has(q ?? '')
		? 'code'
		: v === undefined
			? 'blank'
			: !Number.isFinite(n)
				? 'text'
				: n < 0
					? 'negative'
					: null;
	const row: DwsRow = { date, iso: isoOf(date), value: gap === null ? n : null, gap };
	if (v !== undefined) row.rawValue = v;
	if (q !== undefined) row.quality = q;
	return row;
}
