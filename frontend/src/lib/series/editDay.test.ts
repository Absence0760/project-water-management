import { describe, expect, it } from 'vitest';
import { handDayCount, handPoints, handRangesText, isHandDay, lastDay, readTypedValue, valueOn } from './editDay';

const s = { startDate: '2021-10-01', values: [1.2, null, 0.6, 0.4] };

describe('the day edit', () => {
	it('reads the stored value of a day, a gap as null, and nothing outside the series', () => {
		expect(valueOn(s, '2021-10-01')).toBe(1.2);
		expect(valueOn(s, '2021-10-02')).toBeNull();
		expect(valueOn(s, '2021-10-04')).toBe(0.4);
		expect(valueOn(s, '2021-09-30')).toBeUndefined();
		expect(valueOn(s, '2021-10-05')).toBeUndefined();
		expect(valueOn(s, '')).toBeUndefined();
		expect(lastDay({ startDate: '2021-10-01', length: 4 })).toBe('2021-10-04');
	});

	it('reads a typed value with a decimal point or comma; blank clears; a negative or text is refused', () => {
		expect(readTypedValue('12.5')).toEqual({ ok: true, value: 12.5 });
		expect(readTypedValue(' 12,5 ')).toEqual({ ok: true, value: 12.5 });
		expect(readTypedValue('0')).toEqual({ ok: true, value: 0 });
		expect(readTypedValue('')).toEqual({ ok: true, value: null });
		expect(readTypedValue('   ')).toEqual({ ok: true, value: null });
		expect(readTypedValue('-1')).toMatchObject({ ok: false, error: expect.stringMatching(/below zero/) });
		expect(readTypedValue('abc')).toMatchObject({ ok: false, error: expect.stringMatching(/Type a number/) });
		expect(readTypedValue('1,2,3')).toMatchObject({ ok: false });
	});

	it('tells the hand-edited days, counts them and says them', () => {
		const ranges: [string, string][] = [
			['2021-10-02', '2021-10-02'],
			['2021-10-04', '2021-10-06']
		];
		expect(isHandDay(ranges, '2021-10-02')).toBe(true);
		expect(isHandDay(ranges, '2021-10-03')).toBe(false);
		expect(isHandDay(ranges, '2021-10-05')).toBe(true);
		expect(isHandDay(null, '2021-10-05')).toBe(false);
		expect(handDayCount(ranges)).toBe(4);
		expect(handDayCount(null)).toBe(0);
		expect(handRangesText(ranges)).toBe('2021-10-02, 2021-10-04 to 2021-10-06');
	});

	it('draws the hand-edited days that hold a value as points, clipped to the series', () => {
		expect(handPoints(s, [['2021-10-02', '2021-10-03']])).toEqual({ startDate: '2021-10-01', values: [null, null, 0.6, null] });
		expect(handPoints(s, [['2021-09-01', '2021-10-01']])).toEqual({ startDate: '2021-10-01', values: [1.2, null, null, null] });
		// Only a cleared day: nothing to draw.
		expect(handPoints(s, [['2021-10-02', '2021-10-02']])).toBeNull();
		expect(handPoints(s, null)).toBeNull();
	});
});
