import { describe, expect, it } from 'vitest';
import { CsvError, parseDate, parseSeriesCsv } from './csv';

describe('parseDate', () => {
	it('accepts ISO, slashed and day-first dates', () => {
		expect(parseDate('2020-01-05')).toBe('2020-01-05');
		expect(parseDate('2020/1/5')).toBe('2020-01-05');
		expect(parseDate('05/01/2020')).toBe('2020-01-05');
		expect(parseDate('2020-01-05 00:00:00')).toBe('2020-01-05');
	});
	it('rejects impossible dates', () => {
		expect(parseDate('2021-02-29')).toBeNull();
		expect(parseDate('date')).toBeNull();
	});
});

describe('parseSeriesCsv', () => {
	it('parses a file with a header row', () => {
		const r = parseSeriesCsv('date,value\n2020-01-01,1.5\n2020-01-02,2\n');
		expect(r).toEqual({ startDate: '2020-01-01', endDate: '2020-01-02', values: [1.5, 2], rowCount: 2, missingCount: 0, dateOrder: 'iso', dateOrderAssumed: false });
	});

	it('parses a file without a header, CRLF and BOM', () => {
		const r = parseSeriesCsv('﻿2020-01-01,3\r\n2020-01-02,4\r\n');
		expect(r.values).toEqual([3, 4]);
	});

	it('fills gaps and blank values with null and sorts out-of-order rows', () => {
		const r = parseSeriesCsv('2020-01-04,4\n2020-01-01,1\n2020-01-02,\n');
		expect(r.startDate).toBe('2020-01-01');
		expect(r.values).toEqual([1, null, null, 4]);
		expect(r.rowCount).toBe(2);
		expect(r.missingCount).toBe(2);
	});

	it('crosses month and leap-year boundaries', () => {
		const r = parseSeriesCsv('2020-02-28,1\n2020-03-01,3');
		expect(r.values).toEqual([1, null, 3]);
	});

	it('supports semicolon-delimited and quoted cells', () => {
		expect(parseSeriesCsv('"2020-01-01";"5"\n').values).toEqual([5]);
	});

	it('reports the bad line', () => {
		expect(() => parseSeriesCsv('date,value\n2020-01-01,1\nnope,2')).toThrow(/Line 3/);
		expect(() => parseSeriesCsv('2020-01-01,abc')).toThrow(CsvError);
		expect(() => parseSeriesCsv('2020-01-01,1\n2020-01-01,2')).toThrow(/duplicate/);
		expect(() => parseSeriesCsv('date,value\n')).toThrow(/no data/);
	});

	it('enforces the 60 000 value limit', () => {
		expect(() => parseSeriesCsv('1900-01-01,1\n2100-01-01,1')).toThrow(/limit/);
	});
});

describe('parseSeriesCsv date order', () => {
	it('reads a US month/day file as month/day, not silently as day/month', () => {
		const r = parseSeriesCsv('date,value\n03/04/2020,1\n03/13/2020,2\n');
		expect(r.dateOrder).toBe('mdy');
		expect(r.dateOrderAssumed).toBe(false);
		expect(r.startDate).toBe('2020-03-04');
		expect(r.endDate).toBe('2020-03-13');
	});

	it('reads a South African day/month file as day/month', () => {
		const r = parseSeriesCsv('03/04/2020,1\n13/04/2020,2\n');
		expect([r.dateOrder, r.dateOrderAssumed, r.startDate, r.endDate]).toEqual(['dmy', false, '2020-04-03', '2020-04-13']);
	});

	it('assumes day/month, and says so, when no day above 12 settles it', () => {
		const r = parseSeriesCsv('01/02/2020,1\n02/02/2020,2\n');
		expect([r.dateOrder, r.dateOrderAssumed, r.startDate]).toEqual(['dmy', true, '2020-02-01']);
	});

	it('rejects a file that mixes both orders', () => {
		expect(() => parseSeriesCsv('13/01/2020,1\n01/14/2020,2\n')).toThrow(/mix day\/month and month\/day/);
	});

	it('year-first dates are unaffected', () => {
		const r = parseSeriesCsv('2020-01-05,1\n2020/01/06,2\n');
		expect([r.dateOrder, r.dateOrderAssumed]).toEqual(['iso', false]);
	});

	it('an impossible first date is an error, not a skipped header', () => {
		expect(() => parseSeriesCsv('31/02/2020,1\n01/03/2020,2\n')).toThrow(/Line 1: "31\/02\/2020" is not a date/);
		expect(parseSeriesCsv('Date;Rain\n01/03/2020;2\n').rowCount).toBe(1);
	});
});

