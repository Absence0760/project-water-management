import { afterEach, describe, expect, it } from 'vitest';
import { dayPrefix, fmtDate, fmtDay, fmtNum, fmtPct, fmtQty, fmtReading, fmtStamp, fmtWhen, localIsoDate, parseDay, parseNum, tidyDay, zonedIsoDate } from './number';

describe('fmtNum', () => {
	it('adds thousands separators and rounds', () => {
		expect(fmtNum(1234567.8)).toBe('1\u202f234\u202f568');
		expect(fmtNum(1234567.8, 2)).toBe('1\u202f234\u202f567.80');
		expect(fmtNum(0.5, 3, true)).toBe('0.5');
	});
	it('handles negatives (a true minus, U+2212), -0 and missing values', () => {
		expect(fmtNum(-12345)).toBe('\u221212\u202f345');
		expect(fmtNum(-2.26, 2)).toBe('\u22122.26');
		expect(fmtNum(-0.2)).toBe('0');
		// A value that rounds to zero at any precision loses its sign.
		expect(fmtNum(-0.001, 2)).toBe('0.00');
		expect(fmtNum(-0.04, 1, true)).toBe('0');
		expect(fmtNum(null)).toBe('–');
		expect(fmtNum(NaN)).toBe('–');
		expect(fmtNum(Infinity)).toBe('–');
	});
});

describe('fmtQty', () => {
	it('shows a small non-zero flow to two significant figures instead of 0.000 (issue #45)', () => {
		expect(fmtQty(0.00042, 3)).toBe('0.00042');
		expect(fmtQty(0.0042, 3, true)).toBe('0.0042');
		expect(fmtQty(0.004, 3)).toBe('0.004');
		expect(fmtQty(0.4, 0)).toBe('0.4');
		expect(fmtQty(0.04, 1, true)).toBe('0.04');
		expect(fmtQty(0.12, 1)).toBe('0.12');
	});
	it('keeps zero as 0 and negatives signed', () => {
		expect(fmtQty(0, 3)).toBe('0.000');
		expect(fmtQty(0, 3, true)).toBe('0');
		expect(fmtQty(-0, 3, true)).toBe('0');
		expect(fmtQty(-0.00042, 3)).toBe('\u22120.00042');
		expect(fmtQty(-1234.5678, 3)).toBe('\u22121\u202f234.568');
	});
	it('is exactly fmtNum once the fixed decimals already show enough figures', () => {
		for (const [v, d] of [[0.0123, 3], [0.5, 3], [1, 3], [12.345, 2], [1234567.8, 0], [5.3, 0], [0.25, 2], [1.2, 1]] as const) {
			expect(fmtQty(v, d)).toBe(fmtNum(v, d));
			expect(fmtQty(v, d, true)).toBe(fmtNum(v, d, true));
		}
	});
	it('writes float noise in exponent form and missing values as a dash', () => {
		expect(fmtQty(2.3e-9, 3)).toBe('2.3e-9');
		expect(fmtQty(-2e-9, 3)).toBe('\u22122e-9');
		expect([null, undefined, NaN, Infinity].map((v) => fmtQty(v, 3))).toEqual(['–', '–', '–', '–']);
	});
});

describe('fmtReading', () => {
	it('gives a day’s reading the decimals its size needs', () => {
		expect([1234.4, 100, 12.345, 1, 0.0123, 0.01, 0.00012, -250.6].map(fmtReading)).toEqual(['1\u202f234', '100', '12.35', '1.00', '0.012', '0.010', '0.0001', '\u2212251']);
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

	it('reads back what the app shows, and a no-break space typed or pasted (D10, issue #76)', () => {
		for (const n of [1234567.8, -1000, -2.26, 300000, 0.5]) expect(parseNum(fmtNum(n, 2, true))).toBe(n);
		expect(fmtNum(300000)).toBe('300\u202f000');
		expect(parseNum('1\u00a0500')).toBe(1500);
		expect(parseNum('12\u202f345,5')).toBe(12345.5);
	});

	it('keeps valid comma groupings as thousands separators, as pasted from a spreadsheet', () => {
		expect(parseNum('1,500')).toBe(1500);
		expect(parseNum('300,000')).toBe(300000);
		expect(parseNum('1,234,567.8')).toBe(1234567.8);
		expect(parseNum('-1,000')).toBe(-1000);
		// The true minus the app displays, and what a report or a word processor pastes.
		expect(parseNum('\u22121,000')).toBe(-1000);
		expect(parseNum('\u22120,25')).toBe(-0.25);
		expect(parseNum('\u2212 2.5')).toBe(-2.5);
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

describe('fmtStamp and fmtWhen: a moment, day first, in the viewer’s zone', () => {
	const tz = process.env.TZ;
	afterEach(() => {
		process.env.TZ = tz;
	});
	it('fmtStamp writes the local day and time', () => {
		process.env.TZ = 'Africa/Johannesburg'; // UTC+2: 22:30 UTC is 00:30 the next day
		expect(fmtStamp('2026-10-10T22:30:00Z')).toBe('11 Oct 2026 00:30');
		process.env.TZ = 'Pacific/Pago_Pago'; // UTC−11
		expect(fmtStamp('2026-10-10T08:05:00Z')).toBe('9 Oct 2026 21:05');
		expect(fmtStamp('not a time')).toBe('not a time');
	});
	it('fmtWhen says today or yesterday on the viewer’s calendar, else the day', () => {
		process.env.TZ = 'Africa/Johannesburg';
		const now = new Date('2026-10-10T23:00:00Z'); // 11 Oct 01:00 there
		expect(fmtWhen('2026-10-10T22:30:00Z', now)).toBe('today 00:30');
		expect(fmtWhen('2026-10-10T08:05:00Z', now)).toBe('yesterday 10:05');
		expect(fmtWhen('2026-09-03T12:05:00Z', now)).toBe('3 Sep 2026 14:05');
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

describe('zonedIsoDate', () => {
	const tz = process.env.TZ;
	afterEach(() => {
		process.env.TZ = tz;
	});
	it('is the date in the zone asked for, whatever the device’s zone', () => {
		process.env.TZ = 'Pacific/Pago_Pago'; // UTC−11: the 5th on the device
		const now = new Date('2024-01-05T23:30:00Z');
		expect(localIsoDate(now)).toBe('2024-01-05');
		expect(zonedIsoDate(now, 'Africa/Johannesburg')).toBe('2024-01-06');
		expect(zonedIsoDate(now, 'UTC')).toBe('2024-01-05');
		expect(() => zonedIsoDate(now, 'Not/AZone')).toThrow(RangeError);
	});
});

describe('tidyDay', () => {
	it('shows a day it reads day first, and leaves anything else as typed', () => {
		expect(tidyDay('2021-11-15')).toBe('15 Nov 2021');
		expect(tidyDay(' 15/11/2021 ')).toBe('15 Nov 2021');
		expect(tidyDay('11/15/2021')).toBe('11/15/2021');
		expect(tidyDay('')).toBe('');
	});
});

describe('parseDay', () => {
	it('reads a day typed day first, as fmtDay shows it, or year first', () => {
		for (const typed of ['15 Nov 2021', '15 nov 2021', '15 November 2021', ' 15  Nov.  2021 ', '15 Nov, 2021', '15/11/2021', '15-11-2021', '15.11.2021', '2021-11-15', '2021/11/15']) {
			expect(parseDay(typed), typed).toBe('2021-11-15');
		}
		expect(parseDay('1 Sept 2021')).toBe('2021-09-01');
		expect(parseDay('5/3/2021')).toBe('2021-03-05');
		// Round trip with fmtDay.
		expect(parseDay(fmtDay('2024-02-29'))).toBe('2024-02-29');
	});

	it('never reads a day month first, and refuses days that don’t exist', () => {
		for (const typed of ['11/15/2021', '31 Nov 2021', '29 Feb 2023', '2021-13-01', '0 Jan 2021', '15 Novv 2021', '15 Nob 2021', '15 Nov', 'Nov 15 2021', '', 'yesterday', '2021-11-15T00:00']) {
			expect(parseDay(typed), typed).toBeNull();
		}
		expect(parseDay('29 Feb 2024')).toBe('2024-02-29');
		expect(parseDay('29 Feb 2000')).toBe('2000-02-29');
		expect(parseDay('29 Feb 1900')).toBeNull();
	});
});

// A date search over a table shown day first (the Data page's previews, issue #521): read from the string, so
// no time zone can move a day. Run under a far-off TZ to prove it.
describe('dayPrefix', () => {
	const tz = process.env.TZ;
	afterEach(() => {
		process.env.TZ = tz;
	});
	it('reads a day, a month or a year, day first or year first, as an ISO prefix', () => {
		process.env.TZ = 'Pacific/Kiritimati';
		for (const typed of ['15 Nov 2021', '15/11/2021', '2021-11-15', ' 15  nov 2021 ']) expect(dayPrefix(typed), typed).toBe('2021-11-15');
		for (const typed of ['Nov 2021', 'november 2021', 'Nov. 2021', '11/2021', '11-2021', '2021-11', '2021/11', '2021-11 ']) expect(dayPrefix(typed), typed).toBe('2021-11');
		expect(dayPrefix('3/2015')).toBe('2015-03');
		expect(dayPrefix('Sept 2021')).toBe('2021-09');
		expect(dayPrefix('2015')).toBe('2015');
	});
	it('leaves anything else as typed, so a partly typed ISO prefix still narrows', () => {
		process.env.TZ = 'Pacific/Pago_Pago';
		for (const typed of ['2021-1', '20', '13/2021', '2021-13', 'Novv 2021', 'yesterday', '']) expect(dayPrefix(typed), typed).toBe(typed);
		expect(dayPrefix('  2021-1 ')).toBe('2021-1');
		// Never month first.
		expect(dayPrefix('11/15/2021')).toBe('11/15/2021');
	});
});
