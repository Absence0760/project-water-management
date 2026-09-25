import { describe, expect, it } from 'vitest';
import { fromEpochDay, monthOfEpochDay, toEpochDay, waterYearIndex } from './calendar';

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
