import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { XlDateTime, XlDuration } from './cells';
import { InvalidWorkbookError, NotB023WorkbookError, UnreadableWorkbookError, WorkbookTooLargeError } from './errors';
import { extractProject } from './extract';
import { WorkbookBuilder, serialOf, syntheticB023 } from './testWorkbook';
import { B023Workbook, readWorkbook } from './workbook';
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
		const book = small().build();
		book.Workbook!.Names!.push({ Name: 'zLocal', Ref: "'It''s here'!$A$1", Sheet: 0 });
		expect(new B023Workbook(book).has('zLocal')).toBe(false);
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

	it('reads a saved file (dense sheets) the same as an in-memory one (sparse)', () => {
		const b = small();
		const mem = new B023Workbook(b.build());
		const file = new B023Workbook(XLSX.read(b.toFile(), { type: 'array', dense: true, cellNF: true }));
		for (let r = 1; r <= 9; r++) for (let c = 1; c <= 4; c++) expect(file.cell("It's here", c, r), `${c},${r}`).toEqual(mem.cell("It's here", c, r));
	});
});

describe('readWorkbook', () => {
	it('parses only the sheets the named ranges point at', async () => {
		const b = syntheticB023().set('Farm A', 'A1', 'an Element sheet');
		const seen: string[] = [];
		const wb = await readWorkbook(b.toFile(), { onProgress: (s, i, n) => seen.push(`${i}/${n} ${s}`) });
		// One step per b023 sheet, in order; never the Element sheet.
		expect(seen).toEqual(['AppSettings', 'Network', 'Farm spec', 'Crop demand', 'Farm demand', 'Transfers', 'Flow data', 'Flow Calibration Cfg', 'EWR Cfg'].map((s, i) => `${i + 1}/9 ${s}`));
		expect(wb.SheetNames).toContain('Farm A');
		expect(wb.Sheets['Farm A']).toBeUndefined();
		expect(wb.Sheets['Network']).toBeDefined();
	});

	it('reads the tables from other sheets when the named ranges point there', async () => {
		// The same workbook with [Network] renamed: the second pass picks the new name up.
		const b = syntheticB023();
		const book = b.build();
		const i = book.SheetNames.indexOf('Network');
		book.SheetNames[i] = 'Netwerk';
		book.Sheets['Netwerk'] = book.Sheets['Network']!;
		delete book.Sheets['Network'];
		for (const n of book.Workbook!.Names!) n.Ref = n.Ref.replace(/^Network!/, 'Netwerk!');
		const file = XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
		const wb = await readWorkbook(file);
		expect(wb.Sheets['Netwerk']).toBeDefined();
		expect(wb.Sheets['Network']).toBeUndefined();
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
		const zip = ZipArchive.open(file);
		const sizes = zip.names.map((n) => zip.info(n)!.size);
		const all = sizes.reduce((a, b) => a + b, 0);
		const largest = Math.max(...sizes);
		expect(largest).toBeGreaterThan(all / 2); // the Farm A sheet
		const wb = await readWorkbook(file, { maxTotalBytes: all - largest });
		expect(wb.Sheets['Network']).toBeDefined();
		expect(wb.SheetNames).toContain('Farm A');
		expect(wb.Sheets['Farm A']).toBeUndefined();
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

	it('reads dates from a saved file as the same serials', async () => {
		const wb = new B023Workbook(await readWorkbook(syntheticB023().toFile()));
		expect(wb.cellNamed('zCalibration_Date1')).toEqual(new XlDateTime('2010-01-01', 0));
		expect(serialOf('2010-01-01')).toBe(40179);
	});
});
