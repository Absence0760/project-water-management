import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { XlDateTime, XlDuration } from './cells';
import { InvalidWorkbookError, NotB023WorkbookError, UnreadableWorkbookError, WorkbookTooLargeError } from './errors';
import { extractProject } from './extract';
import { WorkbookBuilder, serialOf, syntheticB023 } from './testWorkbook';
import { B023Workbook, readWorkbook } from './workbook';

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
	it('parses only the sheets the named ranges point at', () => {
		const b = syntheticB023().set('Farm A', 'A1', 'an Element sheet');
		const wb = readWorkbook(b.toFile());
		expect(wb.SheetNames).toContain('Farm A');
		expect(wb.Sheets['Farm A']).toBeUndefined();
		expect(wb.Sheets['Network']).toBeDefined();
	});

	it('reads the tables from other sheets when the named ranges point there', () => {
		// The same workbook with [Network] renamed: the second pass picks the new name up.
		const b = syntheticB023();
		const book = b.build();
		const i = book.SheetNames.indexOf('Network');
		book.SheetNames[i] = 'Netwerk';
		book.Sheets['Netwerk'] = book.Sheets['Network']!;
		delete book.Sheets['Network'];
		for (const n of book.Workbook!.Names!) n.Ref = n.Ref.replace(/^Network!/, 'Netwerk!');
		const file = XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
		const wb = readWorkbook(file);
		expect(wb.Sheets['Netwerk']).toBeDefined();
		expect(extractProject(wb, { fileName: 'x.xlsm' }).project.model.nodes.map((n) => n.name)).toEqual(['Farm A', 'Farm B', 'Outlet']);
	});

	it('refuses files over the limits before or while parsing', () => {
		const file = syntheticB023().toFile();
		expect(() => readWorkbook(file, { maxBytes: 100 })).toThrow(WorkbookTooLargeError);
		const err = (() => {
			try {
				readWorkbook(file, { maxSheets: 3 });
			} catch (e) {
				return e as WorkbookTooLargeError;
			}
		})();
		expect(err).toBeInstanceOf(WorkbookTooLargeError);
		expect(err?.what).toBe('sheets');
	});

	it('says when the file is not a workbook at all', () => {
		expect(() => readWorkbook(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).toThrow(UnreadableWorkbookError);
	});

	it('reads dates from a saved file as the same serials', () => {
		const wb = new B023Workbook(readWorkbook(syntheticB023().toFile()));
		expect(wb.cellNamed('zCalibration_Date1')).toEqual(new XlDateTime('2010-01-01', 0));
		expect(serialOf('2010-01-01')).toBe(40179);
	});
});
