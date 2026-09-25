import { afterEach, describe, expect, it } from 'vitest';
import { fmtDate, fmtDay, fmtNum, fmtPct, fmtReading, localIsoDate, parseNum } from './number';

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

describe('fmtReading', () => {
	it('gives a day’s reading the decimals its size needs', () => {
		expect([1234.4, 100, 12.345, 1, 0.0123, 0.01, 0.00012, -250.6].map(fmtReading)).toEqual(['1,234', '100', '12.35', '1.00', '0.012', '0.010', '0.0001', '-251']);
		expect([null, undefined, NaN].map(fmtReading)).toEqual(['–', '–', '–']);
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

	it('reads a single non-grouping comma as a decimal comma, never as a lost separator', () => {
		expect(parseNum('1,5')).toBe(1.5);
		expect(parseNum('2,75')).toBe(2.75);
		expect(parseNum('-0,25')).toBe(-0.25);
		expect(parseNum(',5')).toBe(0.5);
		expect(parseNum('12 000,5')).toBe(12000.5);
		expect(parseNum('1234,5678')).toBe(1234.5678);
	});

	it('keeps valid comma groupings as thousands separators, as the app displays them', () => {
		expect(parseNum('1,500')).toBe(1500);
		expect(parseNum('300,000')).toBe(300000);
		expect(parseNum('1,234,567.8')).toBe(1234567.8);
		expect(parseNum('-1,000')).toBe(-1000);
	});

	it('rejects ambiguous comma use instead of guessing', () => {
		expect(parseNum('1,2,3')).toBeNull();
		expect(parseNum('1,5.2')).toBeNull();
		expect(parseNum('12,34,567')).toBeNull();
		expect(parseNum('1,')).toBeNull();
	});
});

describe('localIsoDate', () => {
	const tz = process.env.TZ;
	afterEach(() => {
		process.env.TZ = tz;
	});
	it('is the local calendar date, not the UTC one', () => {
		process.env.TZ = 'Pacific/Kiritimati'; // UTC+14: early morning locally, still yesterday in UTC
		const early = new Date(2026, 8, 23, 1);
		expect(early.toISOString().slice(0, 10)).toBe('2026-09-22');
		expect(localIsoDate(early)).toBe('2026-09-23');
		process.env.TZ = 'Pacific/Pago_Pago'; // UTC−11: late evening locally, already tomorrow in UTC
		const late = new Date(2026, 8, 23, 23);
		expect(late.toISOString().slice(0, 10)).toBe('2026-09-24');
		expect(localIsoDate(late)).toBe('2026-09-23');
	});
});

describe('fmtDay', () => {
	const tz = process.env.TZ;
	afterEach(() => {
		process.env.TZ = tz;
	});
	it('spells a calendar day out without a leading zero', () => {
		expect(fmtDay('2021-10-01')).toBe('1 Oct 2021');
		expect(fmtDay('2024-02-29')).toBe('29 Feb 2024');
		expect(fmtDay('not a date')).toBe('not a date');
		expect(fmtDay('2021-13-01')).toBe('2021-13-01');
	});
	it('never shifts the day, whatever the time zone', () => {
		for (const zone of ['Pacific/Pago_Pago', 'Pacific/Kiritimati']) {
			process.env.TZ = zone;
			expect(fmtDay('2021-10-01')).toBe('1 Oct 2021');
		}
	});
});
