import { describe, expect, it } from 'vitest';
import { bookedDay, CsvError, parseDate, parseSeriesCsv, parseTime } from './csv';

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

	it('reads a file with bare CR line endings (Excel for Mac’s "CSV (Macintosh)")', () => {
		const r = parseSeriesCsv('date,value\r2020-01-01,3\r2020-01-02,4\r');
		expect([r.startDate, r.endDate, r.values]).toEqual(['2020-01-01', '2020-01-02', [3, 4]]);
	});

	it('refuses a span over the limit, naming its first and last dates', () => {
		expect(() => parseSeriesCsv('1820-01-05,1\n2020-01-01,2\n2020-01-02,3')).toThrow(/spans .* days, from 1820-01-05 to 2020-01-02; the limit is .*mistyped year/);
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

	it('reads a tab file whose last cell is blank as a gap, and skips rows of only tabs (issue #477)', () => {
		// A spreadsheet copies or saves a blank value as a trailing tab: trimming it away would leave one column.
		const p = parseSeriesCsv('2025-04-01\t1\r\n2025-04-02\t\r\n\t\r\n2025-04-03\t3 \r\n');
		expect(p.values).toEqual([1, null, 3]);
		expect(p.missingCount).toBe(1);
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


// Sub-daily readings added up into days (issue #40 (b) amendment 5): an
// automatic station's hourly record, aggregated to the manual gauges' 08:00
// day or to midnight. Timestamps close their interval.
describe('sub-daily files', () => {
	/** An hourly file from 2020-03-04 09:00 to 2020-03-07 08:00 (72 readings), with `storm` mm an hour at the given stamps. */
	function hourly(storm: Record<string, number>): string {
		const rows = ['timestamp,rain_mm'];
		for (let h = 0; h < 72; h++) {
			const t = Date.UTC(2020, 2, 4, 9 + h);
			const iso = new Date(t).toISOString();
			const stamp = `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
			rows.push(`${stamp},${storm[stamp] ?? 0}`);
		}
		return rows.join('\n');
	}
	// A storm from 20:00 on the 5th to 04:00 on the 6th: 2 mm in each of the eight hours, straddling midnight.
	const storm: Record<string, number> = {};
	for (const s of ['2020-03-05 21:00', '2020-03-05 22:00', '2020-03-05 23:00', '2020-03-06 00:00', '2020-03-06 01:00', '2020-03-06 02:00', '2020-03-06 03:00', '2020-03-06 04:00']) storm[s] = 2;

	it('adds a storm straddling midnight into one 08:00–08:00 day, booked to the day it starts', () => {
		const r = parseSeriesCsv(hourly(storm), { dayBoundary: '08:00' });
		// Windows: 4th 08:00 → 5th 08:00, 5th → 6th, 6th → 7th; the whole storm falls on the 5th.
		expect(r.startDate).toBe('2020-03-04');
		expect(r.values).toEqual([0, 16, 0]);
		expect(r.subDaily).toEqual({ dayBoundary: '08:00', readings: 72, readingsPerDay: 24, incompleteDays: 0 });
	});

	it('splits the same storm at midnight with the 00:00 boundary', () => {
		const r = parseSeriesCsv(hourly(storm), { dayBoundary: '00:00' });
		// The 4th (09:00–24:00: 16 readings), 5th (21:00–24:00: 4 × 2 mm), 6th (01:00–04:00), 7th (01:00–08:00).
		expect(r.startDate).toBe('2020-03-04');
		expect(r.values).toEqual([0, 8, 8, 0]);
		expect(r.subDaily!.readingsPerDay).toBe(24);
		expect(r.subDaily!.incompleteDays).toBe(2);
	});

	it('gives the same days at UTC+14 and UTC−11 (no local-time parsing)', () => {
		const tz = process.env.TZ;
		try {
			process.env.TZ = 'Pacific/Kiritimati';
			const east = parseSeriesCsv(hourly(storm), { dayBoundary: '08:00' });
			process.env.TZ = 'Pacific/Pago_Pago';
			expect(parseSeriesCsv(hourly(storm), { dayBoundary: '08:00' })).toEqual(east);
		} finally {
			process.env.TZ = tz;
		}
	});

	it('asks for a boundary when a file has several timed readings a day, and needs a time on every row once it has one', () => {
		let err: unknown;
		try {
			parseSeriesCsv(hourly(storm));
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(CsvError);
		expect((err as CsvError).subDaily).toBe(true);
		expect((err as CsvError).message).toMatch(/^Line 3: several readings on 2020-03-04: this looks like sub-daily data/);
		// A plain duplicate date is still just that.
		expect(() => parseSeriesCsv('2020-01-01,1\n2020-01-01,2')).toThrow(/duplicate date 2020-01-01/);
		expect(() => parseSeriesCsv('2020-01-01 10:00,1\n2020-01-01,2', { dayBoundary: '08:00' })).toThrow(/has no time/);
		expect(() => parseSeriesCsv('2020-01-01 25:00,1', { dayBoundary: '08:00' })).toThrow(/isn't HH:MM/);
		// A daily file whose dates carry midnight still reads as daily.
		expect(parseSeriesCsv('2020-01-01 00:00:00,1\n2020-01-02 00:00:00,2').values).toEqual([1, 2]);
	});

	it('books a reading stamped exactly at the boundary to the window it closes; blanks are no reading', () => {
		expect(parseTime('2020-01-05 08:30')).toBe(510);
		expect(parseTime('2020-01-05T24:00:00')).toBe(1440);
		expect(parseTime('2020-01-05')).toBeNull();
		// A 12-hour clock: the AM/PM is read, not dropped (7:00 PM was read as 07:00, 12:00 AM as noon).
		expect(parseTime('1/5/2020 7:00 PM')).toBe(1140);
		expect(parseTime('1/5/2020 7:00:30 am')).toBe(420.5);
		expect(parseTime('1/5/2020 12:00:00 AM')).toBe(0);
		expect(parseTime('1/5/2020 12:15 PM')).toBe(735);
		expect(parseTime('1/5/2020 7:00PM')).toBe(1140);
		expect(parseTime('1/5/2020 13:00 PM')).toBeNaN();
		expect(parseTime('1/5/2020 0:30 AM')).toBeNaN();
		// Anything else after the time would shift the hour if dropped: refused.
		expect(parseTime('2020-01-05T08:00:00Z')).toBeNaN();
		expect(parseTime('2020-01-05 08:00 +02:00')).toBeNaN();
		const day = (iso: string, hm: string) => new Date(bookedDay(iso, parseTime(`${iso} ${hm}`)!, '08:00') * 86_400_000).toISOString().slice(0, 10);
		expect(day('2020-01-06', '08:00')).toBe('2020-01-05');
		expect(day('2020-01-06', '08:01')).toBe('2020-01-06');
		expect(day('2020-01-06', '00:00')).toBe('2020-01-05');
		const r = parseSeriesCsv('2020-01-05 09:00,1\n2020-01-05 10:00,\n2020-01-06 09:00,', { dayBoundary: '08:00' });
		// The 6th has only a blank: no reading, not 0.
		expect(r.values).toEqual([1, null]);
		// An evening reading on a 12-hour clock belongs to the day it falls in, not the window before.
		const pm = parseSeriesCsv('2020-01-02 7:00 AM,1\n2020-01-02 7:00 PM,2\n2020-01-03 7:00 AM,4', { dayBoundary: '08:00' });
		expect([pm.startDate, pm.values]).toEqual(['2020-01-01', [1, 6]]);
	});
});

// Issue #45: delimiter and decimal separator are decided per file, never per
// row, and an error names the real problem (a number, not "not a date").
describe('parseSeriesCsv delimiters and decimal separators', () => {
	const values = (text: string) => parseSeriesCsv(text).values;

	it('reads a semicolon file with decimal commas (the old splitter read 2020-01-05;12 as the date)', () => {
		expect(values('date;value\n2020-01-05;12,5\n2020-01-06;0,359\n2020-01-07;3\n')).toEqual([12.5, 0.359, 3]);
		expect(values('Datum;Reën (mm)\n05/01/2020;12,5\n06/01/2020;\n')).toEqual([12.5, null]);
	});

	it('reads a tab file with decimal commas, and one with decimal points', () => {
		expect(values('2020-01-05\t12,5\n2020-01-06\t1,25\n')).toEqual([12.5, 1.25]);
		expect(values('date\tvalue\n2020-01-05\t12.5\n')).toEqual([12.5]);
	});

	it('reads quoted decimal commas and thousands separators in a comma file', () => {
		expect(values('date,value\n2020-01-05,"12,5"\n2020-01-06,"0,25"\n')).toEqual([12.5, 0.25]);
		expect(values('date,value\n2020-01-05,"1,234.5"\n2020-01-06,"1,234,567"\n2020-01-07,2.5\n')).toEqual([1234.5, 1234567, 2.5]);
		// A quote inside a quoted field, and a quoted header.
		expect(values('"date","value ""mm"""\n"2020-01-05","3"\n')).toEqual([3]);
	});

	it('reads thousands separators with a decimal comma: dots and spaces', () => {
		expect(values('2020-01-05;1.234,5\n2020-01-06;1 234,5\n2020-01-07;1 234\n2020-01-08;0,5\n')).toEqual([1234.5, 1234.5, 1234, 0.5]);
	});

	it('settles a value that reads either way from the rest of the file', () => {
		// 0,359 says decimal comma, so 1,897 is 1.897 (a DWS-style flow), not 1897.
		expect(values('2020-01-05;1,897\n2020-01-06;0,359\n')).toEqual([1.897, 0.359]);
		// 2.5 says decimal point, so 1.234 is 1.234.
		expect(values('2020-01-05;1.234\n2020-01-06;2.5\n')).toEqual([1.234, 2.5]);
		// A comma file's unquoted values can't hold a decimal comma: 1.234 is 1.234, and a quoted 1,234 is a thousand.
		expect(values('2020-01-05,1.234\n2020-01-06,"1,234"\n')).toEqual([1.234, 1234]);
	});

	it('refuses a value nothing in the file settles, rather than guessing', () => {
		expect(() => parseSeriesCsv('2020-01-05;1,234\n2020-01-06;5\n')).toThrow(
			/^Line 1: "1,234" could be 1234 or 1\.234, and no other value in the file shows whether "," is a decimal or a thousands separator/
		);
		expect(() => parseSeriesCsv('date\tvalue\n2020-01-05\t2.500\n')).toThrow(/Line 2: "2\.500" could be 2500 or 2\.500/);
	});

	it('refuses a file that mixes decimal points and decimal commas, naming a line of each', () => {
		expect(() => parseSeriesCsv('2020-01-05;12,5\n2020-01-06;3.25\n')).toThrow(
			'the file mixes decimal points ("3.25", line 2) and decimal commas ("12,5", line 1); use one throughout'
		);
	});

	it('says a bad number is a bad number, and a row split another way is that, not a bad date', () => {
		expect(() => parseSeriesCsv('2020-01-05;12,5\n2020-01-06;1,2,3\n')).toThrow('Line 2: "1,2,3" is not a number');
		expect(() => parseSeriesCsv('2020-01-05;12,5\n2020-01-06;1.2.3\n')).toThrow('Line 2: "1.2.3" is not a number');
		expect(() => parseSeriesCsv('date,value\n2020-01-05,1\n2020-01-06,2\n2020-01-07;3\n')).toThrow(
			'Line 4: this row separates its columns with semicolons, but the file uses commas'
		);
		expect(() => parseSeriesCsv('2020-01-05,0x10')).toThrow('"0x10" is not a number');
	});

	it('reads YYYYMMDD dates in a CSV', () => {
		expect(parseSeriesCsv('20200105,1\n20200107,2\n')).toMatchObject({ startDate: '2020-01-05', values: [1, null, 2], dateOrder: 'iso' });
	});

	it('positive control: an ordinary comma CSV parses exactly as before', () => {
		const text = 'date,value\n2021-10-01,0\n2021-10-02,12.4\n2021-10-03,\n2021-10-04,NA\n2021-10-05,-\n2021-10-06, 7 \n2021-10-07,1e1\n2021-10-08,.5\n';
		expect(parseSeriesCsv(text)).toEqual({
			startDate: '2021-10-01',
			endDate: '2021-10-08',
			values: [0, 12.4, null, null, null, 7, 10, 0.5],
			rowCount: 5,
			missingCount: 3,
			dateOrder: 'iso',
			dateOrderAssumed: false
		});
	});
});

describe('negative values (issue #51)', () => {
	it('reads a negative value as a gap, counted, as the DWS import does', () => {
		const p = parseSeriesCsv('date,value\n2020-01-01,-999\n2020-01-02,0.5\n2020-01-03,-1\n2020-01-04,0');
		expect(p.values).toEqual([null, 0.5, null, 0]);
		expect(p.negativeGaps).toBe(2);
		expect([p.rowCount, p.missingCount]).toEqual([2, 2]);
		// Positive control: a file without one says nothing, and 0 is a value.
		expect(parseSeriesCsv('date,value\n2020-01-01,0\n2020-01-02,0.5')).not.toHaveProperty('negativeGaps');
	});

	it('leaves a negative sub-daily reading out of its day’s total', () => {
		const p = parseSeriesCsv('date,value\n2020-01-01 09:00,-999\n2020-01-01 10:00,2\n2020-01-02 09:00,1', { dayBoundary: '08:00' });
		expect(p.negativeGaps).toBe(1);
		expect(p.values[0]).toBe(2);
	});
});
