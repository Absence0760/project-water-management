// Test support: the workbook export as SheetJS wrote it before ./writer.ts
// (issue #9), kept as the reference the writer must match byte for byte
// (workbook.test.ts). Not imported by app code: the export worker carries no
// SheetJS.
//
// SheetJS wrote every part from a workbook of stub sheets; each daily sheet's
// rows were then streamed into the XML it wrote for a stub (the header and one
// probe row carrying every column's format), in the markup SheetJS writes for
// a numeric cell, and the parts were zipped by ./zip.ts in its container's
// order. SheetJS keeps its number-format table in module state, and the export
// worker is new for every export, so pass a freshly imported module.
import type * as XLSXModule from 'xlsx/dist/xlsx.mini.min';
import { DATE_FORMAT, numberFormat } from './formats';
import { dailyDay0, dailyHeader, dailyWidths, rowCells, workbookPlan, type DailyTable, type WorkbookInput } from './workbook';
import type { XlsxCell } from './writer';
import { zip, type ZipEntry } from './zip';

type XLSX = typeof XLSXModule;

const tableDays = (t: DailyTable) => Math.max(0, ...t.columns.map((c) => c.values.length));
const withFormat = (v: number, z: string | undefined): XLSXModule.CellObject => (z ? { t: 'n', v, z } : { t: 'n', v });
// A formula cell is SheetJS's numeric cell carrying `f` (the run workbook has none; the audit workbook isn't compared).
const cellObject = (c: XlsxCell | undefined): XLSXModule.CellObject | undefined => (!c ? undefined : c.t === 'f' ? { ...c, t: 'n' } : { ...c });

/** The stub SheetJS was given for a daily table: the header row and, with days, a probe row. */
export function dailyStub(X: XLSX, t: DailyTable): XLSXModule.WorkSheet {
	const data: XLSXModule.CellObject[][] = [dailyHeader(t).map((v): XLSXModule.CellObject => ({ t: 's', v }))];
	if (tableDays(t) > 0) data.push([withFormat(0, DATE_FORMAT), ...t.columns.map((c) => withFormat(0, numberFormat(c.unit)))]);
	const ws = { '!data': data } as XLSXModule.DenseWorkSheet;
	ws['!ref'] = X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: data.length - 1, c: t.columns.length } });
	ws['!cols'] = dailyWidths(t).map((wch) => ({ wch }));
	return ws;
}

/** Every cell of a daily table as SheetJS cells (what SheetJS would be given without the stub). */
export function dailyCells(X: XLSX, t: DailyTable): XLSXModule.WorkSheet {
	const ws = dailyStub(X, t) as XLSXModule.DenseWorkSheet;
	const days = tableDays(t);
	const data = ws['!data'].slice(0, 1);
	const formats = t.columns.map((c) => numberFormat(c.unit));
	const day0 = dailyDay0(t);
	for (let r = 0; r < days; r++) {
		const row: XLSXModule.CellObject[] = [withFormat(day0 + r, DATE_FORMAT)];
		t.columns.forEach((c, i) => {
			const v = c.values[r];
			if (typeof v === 'number' && Number.isFinite(v)) row[i + 1] = withFormat(v, formats[i]);
		});
		data.push(row);
	}
	ws['!data'] = data;
	ws['!ref'] = X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: days, c: t.columns.length } });
	return ws;
}

/** A stub's sheet XML with the table's rows streamed in, as the export used to write it. */
export function streamDailySheet(X: XLSX, stubXml: string, t: DailyTable): string {
	const days = tableDays(t);
	const last = X.utils.encode_col(t.columns.length);
	const open = stubXml.indexOf('<sheetData>') + '<sheetData>'.length;
	const close = stubXml.indexOf('</sheetData>');
	const rows = stubXml.slice(open, close);
	const headerEnd = rows.indexOf('</row>') + '</row>'.length;
	const probe = rows.slice(headerEnd);
	if (open < '<sheetData>'.length || close < 0 || !probe.startsWith('<row r="2"')) throw new Error('unexpected sheet XML from the spreadsheet library');
	const style = Array.from({ length: t.columns.length + 1 }, (_, c) => {
		const m = new RegExp(`<c r="${X.utils.encode_col(c)}2"( s="\\d+")?`).exec(probe);
		if (!m) throw new Error('unexpected sheet XML from the spreadsheet library');
		return m[1] ?? '';
	});
	const stubRef = `A1:${last}2`;
	const fullRef = `A1:${last}${days + 1}`;
	const letters = Array.from({ length: t.columns.length }, (_, i) => X.utils.encode_col(i + 1));
	const day0 = dailyDay0(t);
	let out = stubXml.slice(0, open).split(stubRef).join(fullRef) + rows.slice(0, headerEnd);
	for (let r = 0; r < days; r++) {
		const R = r + 2;
		out += `<row r="${R}"><c r="A${R}"${style[0]}><v>${day0 + r}</v></c>`;
		for (let i = 0; i < t.columns.length; i++) {
			const v = t.columns[i]!.values[r];
			if (typeof v === 'number' && Number.isFinite(v)) out += `<c r="${letters[i]}${R}"${style[i + 1]}><v>${v}</v></c>`;
		}
		out += '</row>';
	}
	return out + stubXml.slice(close).split(stubRef).join(fullRef);
}

/** The workbook as the export built it with SheetJS. */
export async function sheetjsWorkbook(X: XLSX, input: WorkbookInput): Promise<Uint8Array<ArrayBuffer>> {
	const wb = X.utils.book_new();
	const daily: { index: number; table: DailyTable }[] = [];
	for (const sheet of workbookPlan(input)) {
		if ('daily' in sheet) {
			daily.push({ index: wb.SheetNames.length, table: sheet.daily });
			X.utils.book_append_sheet(wb, dailyStub(X, sheet.daily), sheet.name);
		} else {
			const { cells, lastCol } = rowCells(sheet.rows);
			const ws = { '!data': cells.map((r) => r.map(cellObject)) } as XLSXModule.DenseWorkSheet;
			ws['!ref'] = X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, sheet.rows.length - 1), c: lastCol } });
			ws['!cols'] = sheet.widths.map((wch) => ({ wch }));
			X.utils.book_append_sheet(wb, ws, sheet.name);
		}
	}
	const cfb = X.CFB.read(new Uint8Array(X.write(wb, { type: 'array', bookType: 'xlsx', compression: false }) as ArrayBuffer), { type: 'array' });
	const dec = new TextDecoder();
	for (const { index, table } of daily) {
		if (tableDays(table) === 0) continue;
		const file = X.CFB.find(cfb, `/xl/worksheets/sheet${index + 1}.xml`) as { content: Uint8Array<ArrayBuffer>; size: number } | null;
		if (!file) throw new Error('unexpected workbook layout from the spreadsheet library');
		file.content = new TextEncoder().encode(streamDailySheet(X, dec.decode(file.content), table));
		file.size = file.content.length;
	}
	const root = cfb.FullPaths[0]!;
	const parts: ZipEntry[] = [];
	for (let i = 1; i < cfb.FullPaths.length; i++) {
		const f = cfb.FileIndex[i] as { type: number; content?: Uint8Array<ArrayBuffer> | number[]; size?: number };
		const name = cfb.FullPaths[i]!.slice(root.length);
		if (f.type !== 2 || !f.size || !f.content || !f.content.length || name === '\u0001Sh33tJ5') continue;
		parts.push({ name, data: f.content instanceof Uint8Array ? f.content : Uint8Array.from(f.content) });
	}
	return zip(parts);
}
