// The node-based workbook's crop sheets, [Crop_Factors] and [Crop_Areas]
// (issue #289; docs/model.md §4, §2.3): a third source for the Load crop
// factors dialog beside the reference library and a b023 workbook's
// [Crop demand]. The b023 importer finds its tables through named ranges;
// the node-based workbook has none, so this finds the sheets by name and the
// tables by their header rows.
//
// Layout it reads (as the node-based design lays them out; the reader only
// relies on the header text, not on the cells):
//
//   [Crop_Factors]  … a month header row, then labelled monthly rows above the
//                   crop table: "A-pan evaporation" (mm/month) and "Effective
//                   rainfall fraction" (both optional);
//                   the crop table: a header row whose label is "Crop(s)"
//                   (else the last month header row), twelve month names in
//                   any order (Oct..Sep, Jan..Dec, "October", …), then one row
//                   per crop: its name (in the column headed "Crop(s)", else
//                   the one just left of the months), twelve factors and, when a column just
//                   after the months is headed "… efficiency" (in the header
//                   row or the row above), the crop's irrigation efficiency.
//                   The table ends at the first row without a name or at a
//                   "Total" row.
//   [Crop_Areas]    a header row "Farm …" followed by one column per crop (up
//                   to a blank or a "Total …" column), then one row per farm:
//                   its name and its area of each crop in m² (hectares when
//                   the crop columns' headers say so and none says m²; a
//                   bracketed unit after a crop's name is dropped). Ends like the crop
//                   table.
//
// Sheet names match ignoring case, spaces and underscores ("Crop Factors"
// finds [Crop_Factors]).
//
// The factors are FAO-56 crop coefficients (Kc, against reference ET₀) that
// the node-based workbook applies to A-pan evaporation with no pan
// coefficient (docs/model.md §2.3), so the set is marked `shape: 'fao-et0'`:
// the dialog should multiply them by a pan coefficient Kp of about 0.75
// before they stand as A-pan factors. b023's and the library's factors are
// already A-pan factors (Kp 1).
//
// Nothing here throws on the content: a missing sheet, a header it can't
// find, a cell that isn't a number or is out of range, a crop in one sheet
// but not the other all come back as `warnings`, and a cell it couldn't read
// counts as 0. Only a file that can't be opened at all fails (readWorkbook's
// WorkbookImportError).
//
// API (the dialog uses the worker; the functions are for tests and tools):
//
//   // In the page, through the import worker (./runner.ts):
//   const session = createWorkbookImport();
//   const set: NodeCropSet = await session.readNodeCrops(file, onProgress?);
//   session.close();
//
//   // Directly, off the main thread or in tests:
//   readNodeCropWorkbook(data, fileName, opts?) → Promise<NodeCropSet>
//   readNodeCrops(source: WorkbookSource, fileName) → NodeCropSet
import { type Cell, cellAddress, clean, isName, isNumeric, num, XlDateTime } from './cells';
import type { WorkbookSource } from './source';
import { B023Workbook, type ReadOptions, readWorkbook } from './workbook';

export const CROP_FACTORS_SHEET = 'Crop_Factors';
export const CROP_AREAS_SHEET = 'Crop_Areas';

/** Water-year months, as the engine's `CropDef.cropFactor` orders them (Oct..Sep). */
const WY = ['oct', 'nov', 'dec', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];
const MONTH_RE = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?$/i;

/** A "Total" row or column ends a table (it sums the rows or columns before it). */
const TOTAL_RE = /^totals?\b/i;
/** Area units in a crop column's header. */
const HECTARES = /\b(hectares?|ha)\b/i;
const SQUARE_METRES = /m²|\bm2\b|sq\.?\s*m/i;
/** A unit in brackets after a crop column's name: "Lucerne (ha)", "Olives [m²]". */
const UNIT_SUFFIX = /\s*[([]\s*(hectares?|ha|m²|m2|sq\.?\s*m)\s*[)\]]$/i;
/** Rows searched for a header, columns scanned per row, and rows read per table. */
const HEADER_ROWS = 60;
const MAX_COLS = 80;
const MAX_TABLE_ROWS = 500;
/** Warnings kept; past this, one 'truncated' warning says how many more there were. */
export const MAX_NODE_CROP_WARNINGS = 100;

/**
 * Largest factor read without a warning. FAO-56 Kc peaks at about 1.2 (up to
 * about 1.4 after its climate adjustment) and A-pan design factors stay below
 * about 1.1, so anything above 1.5 is almost certainly a typo or a value in
 * other units (a percentage, mm).
 */
export const MAX_PLAUSIBLE_FACTOR = 1.5;
/** A-pan evaporation above this (mm/month) is flagged. */
const MAX_PLAUSIBLE_APAN_MM = 600;

export type NodeCropWarningCode =
	/** A sheet isn't in the workbook. */
	| 'missing-sheet'
	/** A sheet has no header row the reader recognises. */
	| 'no-header'
	/** A row looks like a month header but doesn't name the twelve months once each. */
	| 'odd-header'
	/** The header was found but no crop (or farm) rows follow it. */
	| 'no-rows'
	/** A cell that should be a number isn't (text, an error, a date); read as 0. */
	| 'not-a-number'
	/** A number outside the plausible range; negatives read as 0, others kept. */
	| 'out-of-range'
	/** A crop or farm named twice in one sheet; the first row is kept. */
	| 'duplicate'
	/** A crop in [Crop_Factors] with no column in [Crop_Areas]. */
	| 'crop-not-in-areas'
	/** A crop column in [Crop_Areas] with no row in [Crop_Factors]. */
	| 'crop-not-in-factors'
	/** [Crop_Areas]' header gives the areas in hectares; they were converted to m². */
	| 'areas-in-hectares'
	/** More warnings than MAX_NODE_CROP_WARNINGS. */
	| 'truncated';

export interface NodeCropWarning {
	code: NodeCropWarningCode;
	/** Plain text for the user; it quotes names from the file, so render it as text. */
	message: string;
	sheet?: string;
	/** A1 address, where one cell is at fault. */
	cell?: string;
}

export interface NodeCrop {
	name: string;
	/** Twelve factors in water-year order (Oct..Sep), as `CropDef.cropFactor`; FAO-shaped (Kc vs ET₀), before any Kp. */
	cropFactor: number[];
	/** The crop's irrigation efficiency (0 < e ≤ 1) when the sheet has that column and the cell is valid, else null. */
	efficiency: number | null;
}

export interface NodeFarmAreas {
	name: string;
	/** m² per crop, in [Crop_Areas]' column order; crops with a blank cell are left out. */
	areas: { crop: string; m2: number }[];
}

export interface NodeCropSet {
	/** Which kind of source this is. */
	source: 'node-based';
	/**
	 * FAO-56 Kc against reference ET₀ that the workbook applies to A-pan with
	 * no pan coefficient (docs/model.md §2.3): scale by Kp ≈ 0.75 before use
	 * as A-pan factors. b023 and the library are 'apan' (Kp 1).
	 */
	shape: 'fao-et0';
	fileName: string;
	/** The sheet names the factors and areas came from (null when absent). */
	sheets: { factors: string | null; areas: string | null };
	crops: NodeCrop[];
	/** [Crop_Areas]' crop columns, in order (names as that sheet spells them). */
	areaCrops: string[];
	farms: NodeFarmAreas[];
	/** The A-pan evaporation row above the crop table, mm per water-year month (Oct..Sep), or null. */
	apanMm: number[] | null;
	/** The effective-rainfall-fraction row, per water-year month, or null. */
	effectiveRainFraction: number[] | null;
	warnings: NodeCropWarning[];
}

/** A sheet name reduced for matching: lower case, no spaces, underscores or hyphens. */
const sheetKey = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');

/** The workbook's sheet that matches `wanted` ignoring case, spaces and underscores, or null. */
export function findSheet(sheetNames: readonly string[], wanted: string): string | null {
	const key = sheetKey(wanted);
	return sheetNames.find((n) => n === wanted) ?? sheetNames.find((n) => sheetKey(n) === key) ?? null;
}

/** The sheets readWorkbook() should parse for readNodeCrops() (ReadOptions.sheets). */
export function nodeCropSheetsToRead(source: WorkbookSource): string[] {
	return [findSheet(source.sheetNames, CROP_FACTORS_SHEET), findSheet(source.sheetNames, CROP_AREAS_SHEET)].filter((s): s is string => s !== null);
}

/** Water-year index (0 = Oct) of a month header cell, or -1. A date-formatted cell counts by its month. */
function monthOf(v: Cell): number {
	if (v instanceof XlDateTime) return (Number(v.iso.slice(5, 7)) + 2) % 12;
	if (typeof v !== 'string') return -1;
	const m = MONTH_RE.exec(clean(v));
	if (!m) return -1;
	const full = clean(v).toLowerCase().replace(/\.$/, '');
	const i = WY.indexOf(m[1]!.toLowerCase());
	// "Mar" and "March" count; "Marsh" doesn't.
	const names = ['october', 'november', 'december', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september'];
	return names[i]!.startsWith(full) ? i : -1;
}

interface MonthHeader {
	row: number;
	/** The column of the first month; the label is the column before it. */
	col: number;
	/** Per water-year month (Oct..Sep), its column. */
	cols: number[];
}

class Collector {
	readonly list: NodeCropWarning[] = [];
	private dropped = 0;
	add(w: NodeCropWarning) {
		if (this.list.length < MAX_NODE_CROP_WARNINGS) this.list.push(w);
		else this.dropped++;
	}
	finish(): NodeCropWarning[] {
		if (this.dropped) this.list.push({ code: 'truncated', message: `${this.dropped} more warning${this.dropped === 1 ? '' : 's'} not shown.` });
		return this.list;
	}
}

/**
 * Read the crop sheets of a workbook already opened with readWorkbook()
 * (parse at least nodeCropSheetsToRead(): pass it as ReadOptions.sheets) or
 * any WorkbookSource.
 */
export function readNodeCrops(source: WorkbookSource, fileName: string): NodeCropSet {
	const wb = new B023Workbook(source); // only its cell decoding: the node-based workbook has no named ranges
	const warn = new Collector();
	const factorsSheet = findSheet(source.sheetNames, CROP_FACTORS_SHEET);
	const areasSheet = findSheet(source.sheetNames, CROP_AREAS_SHEET);
	const out: NodeCropSet = {
		source: 'node-based',
		shape: 'fao-et0',
		fileName,
		sheets: { factors: factorsSheet, areas: areasSheet },
		crops: [],
		areaCrops: [],
		farms: [],
		apanMm: null,
		effectiveRainFraction: null,
		warnings: []
	};
	if (factorsSheet === null) {
		warn.add({
			code: 'missing-sheet',
			sheet: CROP_FACTORS_SHEET,
			message: `The workbook has no [${CROP_FACTORS_SHEET}] sheet, so it has no crop factors to load. Is it a node-based workbook? (A b023 workbook's crops load from its [Crop demand] sheet.)`
		});
	} else readFactors(wb, factorsSheet, out, warn);
	if (areasSheet === null) {
		warn.add({ code: 'missing-sheet', sheet: CROP_AREAS_SHEET, message: `The workbook has no [${CROP_AREAS_SHEET}] sheet, so no crop areas were read.` });
	} else readAreas(wb, areasSheet, out, warn);

	if (factorsSheet !== null && areasSheet !== null && out.crops.length && out.areaCrops.length) {
		const inAreas = new Set(out.areaCrops.map((c) => c.toLowerCase()));
		const inFactors = new Set(out.crops.map((c) => c.name.toLowerCase()));
		for (const c of out.crops) {
			if (!inAreas.has(c.name.toLowerCase())) {
				warn.add({ code: 'crop-not-in-areas', sheet: areasSheet, message: `${c.name} has crop factors in [${factorsSheet}] but no column in [${areasSheet}], so no farm grows it.` });
			}
		}
		for (const c of out.areaCrops) {
			if (!inFactors.has(c.toLowerCase())) {
				warn.add({ code: 'crop-not-in-factors', sheet: factorsSheet, message: `${c} has areas in [${areasSheet}] but no crop factors in [${factorsSheet}].` });
			}
		}
	}
	out.warnings = warn.finish();
	return out;
}

/** Open a workbook file and read its crop sheets (only those two sheets are parsed). */
export async function readNodeCropWorkbook(
	data: Blob | ArrayBuffer | Uint8Array<ArrayBuffer>,
	fileName: string,
	opts: Omit<ReadOptions, 'sheets'> = {}
): Promise<NodeCropSet> {
	const source = await readWorkbook(data, { ...opts, sheets: nodeCropSheetsToRead });
	return readNodeCrops(source, fileName);
}

/** Every month-header row in the sheet's first HEADER_ROWS rows, and the rows that look like one but aren't. */
function monthHeaders(wb: B023Workbook, sheet: string): { valid: MonthHeader[]; odd: { row: number; col: number }[] } {
	const valid: MonthHeader[] = [];
	const odd: { row: number; col: number }[] = [];
	const last = Math.min(wb.lastRow(sheet), HEADER_ROWS);
	for (let r = 1; r <= last; r++) {
		const months = Array.from({ length: MAX_COLS }, (_, i) => monthOf(wb.cell(sheet, i + 1, r)));
		let found: MonthHeader | null = null;
		let firstMonth = -1;
		let count = 0;
		for (let c = 0; c < MAX_COLS; c++) {
			if (months[c]! < 0) continue;
			count++;
			if (firstMonth < 0) firstMonth = c;
			if (found || c + 12 > MAX_COLS) continue;
			const run = months.slice(c, c + 12);
			if (run.every((m) => m >= 0) && new Set(run).size === 12) {
				const cols: number[] = [];
				run.forEach((m, i) => (cols[m] = c + 1 + i));
				found = { row: r, col: c + 1, cols };
			}
		}
		if (found) valid.push(found);
		else if (count >= 6) odd.push({ row: r, col: firstMonth + 1 });
	}
	return { valid, odd };
}

/** A numeric cell, with a warning (and 0) for one that isn't a number; null when the cell is blank. */
function numberAt(wb: B023Workbook, sheet: string, col: number, row: number, what: string, warn: Collector): number | null {
	const v = wb.cell(sheet, col, row);
	if (v === null || v === '') return null;
	if (isNumeric(v) && !(v instanceof XlDateTime)) return num(v);
	warn.add({ code: 'not-a-number', sheet, cell: cellAddress(col, row), message: `${what} is not a number (${clean(v) || 'a date'}); read as 0.` });
	return 0;
}

function monthlyRow(wb: B023Workbook, sheet: string, row: number, h: MonthHeader, what: string, max: number, warn: Collector): number[] {
	return h.cols.map((c, m) => {
		const label = `${what}, ${WY[m]![0]!.toUpperCase()}${WY[m]!.slice(1)}`;
		const v = numberAt(wb, sheet, c, row, label, warn) ?? 0;
		if (v < 0) {
			warn.add({ code: 'out-of-range', sheet, cell: cellAddress(c, row), message: `${label} is negative (${v}); read as 0.` });
			return 0;
		}
		if (v > max) warn.add({ code: 'out-of-range', sheet, cell: cellAddress(c, row), message: `${label} is ${v}, above ${max}; kept, but check it.` });
		return v;
	});
}

function readFactors(wb: B023Workbook, sheet: string, out: NodeCropSet, warn: Collector) {
	const { valid, odd } = monthHeaders(wb, sheet);
	// The name column: the nearest cell left of the months headed "Crop(s)" (a unit or spacer column may sit between), else the column just left.
	const CROP_LABEL = /^crops?( names?)?$/i;
	const labelColOf = (h: MonthHeader) => {
		for (let c = h.col - 1; c >= 1; c--) if (CROP_LABEL.test(clean(wb.cell(sheet, c, h.row)))) return c;
		return h.col - 1;
	};
	const isCropHeader = (h: MonthHeader) => {
		const c = labelColOf(h);
		return c >= 1 && CROP_LABEL.test(clean(wb.cell(sheet, c, h.row)));
	};
	const header = valid.find(isCropHeader) ?? valid.at(-1);
	if (!header) {
		const o = odd[0];
		warn.add(
			o
				? { code: 'odd-header', sheet, cell: cellAddress(o.col, o.row), message: `[${sheet}] row ${o.row} looks like the month header but doesn't name the twelve months once each, so no crop factors were read.` }
				: { code: 'no-header', sheet, message: `[${sheet}] has no header row of twelve months (Oct … Sep) in its first ${HEADER_ROWS} rows, so no crop factors were read.` }
		);
		return;
	}
	for (const o of odd) {
		if (o.row > header.row) continue;
		warn.add({ code: 'odd-header', sheet, cell: cellAddress(o.col, o.row), message: `[${sheet}] row ${o.row} looks like a month header but doesn't name the twelve months once each; ignored.` });
	}
	const labelCol = labelColOf(header);

	// The labelled monthly rows above the crop table, each read against the nearest month header at or above it.
	if (labelCol >= 1) {
		for (let r = 1; r < header.row; r++) {
			const label = clean(wb.cell(sheet, labelCol, r)).toLowerCase();
			const h = [...valid].reverse().find((x) => x.row < r) ?? header;
			if (/\ba-?\s?pan\b/.test(label) && out.apanMm === null) out.apanMm = monthlyRow(wb, sheet, r, h, 'A-pan evaporation', MAX_PLAUSIBLE_APAN_MM, warn);
			else if (/\beffective\s+rain/.test(label) && out.effectiveRainFraction === null) out.effectiveRainFraction = monthlyRow(wb, sheet, r, h, 'Effective rainfall fraction', 1, warn);
		}
	}

	// The efficiency column: just after the months, headed "… efficiency" in the header row or the row above.
	const after = Math.max(...header.cols);
	let effCol: number | null = null;
	for (let c = after + 1; c <= after + 3 && effCol === null; c++) {
		const text = `${clean(wb.cell(sheet, c, header.row))} ${header.row > 1 ? clean(wb.cell(sheet, c, header.row - 1)) : ''}`;
		if (/efficien/i.test(text)) effCol = c;
	}

	if (labelCol < 1) {
		warn.add({ code: 'no-header', sheet, cell: cellAddress(header.col, header.row), message: `[${sheet}]'s month header starts in column A, leaving no column for the crop names, so no crop factors were read.` });
		return;
	}
	const seen = new Set<string>();
	const last = Math.min(wb.lastRow(sheet), header.row + MAX_TABLE_ROWS);
	for (let r = header.row + 1; r <= last; r++) {
		const v = wb.cell(sheet, labelCol, r);
		if (!isName(v) || TOTAL_RE.test(clean(v))) break;
		const name = clean(v);
		if (seen.has(name.toLowerCase())) {
			warn.add({ code: 'duplicate', sheet, cell: cellAddress(labelCol, r), message: `${name} is named twice in [${sheet}]; the first row is used.` });
			continue;
		}
		seen.add(name.toLowerCase());
		const cropFactor = monthlyRow(wb, sheet, r, header, `${name}'s crop factor`, MAX_PLAUSIBLE_FACTOR, warn);
		let efficiency: number | null = null;
		if (effCol !== null) {
			const e = numberAt(wb, sheet, effCol, r, `${name}'s irrigation efficiency`, warn);
			if (e !== null && e > 0 && e <= 1) efficiency = e;
			else if (e !== null && e !== 0) {
				warn.add({ code: 'out-of-range', sheet, cell: cellAddress(effCol, r), message: `${name}'s irrigation efficiency is ${e}, outside 0–1; not loaded.` });
			}
		}
		out.crops.push({ name, cropFactor, efficiency });
	}
	if (!out.crops.length) warn.add({ code: 'no-rows', sheet, cell: cellAddress(labelCol, header.row + 1), message: `[${sheet}] has a crop header but no crops below it.` });
}

function readAreas(wb: B023Workbook, sheet: string, out: NodeCropSet, warn: Collector) {
	const last = Math.min(wb.lastRow(sheet), HEADER_ROWS);
	let header: { row: number; col: number } | null = null;
	for (let r = 1; r <= last && !header; r++) {
		for (let c = 1; c < MAX_COLS && !header; c++) {
			if (!/^farms?\b/i.test(clean(wb.cell(sheet, c, r)))) continue;
			const next = wb.cell(sheet, c + 1, r);
			if (typeof next === 'string' && isName(next) && monthOf(next) < 0) header = { row: r, col: c };
		}
	}
	if (!header) {
		warn.add({ code: 'no-header', sheet, message: `[${sheet}] has no header row starting "Farm" followed by crop names in its first ${HEADER_ROWS} rows, so no crop areas were read.` });
		return;
	}
	const cols: { col: number; crop: string }[] = [];
	const seenCrop = new Set<string>();
	for (let c = header.col + 1; c <= MAX_COLS; c++) {
		const v = wb.cell(sheet, c, header.row);
		if (!isName(v) || TOTAL_RE.test(clean(v))) break;
		// A unit after the crop's name ("Lucerne (ha)") isn't part of it: the name must match [Crop_Factors]'.
		const crop = clean(v).replace(UNIT_SUFFIX, '') || clean(v);
		if (seenCrop.has(crop.toLowerCase())) {
			warn.add({ code: 'duplicate', sheet, cell: cellAddress(c, header.row), message: `${crop} has two columns in [${sheet}]; the first is used.` });
			continue;
		}
		seenCrop.add(crop.toLowerCase());
		cols.push({ col: c, crop });
	}
	if (!cols.length) {
		warn.add({ code: 'no-header', sheet, cell: cellAddress(header.col, header.row), message: `[${sheet}]'s farm header has no crop columns, so no crop areas were read.` });
		return;
	}
	out.areaCrops = cols.map((c) => c.crop);
	// Areas are m², unless the crop columns' own header cells (or the cells above them) say hectares and none says m².
	// Only those cells: a "Total area m²" column or a title elsewhere says nothing about the crop columns.
	let headerText = '';
	for (const { col } of cols) for (const r of [header.row - 1, header.row]) if (r >= 1) headerText += ` ${clean(wb.cell(sheet, col, r))}`;
	const toM2 = HECTARES.test(headerText) && !SQUARE_METRES.test(headerText) ? 10_000 : 1;
	if (toM2 !== 1) {
		warn.add({ code: 'areas-in-hectares', sheet, cell: cellAddress(header.col, header.row), message: `[${sheet}]'s header gives the areas in hectares, so they were read as hectares (× 10 000 m²).` });
	}
	const seenFarm = new Set<string>();
	const lastRow = Math.min(wb.lastRow(sheet), header.row + MAX_TABLE_ROWS);
	for (let r = header.row + 1; r <= lastRow; r++) {
		const v = wb.cell(sheet, header.col, r);
		if (!isName(v) || TOTAL_RE.test(clean(v))) break;
		const name = clean(v);
		if (seenFarm.has(name.toLowerCase())) {
			warn.add({ code: 'duplicate', sheet, cell: cellAddress(header.col, r), message: `${name} is named twice in [${sheet}]; the first row is used.` });
			continue;
		}
		seenFarm.add(name.toLowerCase());
		const areas: { crop: string; m2: number }[] = [];
		for (const { col, crop } of cols) {
			const a = numberAt(wb, sheet, col, r, `${name}'s ${crop} area`, warn);
			if (a === null) continue;
			if (a < 0) {
				warn.add({ code: 'out-of-range', sheet, cell: cellAddress(col, r), message: `${name}'s ${crop} area is negative (${a}); read as 0.` });
				areas.push({ crop, m2: 0 });
			} else areas.push({ crop, m2: a * toM2 });
		}
		out.farms.push({ name, areas });
	}
	if (!out.farms.length) warn.add({ code: 'no-rows', sheet, cell: cellAddress(header.col, header.row + 1), message: `[${sheet}] has a farm header but no farms below it.` });
}
