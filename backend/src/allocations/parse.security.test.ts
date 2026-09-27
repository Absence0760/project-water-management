// Hostile allocation files: each is refused (ImportRefused → 422) or flagged
// per row, bounded by the text, row and column caps; never a crash.
import { describe, expect, it } from 'vitest';
import { IMPORT_MAX_CHARS, IMPORT_MAX_COLUMNS, IMPORT_MAX_ROWS, ImportRefused, parseAllocationTable, splitCsv } from './parse.js';

const row = 'REG-1,surface,licence,1000';
const HEAD = 'registration_no,water_source,authorisation,volume_m3_year';

describe('allocation file limits', () => {
	it(`refuses a row wider than ${IMPORT_MAX_COLUMNS} columns, header or data, and takes one at the cap (positive control)`, () => {
		const pad = (n: number) => ','.repeat(n);
		const atCap = `${HEAD}${pad(IMPORT_MAX_COLUMNS - 4)}\n${row}${pad(IMPORT_MAX_COLUMNS - 4)}`;
		expect(splitCsv(atCap, ',')[0]!.cells).toHaveLength(IMPORT_MAX_COLUMNS);
		expect(parseAllocationTable(atCap, 'csv').rows[0]!.errors).toEqual([]);
		expect(() => parseAllocationTable(`${HEAD}${pad(IMPORT_MAX_COLUMNS - 3)}\n${row}`, 'csv')).toThrow(/line 1 has more than/);
		expect(() => parseAllocationTable(`${HEAD}\n${row}\n${row}${pad(IMPORT_MAX_COLUMNS)}`, 'csv')).toThrow(/line 3 has more than/);
	});

	it('refuses a header of a million columns at once, without building them', () => {
		const text = `volume${','.repeat(IMPORT_MAX_CHARS - 10)}`;
		expect(text.length).toBeLessThanOrEqual(IMPORT_MAX_CHARS);
		expect(() => parseAllocationTable(text, 'csv')).toThrow(ImportRefused);
	});

	it('refuses text past the size cap and rows past the row cap, and takes the row cap itself (positive control)', () => {
		expect(() => parseAllocationTable('x'.repeat(IMPORT_MAX_CHARS + 1), 'csv')).toThrow(/larger than/);
		const rows = (n: number) => `${HEAD}\n${Array.from({ length: n }, () => row).join('\n')}`;
		expect(parseAllocationTable(rows(IMPORT_MAX_ROWS), 'csv').rows).toHaveLength(IMPORT_MAX_ROWS);
		expect(() => parseAllocationTable(rows(IMPORT_MAX_ROWS + 1), 'csv')).toThrow(/more than 5000 rows/);
	});

	it('flags junk numbers and a NUL per row, and reads a BOM header (positive control: the clean row passes)', () => {
		const t = parseAllocationTable(`﻿${HEAD}\nA,surface,licence,1e400\nB,surface,licence,NaN\nC,surface,licence,Infinity\nD\u0000,surface,licence,1\n${row}`, 'csv');
		expect(t.columns.registrationNo).toBe('registration_no');
		const [inf, nan, infinity, nul, ok] = t.rows;
		for (const r of [inf, nan, infinity]) expect(r!.errors.join(' ')).toMatch(/not a number/);
		expect(nul!.errors.join(' ')).toMatch(/NUL/);
		expect(ok!.errors).toEqual([]);
		expect(ok!.volumeM3PerYear).toBe(1000);
	});
});
