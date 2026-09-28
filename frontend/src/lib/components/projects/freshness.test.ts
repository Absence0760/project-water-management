import { afterEach, describe, expect, it } from 'vitest';
import { dataFreshness, daysSince } from './freshness';

// Local-time constructor: "today" is the viewer's calendar date.
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h);

describe('daysSince', () => {
	it('counts calendar days, not 24-hour periods', () => {
		expect(daysSince('2026-09-23', at(2026, 9, 23, 0))).toBe(0);
		expect(daysSince('2026-09-22', at(2026, 9, 23, 0))).toBe(1);
		expect(daysSince('2026-09-11', at(2026, 9, 23, 23))).toBe(12);
		expect(daysSince('2026-10-01', at(2026, 9, 23))).toBe(-8);
		// Across a year boundary and a leap day.
		expect(daysSince('2023-12-31', at(2024, 3, 1))).toBe(61);
	});

	describe('under a skewed time zone', () => {
		const tz = process.env.TZ;
		afterEach(() => {
			process.env.TZ = tz;
		});
		it('uses the local date late in the evening, not the UTC one', () => {
			process.env.TZ = 'Pacific/Kiritimati'; // UTC+14: the UTC date is still yesterday
			expect(daysSince('2026-09-23', at(2026, 9, 23, 1))).toBe(0);
			process.env.TZ = 'Pacific/Pago_Pago'; // UTC−11: the UTC date is already tomorrow
			expect(daysSince('2026-09-23', at(2026, 9, 23, 23))).toBe(0);
		});
	});
});

describe('dataFreshness', () => {
	const now = at(2026, 9, 23);
	it('flags missing and stale data', () => {
		expect(dataFreshness(null, now)).toMatchObject({ label: 'no rain yet', stale: true });
		expect(dataFreshness('2026-09-23', now)).toMatchObject({ label: 'rain up to date', stale: false });
		expect(dataFreshness('2026-09-30', now)).toMatchObject({ label: 'rain up to date', stale: false });
		expect(dataFreshness('2026-09-22', now)).toMatchObject({ label: 'rain 1 day old', stale: false });
		expect(dataFreshness('2026-09-16', now)).toMatchObject({ label: 'rain 7 days old', stale: false });
		expect(dataFreshness('2026-09-11', now)).toMatchObject({ label: 'rain 12 days old', stale: true, detail: 'Recorded rain runs to 2026-09-11' });
	});
	it('switches to months and years for old records', () => {
		expect(dataFreshness('2026-06-01', now).label).toBe('rain 3 months old');
		expect(dataFreshness('2025-09-30', now).label).toBe('rain 11 months old');
		expect(dataFreshness('2021-09-30', now).label).toBe('rain 4 years old');
	});
});
