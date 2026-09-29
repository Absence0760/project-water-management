import { afterEach, describe, expect, it } from 'vitest';
import { dataFreshness, daysSince, projectToday } from './freshness';

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
	// The project's calendar date (ProjectSummary.today), not the viewer's.
	const today = '2026-09-23';
	it('says the rain’s last day and its age, and flags missing and stale data', () => {
		expect(dataFreshness(null, today)).toMatchObject({ label: 'No rain yet', stale: true });
		expect(dataFreshness('2026-09-23', today)).toMatchObject({ label: 'Rain to 23 Sep 2026 (today)', stale: false });
		// A day ahead of the project's day still reads today, never "in the future".
		expect(dataFreshness('2026-09-24', today)).toMatchObject({ label: 'Rain to 24 Sep 2026 (today)', stale: false });
		expect(dataFreshness('2026-09-22', today)).toMatchObject({ label: 'Rain to 22 Sep 2026 (yesterday)', stale: false });
		expect(dataFreshness('2026-09-16', today)).toMatchObject({ label: 'Rain to 16 Sep 2026 (7 days ago)', stale: false });
		expect(dataFreshness('2026-09-11', today)).toMatchObject({
			label: 'Rain to 11 Sep 2026 (12 days ago)',
			stale: true,
			detail: 'Recorded rain (catchment or CHIRPS) runs to 11 Sep 2026'
		});
	});
	it('switches to months and years for old records', () => {
		expect(dataFreshness('2026-06-01', today).label).toBe('Rain to 1 Jun 2026 (3 months ago)');
		expect(dataFreshness('2024-12-31', today).label).toBe('Rain to 31 Dec 2024 (20 months ago)');
		expect(dataFreshness('2021-09-30', today).label).toBe('Rain to 30 Sep 2021 (4 years ago)');
	});

	describe('under a skewed time zone (issue #137)', () => {
		const tz = process.env.TZ;
		afterEach(() => {
			process.env.TZ = tz;
		});
		it('counts to the project’s day whatever the viewer’s zone, as the portfolio’s ages do', () => {
			// Seven days before the project's day is the stale limit's edge: a viewer whose own calendar
			// is a day ahead (UTC+14) or behind (UTC−11) must not tip it either way.
			for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC']) {
				process.env.TZ = zone;
				expect(dataFreshness('2026-09-16', today), zone).toMatchObject({ label: 'Rain to 16 Sep 2026 (7 days ago)', stale: false });
				expect(dataFreshness('2026-09-15', today), zone).toMatchObject({ label: 'Rain to 15 Sep 2026 (8 days ago)', stale: true });
			}
		});
	});
});

describe('projectToday', () => {
	// 23 Sep 2026 10:30 UTC: 00:30 on the 24th at UTC+14, 23:30 on the 22nd at UTC−11.
	const now = new Date(Date.UTC(2026, 8, 23, 10, 30));
	it('is the calendar date in the project’s zone, whatever the viewer’s', () => {
		const tz = process.env.TZ;
		try {
			for (const viewer of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
				process.env.TZ = viewer;
				expect(projectToday('Pacific/Kiritimati', now), viewer).toBe('2026-09-24');
				expect(projectToday('Pacific/Pago_Pago', now), viewer).toBe('2026-09-22');
				expect(projectToday('Africa/Johannesburg', now), viewer).toBe('2026-09-23');
			}
		} finally {
			process.env.TZ = tz;
		}
	});
	it('falls back to the viewer’s date without a zone, or with one the browser doesn’t know', () => {
		const local = new Date(2026, 8, 23, 12);
		expect(projectToday(undefined, local)).toBe('2026-09-23');
		expect(projectToday('Not/AZone', local)).toBe('2026-09-23');
	});
});
