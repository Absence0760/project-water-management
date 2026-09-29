import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FARM_VIEW_STALE_DAYS } from '@water-management/engine';
import { ageSpan, agoText, dataEndOf, dateAge, daysBetween, isStale, sharedWindowText, STALE_DAYS, windowText } from './age';
import { localIsoDate } from './number';

// Under a skewed zone and a fixed clock (CLAUDE.md rule 7): the ages are
// calendar-day arithmetic on YYYY-MM-DD strings, so neither the zone nor the
// hour may move them.
const ZONES = ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Africa/Johannesburg'];

describe.each(ZONES)('the age module under TZ=%s', (zone) => {
	const tz = process.env.TZ;
	beforeEach(() => {
		process.env.TZ = zone;
		vi.useFakeTimers();
		// 23:30 UTC on 28 Sep 2026: already the 29th in Kiritimati (UTC+14), still the 28th in Pago Pago (UTC−11).
		vi.setSystemTime(new Date('2026-09-28T23:30:00Z'));
	});
	afterEach(() => {
		vi.useRealTimers();
		process.env.TZ = tz;
	});

	it('counts whole calendar days between two days, whatever the zone', () => {
		expect(daysBetween('2024-12-31', '2026-09-28')).toBe(636);
		expect(daysBetween('2026-09-28', '2026-09-28')).toBe(0);
		expect(daysBetween('2026-09-29', '2026-09-28')).toBe(-1);
		// Across a leap day.
		expect(daysBetween('2023-12-31', '2024-03-01')).toBe(61);
		// A timestamp's calendar part is the day.
		expect(daysBetween('2026-09-27T23:59:00Z', '2026-09-28')).toBe(1);
	});

	it('ages a data day against the viewer’s own calendar day', () => {
		const today = localIsoDate();
		expect(today).toBe(zone === 'Pacific/Kiritimati' ? '2026-09-29' : zone === 'Pacific/Pago_Pago' ? '2026-09-28' : '2026-09-29');
		expect(dataEndOf('2024-12-31', today)).toEqual({ end: '2024-12-31', age: daysBetween('2024-12-31', today) });
		expect(dataEndOf(null, today)).toBeNull();
	});

	it('says an age in words: days, then months, then years', () => {
		expect(agoText(0)).toBe('today');
		expect(agoText(1)).toBe('yesterday');
		expect(agoText(12)).toBe('12 days ago');
		expect(agoText(59)).toBe('59 days ago');
		// Never "1 months": 60 days is under two 30.44-day months.
		expect(agoText(60)).toBe('2 months ago');
		expect(agoText(637)).toBe('20 months ago');
		expect(agoText(729)).toBe('23 months ago');
		expect(agoText(730)).toBe('2 years ago');
		expect(agoText(1100)).toBe('3 years ago');
		expect(agoText(-3)).toBe('in the future');
		expect(ageSpan(637)).toEqual({ unit: 'month', n: 20 });
	});

	it('gives a data date and its age one way: "31 Dec 2024 (20 months ago)"', () => {
		expect(dateAge('2024-12-31', 637)).toBe('31 Dec 2024 (20 months ago)');
		expect(dateAge('2026-09-28', 0)).toBe('28 Sep 2026 (today)');
		expect(dateAge('2026-09-27', 1)).toBe('27 Sep 2026 (yesterday)');
	});

	it('is stale past the one threshold, the engine’s', () => {
		expect(STALE_DAYS).toBe(FARM_VIEW_STALE_DAYS);
		expect(isStale(STALE_DAYS)).toBe(false);
		expect(isStale(STALE_DAYS + 1)).toBe(true);
		expect(isStale(0)).toBe(false);
	});

	it('words a window by its last day: relative while current, dated once stale', () => {
		const recent = { end: '2026-09-25', age: 3 };
		const edge = { end: '2026-09-21', age: STALE_DAYS };
		const stale = { end: '2024-12-31', age: 637 };
		expect(windowText(recent, 'this week', 'in the week to {date}')).toBe('this week');
		expect(windowText(edge, 'this week', 'in the week to {date}')).toBe('this week');
		expect(windowText(stale, 'this week', 'in the week to {date}')).toBe('in the week to 31 Dec 2024');
		expect(windowText(stale, 'Dams today', 'Dams on {date}')).toBe('Dams on 31 Dec 2024');
		expect(windowText(stale, 'EWR, last 30 days', 'EWR, 30 days to {date}')).toBe('EWR, 30 days to 31 Dec 2024');
		// No data: nothing to date, so the plain words.
		expect(windowText(null, 'this week', 'in the week to {date}')).toBe('this week');
	});

	it('labels several catchments’ windows once: relative, their shared date, or neutral when they differ', () => {
		const words = ['EWR, last 30 days', 'EWR, 30 days to {date}', 'EWR, last 30 days of figures'] as const;
		const a = { end: '2024-12-31', age: 637 };
		const b = { end: '2026-09-27', age: 1 };
		expect(sharedWindowText([b, null], ...words)).toBe('EWR, last 30 days');
		expect(sharedWindowText([], ...words)).toBe('EWR, last 30 days');
		expect(sharedWindowText([a, { ...a }, null], ...words)).toBe('EWR, 30 days to 31 Dec 2024');
		expect(sharedWindowText([a, b], ...words)).toBe('EWR, last 30 days of figures');
		expect(sharedWindowText([a, { end: '2025-01-31', age: 606 }], ...words)).toBe('EWR, last 30 days of figures');
	});
});
