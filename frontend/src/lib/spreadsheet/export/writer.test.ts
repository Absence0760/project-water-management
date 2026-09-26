import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx/dist/xlsx.mini.min';
import { colName, escapeXml, partOrder, rangeRef, XlsxWorkbook } from './writer';

// The byte-for-byte comparison with SheetJS is in workbook.test.ts; these pin
// the helpers and the writer's refusals.
describe('writer helpers', () => {
	it('escapes XML as SheetJS does: entities, and control characters as _xHHHH_', () => {
		expect(escapeXml(`a&b<c>d'e"f`)).toBe('a&amp;b&lt;c&gt;d&apos;e&quot;f');
		expect(escapeXml('tab\tnew\nline\u0007bell\u001f')).toBe('tab\tnew\nline_x0007_bell_x001f_');
	});

	it('names columns and ranges as SheetJS encodes them', () => {
		for (const c of [0, 1, 25, 26, 27, 51, 52, 701, 702, 16383]) expect(colName(c)).toBe(XLSX.utils.encode_col(c));
		for (const [r, c] of [[0, 0], [0, 3], [5, 0], [99, 30]] as const) expect(rangeRef(r, c)).toBe(XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r, c } }));
	});

	it('orders parts as the zip container listed them', () => {
		const names = ['[Content_Types].xml', 'xl/worksheets/sheet10.xml', 'docProps/core.xml', 'xl/styles.xml', '_rels/.rels', 'xl/worksheets/sheet9.xml', 'xl/_rels/workbook.xml.rels', 'docProps/app.xml'];
		expect([...names].sort(partOrder)).toEqual(['xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet9.xml', 'xl/worksheets/sheet10.xml', '_rels/.rels', 'docProps/app.xml', 'docProps/core.xml', '[Content_Types].xml']);
	});
});

describe('XlsxWorkbook', () => {
	it('refuses a repeated or invalid sheet name and over-long text, as SheetJS did', () => {
		const book = new XlsxWorkbook();
		book.addRows('A', [], 0, []);
		expect(() => book.addRows('A', [], 0, [])).toThrow(/sheet name/);
		expect(() => book.addRows('a/b', [], 0, [])).toThrow(/sheet name/);
		expect(() => book.addRows('x'.repeat(32), [], 0, [])).toThrow(/sheet name/);
		expect(() => book.addRows('B', [[{ t: 's', v: 'x'.repeat(32768) }]], 0, [])).toThrow(/32767/);
	});

	it('writes a workbook SheetJS reads back, formats and all', async () => {
		const book = new XlsxWorkbook();
		book.addRows('Rows', [[{ t: 's', v: 'Flow (m³/day)' }, { t: 'n', v: 1.5, z: '#,##0.00' }], [], [undefined, { t: 'n', v: 2 }]], 1, [44]);
		book.addDaily('Daily', ['date', 'Rain (mm)'], 'yyyy-mm-dd', 25569, [{ format: '#,##0.0', values: [1, null, 3] }], [11, 14]);
		const wb = XLSX.read(await book.bytes(), { type: 'array', cellNF: true });
		expect(wb.SheetNames).toEqual(['Rows', 'Daily']);
		expect(wb.Sheets['Rows']!['B1']).toMatchObject({ v: 1.5, z: '#,##0.00' });
		expect(wb.Sheets['Rows']!['B3']).toMatchObject({ v: 2 });
		expect(wb.Sheets['Daily']!['!ref']).toBe('A1:B4');
		expect(wb.Sheets['Daily']!['A2'].w).toBe('1970-01-01');
		expect(wb.Sheets['Daily']!['B3']).toBeUndefined();
		expect(wb.Sheets['Daily']!['B4']).toMatchObject({ v: 3, z: '#,##0.0' });
	});
});

describe('no app code imports SheetJS (issue #9)', () => {
	const SRC = fileURLToPath(new URL('../../..', import.meta.url));
	const files = (dir: string): string[] =>
		readdirSync(dir).flatMap((name) => {
			const p = join(dir, name);
			return statSync(p).isDirectory() ? files(p) : /\.(ts|svelte|js)$/.test(name) ? [p] : [];
		});

	it('keeps `xlsx` to tests and the test-only SheetJS references', () => {
		// The export writes its own OOXML (./writer.ts) and the import reads with
		// its own streaming reader; SheetJS in app code would put ~85 KB gzip back
		// into a worker (or, worse, a page chunk).
		const offenders = files(SRC)
			.filter((f) => !/\.test\.ts$/.test(f) && !/\/sheetjsReference\.ts$/.test(f) && !/\/import\/testWorkbook\.ts$/.test(f))
			.filter((f) => /from\s+['"]xlsx(\/[^'"]*)?['"]|import\(\s*['"]xlsx/.test(readFileSync(f, 'utf8')))
			.map((f) => relative(SRC, f));
		expect(offenders).toEqual([]);
	});

	it('sees the test-only references (the scan works)', () => {
		expect(files(SRC).some((f) => f.endsWith('export/sheetjsReference.ts'))).toBe(true);
	});
});
