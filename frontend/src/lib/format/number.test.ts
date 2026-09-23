import { describe, expect, it } from 'vitest';
import { fmtDate, fmtNum, fmtPct, parseNum } from './number';

describe('fmtNum', () => {
	it('adds thousands separators and rounds', () => {
		expect(fmtNum(1234567.8)).toBe('1,234,568');
		expect(fmtNum(1234567.8, 2)).toBe('1,234,567.80');
		expect(fmtNum(0.5, 3, true)).toBe('0.5');
	});
	it('handles negatives, -0 and missing values', () => {
		expect(fmtNum(-12345)).toBe('-12,345');
		expect(fmtNum(-0.2)).toBe('0');
		expect(fmtNum(null)).toBe('–');
		expect(fmtNum(NaN)).toBe('–');
		expect(fmtNum(Infinity)).toBe('–');
	});
});

describe('fmtPct', () => {
	it('formats fractions as percentages', () => {
		expect(fmtPct(0.953)).toBe('95.3%');
		expect(fmtPct(1)).toBe('100.0%');
		expect(fmtPct(null)).toBe('–');
	});
});

describe('fmtDate', () => {
	it('keeps plain dates and handles empty input', () => {
		expect(fmtDate('2020-01-05T12:00:00')).toBe('2020-01-05');
		expect(fmtDate(null)).toBe('–');
		expect(fmtDate('garbage')).toBe('garbage');
	});
});

describe('parseNum', () => {
	it('strips separators', () => {
		expect(parseNum('1,234.5')).toBe(1234.5);
		expect(parseNum(' 12 000 ')).toBe(12000);
		expect(parseNum('')).toBeNull();
		expect(parseNum('abc')).toBeNull();
	});
});
