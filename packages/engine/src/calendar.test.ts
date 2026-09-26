import { describe, expect, it } from 'vitest';
import { fromEpochDay, monthOfEpochDay, toEpochDay, waterYearIndex, waterYearOf } from './calendar';

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
