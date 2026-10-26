import { describe, expect, it } from 'vitest';
import { dayText, daysInText, fromEpochDay, monthOfEpochDay, toEpochDay, waterYearIndex, waterYearOf } from './calendar';

describe('waterYearIndex', () => {
	it('maps October to 0 and September to 11', () => {
		expect(waterYearIndex(10)).toBe(0);
		expect(waterYearIndex(1)).toBe(3);
		expect(waterYearIndex(9)).toBe(11);
	});
	it('rejects out-of-range months', () => {
		expect(() => waterYearIndex(0)).toThrow(RangeError);
		expect(() => waterYearIndex(13)).toThrow(RangeError);
	});
});

describe('epoch days', () => {
	it('round-trips ISO dates', () => {
		for (const d of ['1972-01-01', '2000-02-29', '2031-12-31']) {
			expect(fromEpochDay(toEpochDay(d))).toBe(d);
		}
		expect(toEpochDay('1970-01-02')).toBe(1);
		expect(monthOfEpochDay(toEpochDay('2002-04-24'))).toBe(4);
	});
});

describe('monthOfEpochDay and waterYearOf', () => {
	// Both use integer arithmetic for an integer day instead of a Date (a run
	// calls them per day in many loops); the answer must be Date's, every day.
	const viaDate = (day: number) => {
		const d = new Date(day * 86_400_000);
		const m = d.getUTCMonth() + 1;
		return { m, wy: m >= 10 ? d.getUTCFullYear() : d.getUTCFullYear() - 1 };
	};
	it("agree with Date on every day from 1600 to 2400, and on sampled days across Date's whole range", () => {
		const days: number[] = [];
		for (let day = toEpochDay('1600-01-01'); day <= toEpochDay('2400-12-31'); day++) days.push(day);
		for (let k = -1000; k <= 1000; k++) days.push(Math.round(k * 99_999.7), 100_000_000 - k * k, -100_000_000 + k * k);
		let bad = 0;
		for (const day of days) {
			const want = viaDate(day);
			if (monthOfEpochDay(day) !== want.m || waterYearOf(day) !== want.wy) bad++;
		}
		expect(bad).toBe(0);
	});
	it('answer as Date does for a fraction, NaN or a day beyond its range', () => {
		for (const day of [0.5, -0.5, -1e-12, 12_345.999, NaN, Infinity, 1e8 + 1, -1e8 - 1]) {
			expect(monthOfEpochDay(day)).toEqual(viaDate(day).m);
			expect(waterYearOf(day)).toEqual(viaDate(day).wy);
		}
	});
	it('label October to September by the year it starts in', () => {
		expect(waterYearOf(toEpochDay('2016-09-30'))).toBe(2015);
		expect(waterYearOf(toEpochDay('2016-10-01'))).toBe(2016);
		expect(waterYearOf(toEpochDay('2017-02-28'))).toBe(2016);
		expect(waterYearOf(toEpochDay('1969-12-31'))).toBe(1969);
		expect(monthOfEpochDay(toEpochDay('2000-02-29'))).toBe(2);
		expect(monthOfEpochDay(toEpochDay('1900-03-01'))).toBe(3);
	});
});

describe('dayText (engine 1.99.0, issue #586)', () => {
	it('writes a calendar day day first, as the app does, with no leading zero', () => {
		expect(dayText('2020-10-06')).toBe('6 Oct 2020');
		expect(dayText('2021-01-31')).toBe('31 Jan 2021');
		expect(dayText('1999-12-01')).toBe('1 Dec 1999');
	});

	it('returns anything that isn’t a calendar day unchanged', () => {
		for (const s of ['', '2020-13-01', '2020-10', '2020-10-06T00:00:00Z', 'WY 2020/21']) expect(dayText(s)).toBe(s);
	});

	it('checks the day against its month, leap years by the Gregorian rule', () => {
		expect(dayText('2020-02-29')).toBe('29 Feb 2020');
		expect(dayText('2000-02-29')).toBe('29 Feb 2000');
		expect(dayText('1899-03-01')).toBe('1 Mar 1899');
		for (const s of ['2021-02-29', '1900-02-29', '2020-01-00', '2020-01-32', '2020-04-31']) expect(dayText(s)).toBe(s);
	});
});

describe('daysInText (engine 1.100.0, issue #586 R4-O)', () => {
	it('writes every calendar day in a text day first', () => {
		expect(daysInText('2 days (2020-01-08 to 2020-01-09) of this run use forecast rain')).toBe('2 days (8 Jan 2020 to 9 Jan 2020) of this run use forecast rain');
		expect(daysInText('1 day (2020-02-29)')).toBe('1 day (29 Feb 2020)');
	});

	it('leaves the rest of the text, and what isn’t a calendar day, as it is', () => {
		for (const s of ['no date here', '2021-02-29 to 2020-13-01', 'WY 2020/21', 'run 12020-01-0899', 'already 6 Oct 2020']) expect(daysInText(s)).toBe(s);
	});
});
