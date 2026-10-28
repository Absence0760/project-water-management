// A DWS evaporation station's daily pan record, as DWS's Hydrological
// Services prints it (issue #646 item 6; docs/data-sources.md §
// dws-evaporation, docs/maps.md § Evaporation stations).
//
// DWS publishes a weather station's verified daily records (its codes carry
// an E where a river gauge has an H: A2E001) on the same HyData.aspx pages as
// river flow, asked for with SiteType=MET (feeds/sources/dws.ts dwsSiteType's
// note; the per-area station lists, Verified/dwafapp2_wma/WMA*_Met.pdf, mark
// each evaporation record [S] Symons pan or [A] Class-A pan, with its span
// and share missing). The site answers our network with HTTP 403, so the
// evaporation page's exact header could not be read: this reader is built on
// the flow page's layout (the engine's DWS module, shared with the flow feed:
// the <pre> table, the header's columns, gap codes and negatives as gaps)
// with the value column named for evaporation, and is tested only against an
// INVENTED reply (backend/fixtures/evaporation-stations/). Nothing here
// fetches: the record reaches the app only through the operator's load
// (`pnpm import:evaporation-stations`), and production refuses that load
// until DWS's permission covers evaporation records (referenceLoad.ts).
//
//   POS.  1-8   = Date of daily reading  CCYYMMDD
//   POS. 10-18  = Daily pan evaporation in millimetres 9999.9
//   POS. 20-24  = Quality code
//   DATE     D EVAP  QUAL
//   20150101      8.4     1
//   20150102             255        ← a gap: value blank, code only
//
// Checked defensively, like the flow page: no table, another header, a
// format block giving another unit, an impossible or repeated date, or a day
// above EVAP_MAX_MM refuses the whole page (one Error, nothing half read).
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { DWS_HEADER, DWS_ROW, dwsColumns, dwsTableText, parseDwsRow, stripHtmlComments } from '@water-management/engine/dws';

/** The most a day's pan evaporation may be, mm: well above any pan's (South Africa's summer days reach about 15 mm). The table's CHECK holds the same bound. */
export const EVAP_MAX_MM = 50;
/** At most 60 years of days in one record. */
export const EVAP_MAX_DAYS = 60 * 366;

/** The value column's label, spaces collapsed: what an evaporation table may call it. */
const EVAP_HEADER = /^DATE (D EVAP|D_EVAP|EVAP|EVAPORATION|PAN EVAP) QUAL( |$)/;
const MM = /\bmillimet(re|er)s?\b|\bmm\b/i;

export interface EvaporationRecord {
	/** The first day with a value (YYYY-MM-DD); the record runs from it. */
	startDate: string;
	/** One value per day from startDate, mm; null for a gap. Trimmed: the first and last are values. */
	values: (number | null)[];
	/** Days with a value. */
	daysWithValue: number;
	/** The station code the page names on a STATION line, if it does. */
	station: string | null;
}

/** Parse one DWS daily evaporation page (or DWS's plain-text reply) into the record it holds. */
export function parseDwsEvaporation(raw: string): EvaporationRecord {
	const page = stripHtmlComments(raw);
	if (/scriptserver/i.test(page)) throw new Error('the DWS page is its ScriptServer error page, not data');
	const body = dwsTableText(page);
	if (body === null) throw new Error('the DWS page has no data table');
	if (/no data for this period/i.test(body)) throw new Error('the DWS page says there is no data for this period');
	const lines = body.split(/\r?\n/).map((l) => l.trimEnd());
	const h = lines.findIndex((l) => DWS_HEADER.test(l));
	if (h === -1) throw new Error('the DWS table has no DATE header');
	const headerLine = lines[h]!.toUpperCase();
	const header = headerLine.trim().split(/\s+/).join(' ');
	if (!EVAP_HEADER.test(header)) throw new Error(`the DWS table is not a daily evaporation table (header ${header.slice(0, 60)})`);
	const valueSpec = lines.slice(0, h).find((l) => /^\s*POS\.\s*10\s*-\s*18\s*=/i.test(l));
	if (valueSpec !== undefined && !(/evap/i.test(valueSpec) && MM.test(valueSpec))) {
		throw new Error(`the DWS table’s values are not a daily evaporation in mm (${valueSpec.replace(/^\s*POS\.\s*10\s*-\s*18\s*=\s*/i, '').slice(0, 60)})`);
	}
	const stationLine = lines.slice(0, h).map((l) => /^\s*STATION\s*:?\s+([A-Z]\d[A-Z]\d{3})\b/i.exec(l)).find((m) => m);
	const cols = dwsColumns(headerLine);
	const byDay = new Map<number, number | null>();
	for (const text of lines.slice(h + 1)) {
		if (!DWS_ROW.test(text.trim())) continue;
		const row = parseDwsRow(text, cols);
		if (row.iso === null) throw new Error(`the DWS table has an impossible date ${row.date}`);
		const day = toEpochDay(row.iso);
		if (byDay.has(day)) throw new Error(`the DWS table lists ${row.iso} twice`);
		if (row.value !== null && row.value > EVAP_MAX_MM) throw new Error(`the DWS table has ${row.value} mm on ${row.iso}, above ${EVAP_MAX_MM} mm a day`);
		byDay.set(day, row.value);
		if (byDay.size > EVAP_MAX_DAYS) throw new Error('the DWS table has more days than one record may hold');
	}
	const valued = [...byDay].filter(([, v]) => v !== null).map(([d]) => d);
	if (!valued.length) throw new Error('the DWS table has no day with a value');
	const first = Math.min(...valued);
	const last = Math.max(...valued);
	if (last - first + 1 > EVAP_MAX_DAYS) throw new Error('the DWS table spans more days than one record may hold');
	const values = Array.from({ length: last - first + 1 }, (_, i) => byDay.get(first + i) ?? null);
	return {
		startDate: fromEpochDay(first),
		values,
		daysWithValue: valued.length,
		station: stationLine ? stationLine[1]!.toUpperCase() : null
	};
}
