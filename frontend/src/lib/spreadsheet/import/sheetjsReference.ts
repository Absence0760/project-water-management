// Test support: SheetJS behind the WorkbookSource interface. Not imported by
// app code (the import worker carries no SheetJS).
//
// - sheetjsSource() wraps any SheetJS WorkBook: the in-memory test workbooks
//   (./testWorkbook.ts) and files SheetJS read.
// - readWorkbookWithSheetJS() is the reader the import used before the
//   streaming one (./workbook.ts readWorkbook): the same parts, handed to
//   SheetJS's mini build with the options the parser was written against.
//   The parity tests read each workbook both ways and compare every cell the
//   parser could ask for (./readerParity.test.ts, ./sourceWorkbooks.test.ts).
//   Cell text is the one deliberate difference: the streaming reader decodes
//   it as openpyxl does (issue #22, ./stringDecoding.test.ts), so
//   explainedByDecoding() tells those differences from real ones.
import * as XLSX from 'xlsx/dist/xlsx.mini.min';
import { UnreadableWorkbookError } from './errors';
import { packageParts, relTargets, relsPathOf } from './ooxml';
import { type Cell, cellAddress } from './cells';
import type { RawCell, SheetSource, WorkbookSource } from './source';
import { B023Workbook, sheetsToRead } from './workbook';
import { readWorkbookXml } from './workbookParts';
import { unescapeXml } from './xml';
import { type StoredEntry, ZipArchive, storedZip } from './zip';

/** A SheetJS WorkBook (dense or sparse sheets) as a WorkbookSource. */
export function sheetjsSource(wb: XLSX.WorkBook): WorkbookSource {
	return {
		sheetNames: wb.SheetNames,
		names: (wb.Workbook?.Names ?? []).map((n) => ({ name: n.Name, ref: n.Ref, local: n.Sheet !== undefined })),
		date1904: Boolean(wb.Workbook?.WBProps?.date1904),
		sheet(name): SheetSource | undefined {
			const ws = wb.Sheets[name];
			if (!ws) return undefined;
			const ref = ws['!ref'];
			const dense = (ws as { '!data'?: XLSX.CellObject[][] })['!data'];
			return {
				lastRow: ref ? XLSX.utils.decode_range(ref).e.r + 1 : 0,
				cell(col, row) {
					const c = dense ? dense[row - 1]?.[col - 1] : (ws[XLSX.utils.encode_cell({ c: col - 1, r: row - 1 })] as XLSX.CellObject | undefined);
					return c as RawCell | undefined;
				},
				*addresses() {
					if (dense) {
						for (const [r, cells] of dense.entries()) if (cells) for (const [c, cell] of cells.entries()) if (cell) yield [c + 1, r + 1] as [number, number];
					} else {
						for (const k of Object.keys(ws)) {
							if (k.startsWith('!')) continue;
							const { c, r } = XLSX.utils.decode_cell(k);
							yield [c + 1, r + 1] as [number, number];
						}
					}
				}
			};
		}
	};
}

/** The options the parser was written against: cached values and number formats (to spot dates), nothing else. */
export const SHEETJS_READ_OPTIONS: XLSX.ParsingOptions = {
	type: 'array',
	dense: true,
	cellFormula: false,
	cellHTML: false,
	cellText: false,
	cellNF: true,
	cellDates: false,
	cellStyles: false,
	sheetStubs: false,
	bookVBA: false
};

/** The workbook as SheetJS read it for the import before the streaming reader (same parts, same sheets). */
export async function readWorkbookWithSheetJS(data: Uint8Array): Promise<{ source: WorkbookSource; book: XLSX.WorkBook }> {
	const zip = await ZipArchive.open(data);
	const parts = new Map<string, StoredEntry>();
	const load = async (name: string): Promise<boolean> => {
		const exact = zip.find(name);
		if (exact === undefined) return false;
		if (!parts.has(exact)) parts.set(exact, { name: exact, data: await zip.read(exact), crc: zip.info(exact)!.crc });
		return true;
	};
	const text = (name: string) => new TextDecoder().decode(parts.get(zip.find(name)!)!.data);
	await load('[Content_Types].xml');
	const pkg = packageParts(text('[Content_Types].xml'));
	const workbookPart = zip.find(pkg.workbook ?? 'xl/workbook.xml')!;
	await load(workbookPart);
	await load('_rels/.rels');
	const relsPart = zip.find(relsPathOf(workbookPart)) ?? 'xl/_rels/workbook.xml.rels';
	const hasRels = await load(relsPart);
	for (const p of pkg.support) await load(p);
	for (const s of pkg.strings) await load(s);
	const read = (entries: StoredEntry[], sheets: string[]) => {
		try {
			return XLSX.read(storedZip(entries), { ...SHEETJS_READ_OPTIONS, sheets });
		} catch (e) {
			throw new UnreadableWorkbookError(e instanceof Error ? e.message : String(e));
		}
	};
	const book = read([...parts.values()], []);
	const targets = hasRels ? relTargets(workbookPart, text(relsPart)) : new Map<string, string>();
	const layout = readWorkbookXml(parts.get(workbookPart)!.data, workbookPart);
	const partOf = new Map(layout.sheets.flatMap((s) => (s.rid && targets.has(s.rid) && zip.find(targets.get(s.rid)!) ? [[s.name, zip.find(targets.get(s.rid)!)!] as const] : [])));
	for (const s of sheetsToRead(sheetjsSource(book)).filter((n) => partOf.has(n))) {
		const part = partOf.get(s)!;
		const one = read([...parts.values(), { name: part, data: await zip.read(part), crc: zip.info(part)!.crc }], [s]);
		Object.assign(book.Sheets, one.Sheets);
	}
	return { source: sheetjsSource(book), book };
}

/** Whether two cell values, as the parser reads them, are the same (NaN equal to NaN; dates by value). */
function sameCell(a: Cell, b: Cell): boolean {
	if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return Object.is(a, b);
	return a.constructor === b.constructor && JSON.stringify(a) === JSON.stringify(b);
}

/** A string with every way SheetJS's decoding and openpyxl's can differ folded away. */
function foldDecoding(s: string): string {
	return unescapeXml(s)
		.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, (pair) => String.fromCharCode(pair.codePointAt(0)! & 0xffff))
		.replace(/\r\n?/g, '\n')
		.replaceAll('x005F_', '');
}

/**
 * Whether a SheetJS cell and the streaming reader's differ only in how the
 * text was decoded (issue #22): _xHHHH_ escapes, a formula's cached text
 * decoded twice, line breaks, references beyond U+FFFF, openpyxl dropping
 * "x005F_" from shared strings. Both must be strings; anything else (a type,
 * a number, a missing cell) is a real difference.
 */
export function explainedByDecoding(sheetjs: Cell, streamed: Cell): boolean {
	return typeof sheetjs === 'string' && typeof streamed === 'string' && foldDecoding(sheetjs) === foldDecoding(streamed);
}

/**
 * The first way the parser would see two readings of a workbook differently,
 * or null: the sheet list, the defined names, the date system, which sheets
 * were read, each read sheet's used range, and every cell either reader
 * stored, read through B023Workbook as the parser reads it. With
 * `allowDecodingDifferences`, a string cell whose difference
 * explainedByDecoding() accounts for is not one (for real workbooks, where
 * the streaming reader decodes as openpyxl does and SheetJS didn't). The
 * message names a sheet and a cell address, never a value (client workbooks
 * go through this too).
 */
export function readerDifference(expected: WorkbookSource, actual: WorkbookSource, { allowDecodingDifferences = false } = {}): string | null {
	if (JSON.stringify(expected.sheetNames) !== JSON.stringify(actual.sheetNames)) return 'the sheet names differ';
	if (JSON.stringify(expected.names) !== JSON.stringify(actual.names)) return 'the defined names differ';
	if (expected.date1904 !== actual.date1904) return 'the date system differs';
	const e = new B023Workbook(expected);
	const a = new B023Workbook(actual);
	let sheets = 0;
	for (const name of expected.sheetNames) {
		const es = expected.sheet(name);
		const as = actual.sheet(name);
		if (!es !== !as) return `[${name}] was read by only one reader`;
		if (!es || !as) continue;
		sheets++;
		if (es.lastRow !== as.lastRow) return `[${name}] used range differs: last row ${es.lastRow} vs ${as.lastRow}`;
		const seen = new Set<string>();
		for (const [col, row] of [...es.addresses(), ...as.addresses()]) {
			const key = `${col},${row}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const ev = e.cell(name, col, row);
			const av = a.cell(name, col, row);
			if (sameCell(ev, av) || (allowDecodingDifferences && explainedByDecoding(ev, av))) continue;
			return `[${name}] ${cellAddress(col, row)} differs`;
		}
	}
	return sheets ? null : 'no sheet was read';
}
