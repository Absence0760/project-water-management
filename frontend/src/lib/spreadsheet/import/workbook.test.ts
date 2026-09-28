import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { XlDateTime, XlDuration } from './cells';
import { InvalidWorkbookError, NotB023WorkbookError, UnreadableWorkbookError, WorkbookTooLargeError } from './errors';
import { extractProject } from './extract';
import { WorkbookBuilder, serialOf, syntheticB023 } from './testWorkbook';
import { B023Workbook, readWorkbook } from './workbook';
import { sheetjsSource } from './sheetjsReference';
import { workbookPackage, worksheet } from './testPackage';
import { crc32 } from '../export/zip';
import { ZipArchive, storedZip } from './zip';

function small(): WorkbookBuilder {
	return new WorkbookBuilder()
		.col("It's here", 'B2', ['Header', 'One', ' Two  words ', '', '|', 'Three', '-- stop', 'Never'])
		.set("It's here", 'D2', { date: '2010-01-10' })
		.set("It's here", 'D3', { serial: 1.5, fmt: '[h]:mm' })
		.set("It's here", 'D4', { error: 0x2a })
		.set("It's here", 'D5', true)
		.set("It's here", 'D6', 4320)
		.set("It's here", 'D7', { serial: 40188, fmt: '#,##0' })
		.name('zList', "'It''s here'!$B$2:$B$9")
		.name('zCell', "'It''s here'!D2")
		.name('zBad', 'SUM(A1:A2)');
}

describe('B023Workbook', () => {
	it('resolves named ranges, quoted sheet names included', () => {
		const wb = new B023Workbook(small().build());
		expect(wb.ref('zList')).toEqual({ sheet: "It's here", c1: 2, r1: 2, c2: 2, r2: 9 });
		expect(wb.ref('zCell')).toEqual({ sheet: "It's here", c1: 4, r1: 2, c2: 4, r2: 2 });
		expect(() => wb.ref('zNope')).toThrow(NotB023WorkbookError);
		expect(() => wb.ref('zBad')).toThrow(InvalidWorkbookError);
	});

	it('ignores sheet-scoped names, as openpyxl wb.defined_names does', () => {
		const book = small().book();
		book.Workbook!.Names!.push({ Name: 'zLocal', Ref: "'It''s here'!$A$1", Sheet: 0 });
		expect(new B023Workbook(sheetjsSource(book)).has('zLocal')).toBe(false);
	});

	it('reads cached values the way openpyxl does', () => {
		const wb = new B023Workbook(small().build());
		const s = "It's here";
		expect(wb.cellNamed('zCell')).toEqual(new XlDateTime('2010-01-10', 0));
		expect(wb.cell(s, 4, 3)).toEqual(new XlDuration(1.5));
		expect(wb.cell(s, 4, 4)).toBe('#N/A');
		expect(wb.cell(s, 4, 5)).toBe(true);
		expect(wb.cell(s, 4, 6)).toBe(4320);
		expect(wb.cell(s, 4, 7)).toBe(40188); // a number format that isn't a date keeps the number
		expect(wb.cell(s, 26, 100)).toBeNull();
		expect(wb.lastRow(s)).toBe(9);
	});

	it('reads a table down to its -- sentinel, skipping blanks and separators', () => {
		const t = new B023Workbook(small().build()).tableRows('zList');
		expect(t.names).toEqual(['One', 'Two words', 'Three']);
		expect(t.rows).toEqual([3, 4, 7]);
	});

	it('reads a saved file (dense sheets, and the streaming reader) the same as an in-memory one (sparse)', async () => {
		const b = small();
		const mem = new B023Workbook(b.build());
		const file = new B023Workbook(sheetjsSource(XLSX.read(b.toFile(), { type: 'array', dense: true, cellNF: true })));
		// readWorkbook() parses the sheets b023 names point at, so point one there.
		const streamed = new B023Workbook(await readWorkbook(small().name('zAppVer', "'It''s here'!$D$6").toFile()));
		for (let r = 1; r <= 9; r++) {
			for (let c = 1; c <= 4; c++) {
				expect(file.cell("It's here", c, r), `${c},${r}`).toEqual(mem.cell("It's here", c, r));
				expect(streamed.cell("It's here", c, r), `${c},${r}`).toEqual(mem.cell("It's here", c, r));
			}
		}
		expect(streamed.lastRow("It's here")).toBe(9);
	});
});

describe('readWorkbook', () => {
	it('parses only the sheets the named ranges point at', async () => {
		const b = syntheticB023().set('Farm A', 'A1', 'an Element sheet');
		const seen: string[] = [];
		const wb = await readWorkbook(b.toFile(), { onProgress: (s, i, n) => seen.push(`${i}/${n} ${s}`) });
		// One step per b023 sheet, in order; never the Element sheet.
		expect(seen).toEqual(['AppSettings', 'Network', 'Farm spec', 'Crop demand', 'Farm demand', 'Transfers', 'Flow data', 'Flow Calibration Cfg', 'EWR Cfg'].map((s, i) => `${i + 1}/9 ${s}`));
		expect(wb.sheetNames).toContain('Farm A');
		expect(wb.sheet('Farm A')).toBeUndefined();
		expect(wb.sheet('Network')).toBeDefined();
	});

	it('reads the tables from other sheets when the named ranges point there', async () => {
		// The same workbook with [Network] renamed: the second pass picks the new name up.
		const b = syntheticB023();
		const book = b.book();
		const i = book.SheetNames.indexOf('Network');
		book.SheetNames[i] = 'Netwerk';
		book.Sheets['Netwerk'] = book.Sheets['Network']!;
		delete book.Sheets['Network'];
		for (const n of book.Workbook!.Names!) n.Ref = n.Ref.replace(/^Network!/, 'Netwerk!');
		const file = XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as Uint8Array<ArrayBuffer>;
		const wb = await readWorkbook(file);
		expect(wb.sheet('Netwerk')).toBeDefined();
		expect(wb.sheet('Network')).toBeUndefined();
		expect(extractProject(wb, { fileName: 'x.xlsm' }).project.model.nodes.map((n) => n.name)).toEqual(['Farm A', 'Farm B', 'Outlet']);
	});

	it('refuses files over the limits before or while parsing', async () => {
		const file = syntheticB023().toFile();
		await expect(readWorkbook(file, { maxBytes: 100 })).rejects.toMatchObject({ code: 'too-large', what: 'bytes' });
		await expect(readWorkbook(file, { maxSheets: 3 })).rejects.toMatchObject({ code: 'too-large', what: 'sheets' });
		// workbook.xml, with its defined names, is over 1 KB.
		await expect(readWorkbook(file, { maxEntryBytes: 1_000 })).rejects.toMatchObject({ code: 'too-large', what: 'unpacked' });
		await expect(readWorkbook(file, { maxTotalBytes: 5_000 })).rejects.toBeInstanceOf(WorkbookTooLargeError);
	});

	it('inflates only the parts it reads', async () => {
		// A large Element sheet: the total cap leaves no room for it, so reading
		// succeeds only if it is never inflated.
		const big = syntheticB023();
		for (let r = 1; r <= 2000; r++) big.row('Farm A', `A${r}`, Array.from({ length: 20 }, (_, i) => r * 100 + i));
		const file = new Uint8Array(big.toFile());
		const zip = await ZipArchive.open(file);
		const sizes = zip.names.map((n) => zip.info(n)!.size);
		const all = sizes.reduce((a, b) => a + b, 0);
		const largest = Math.max(...sizes);
		expect(largest).toBeGreaterThan(all / 2); // the Farm A sheet
		const wb = await readWorkbook(file, { maxTotalBytes: all - largest });
		expect(wb.sheet('Network')).toBeDefined();
		expect(wb.sheetNames).toContain('Farm A');
		expect(wb.sheet('Farm A')).toBeUndefined();
		await expect(readWorkbook(file, { maxTotalBytes: 1_000 })).rejects.toBeInstanceOf(WorkbookTooLargeError);
	});

	it('says when the file is not a workbook at all', async () => {
		await expect(readWorkbook(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).rejects.toBeInstanceOf(UnreadableWorkbookError);
		await expect(readWorkbook(new TextEncoder().encode('name,value\nx,1\n'))).rejects.toMatchObject({ code: 'unreadable', reason: 'not-zip' });
	});

	it('explains an old .xls or a password-protected file (an OLE container, not a zip)', async () => {
		const ole = new Uint8Array(512);
		ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
		const err = (await readWorkbook(ole).catch((e: unknown) => e)) as UnreadableWorkbookError;
		expect(err).toBeInstanceOf(UnreadableWorkbookError);
		expect(err.message).toMatch(/password-protected or an old-format \.xls/);
	});

	it('says a zip that is not an Office file is not a workbook', async () => {
		const notOffice = storedZip([{ name: 'readme.txt', data: new TextEncoder().encode('hello'), crc: crc32(new TextEncoder().encode('hello')) }]);
		await expect(readWorkbook(notOffice)).rejects.toMatchObject({ code: 'unreadable', reason: 'not-workbook' });
	});

	it('refuses malformed or hostile XML in a part it reads, with a typed error', async () => {
		const reason = async (file: Uint8Array<ArrayBuffer>) => {
			const e = await readWorkbook(file).catch((err: unknown) => err);
			return e instanceof UnreadableWorkbookError ? e.reason : e;
		};
		const sheet = (xml: string) => workbookPackage({ sheets: [['S', xml]] });
		expect(await reason(sheet(worksheet('<row r="1"><c r="A1"><v>1</v></row>')))).toBe('corrupt'); // unclosed <c>
		expect(await reason(sheet(`<!DOCTYPE w [<!ENTITY a "${'x'.repeat(100)}">]>${worksheet('<row r="1"><c r="A1" t="str"><v>&a;</v></c></row>')}`))).toBe('corrupt');
		expect(await reason(sheet(worksheet(`<row r="1"><c r="A1" huge="${'x'.repeat(2 << 20)}"><v>1</v></c></row>`)))).toBe('corrupt');
		expect(await reason(sheet(worksheet('<row r="1"><c r="A1" t="s"><v>7</v></c></row>')))).toBe('corrupt'); // no such shared string
		expect(await reason(workbookPackage({ sheets: [['S', worksheet('')]], workbook: '<!DOCTYPE x><workbook/>' }))).toBe('corrupt');
		expect(await reason(workbookPackage({ sheets: [['S', worksheet('')]], workbook: '<workbook xmlns="urn:not-excel"/>' }))).toBe('not-workbook');
		expect(await reason(workbookPackage({ sheets: [['S', worksheet('')]], styles: '<styleSheet/>', omit: ['xl/styles.xml'] }))).toBe('corrupt');
		expect(await reason(workbookPackage({ sheets: [['S', worksheet('')]], contentTypes: '<Types xmlns="urn:other"/>' }))).toBe('not-workbook');
	});

	it('never parses a sheet it does not read, however broken', async () => {
		const file = workbookPackage({ sheets: [['S', worksheet('<row r="1"><c r="A1"><v>1</v></c></row>')], ['Element', '<not xml at all']] });
		const wb = await readWorkbook(file);
		expect(wb.sheet('S')?.cell(1, 1)).toEqual({ t: 'n', v: 1, z: 'General' });
		expect(wb.sheet('Element')).toBeUndefined();
	});

	it('reads dates from a saved file as the same serials', async () => {
		const wb = new B023Workbook(await readWorkbook(syntheticB023().toFile()));
		expect(wb.cellNamed('zCalibration_Date1')).toEqual(new XlDateTime('2010-01-01', 0));
		expect(serialOf('2010-01-01')).toBe(40179);
	});
});
