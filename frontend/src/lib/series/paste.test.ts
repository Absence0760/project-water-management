import { describe, expect, it } from 'vitest';
import { CsvError } from './csv';
import { MAX_PASTE_CHARS, parsePastedSeries } from './paste';

describe('parsePastedSeries', () => {
	it('reads a block copied from a spreadsheet: tab-separated, CRLF, with a header', () => {
		const p = parsePastedSeries('Date\tRain (mm)\r\n2025-04-01\t0\r\n2025-04-02\t12.4\r\n2025-04-04\t3.6\r\n');
		expect(p).toMatchObject({ startDate: '2025-04-01', endDate: '2025-04-04', values: [0, 12.4, null, 3.6], rowCount: 3, missingCount: 1 });
	});

	it('reads decimal commas and day/month dates, as a South African spreadsheet copies them', () => {
		const p = parsePastedSeries('01/04/2025\t1,5\n13/04/2025\t2,25');
		expect(p.startDate).toBe('2025-04-01');
		expect(p.values[0]).toBe(1.5);
		expect(p.values.at(-1)).toBe(2.25);
		expect(p.dateOrder).toBe('dmy');
	});

	it('reads blanks and placeholders as gaps, and counts the negatives', () => {
		const p = parsePastedSeries('2025-04-01\t\n2025-04-02\tNA\n2025-04-03\t-999\n2025-04-04\t1');
		expect(p.values).toEqual([null, null, null, 1]);
		expect(p.negativeGaps).toBe(1);
	});

	it('reads comma rows typed or copied as text', () => {
		expect(parsePastedSeries('2025-04-01,1\n2025-04-02,2').values).toEqual([1, 2]);
	});

	it('asks for a day boundary for sub-daily rows, and adds them up with one', () => {
		const text = '2025-04-01 09:00\t1\n2025-04-01 10:00\t2\n2025-04-02 09:00\t4';
		expect(() => parsePastedSeries(text)).toThrow(expect.objectContaining({ subDaily: true }));
		expect(parsePastedSeries(text, { dayBoundary: '00:00' }).values).toEqual([3, 4]);
	});

	it('refuses an empty box, a bad row (naming its line) and an oversized paste', () => {
		expect(() => parsePastedSeries('  \n ')).toThrow(CsvError);
		expect(() => parsePastedSeries('2025-04-01\t1\nnot a date\t2')).toThrow(/Line 2/);
		expect(() => parsePastedSeries('2025-04-01\t1\n2025-04-01\t2')).toThrow(/duplicate date/);
		expect(() => parsePastedSeries('x'.repeat(MAX_PASTE_CHARS + 1))).toThrow(/upload it as a file/);
	});
});
