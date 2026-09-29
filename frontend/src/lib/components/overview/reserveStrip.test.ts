import { describe, expect, it } from 'vitest';
import type { EwrCompliance } from '@water-management/engine';
import { monthText, recentMonths, stripSpan } from './reserveStrip';

const MONTH_DAYS = [31, 30, 31, 31, 28, 31, 30, 31, 30, 31, 31, 30]; // Oct … Sep

/** Water years from `first`, each month's days not met from `notMet(row, col)`; `simulated` picks the months the run covers. */
function grid(first: number, years: number, notMet: (r: number, m: number) => number, simulated = (_r: number, _m: number) => true): EwrCompliance {
	const rows = Array.from({ length: years }, (_, r) => r);
	const days = rows.map((r) => MONTH_DAYS.map((d, m) => (simulated(r, m) ? d : 0)));
	return {
		waterYears: rows.map((r) => first + r),
		days,
		outlet: { nodeId: null, name: 'Outlet', daysNotMet: rows.map((r) => MONTH_DAYS.map((_, m) => (days[r]![m]! ? notMet(r, m) : 0))), shortfallM3: rows.map(() => Array(12).fill(0)) },
		farms: []
	} as unknown as EwrCompliance;
}

describe('recentMonths', () => {
	it('is the run’s last twelve months, oldest first, with each one’s days below the EWR', () => {
		// Water years 2021/22 … 2023/24: the run ends 30 Sep 2024.
		const ms = recentMonths(grid(2021, 3, (r, m) => r + m));
		expect(ms).toHaveLength(12);
		expect(ms[0]).toEqual({ year: 2023, month: 10, label: 'Oct', days: 31, notMet: 2, fraction: 2 / 31 });
		expect(ms[3]).toMatchObject({ year: 2024, month: 1, label: 'Jan', notMet: 5 });
		expect(ms[11]).toMatchObject({ year: 2024, month: 9, label: 'Sep', days: 30, notMet: 13 });
		expect(stripSpan(ms)).toBe('Oct 2023 – Sep 2024');
	});

	it('skips the months outside the run, so a run ending mid-year ends on its last month', () => {
		// 2023/24 runs Oct–Dec only (the run ends 31 Dec 2023).
		const ms = recentMonths(grid(2022, 2, () => 1, (r, m) => r === 0 || m < 3));
		expect(ms).toHaveLength(12);
		expect(stripSpan(ms)).toBe('Jan 2023 – Dec 2023');
	});

	it('shows every month of a run shorter than a year', () => {
		const ms = recentMonths(grid(2021, 1, () => 0, (_r, m) => m < 4));
		expect(ms.map((x) => x.label)).toEqual(['Oct', 'Nov', 'Dec', 'Jan']);
		expect(ms.map((x) => x.year)).toEqual([2021, 2021, 2021, 2022]);
	});

	it('stops before the month a forecast starts in: the Summary’s figures are the history’s', () => {
		const c = grid(2023, 1, () => 2);
		expect(stripSpan(recentMonths(c, '2024-03-15'))).toBe('Oct 2023 – Feb 2024');
		expect(stripSpan(recentMonths(c, '2024-03-01'))).toBe('Oct 2023 – Feb 2024');
		expect(recentMonths(c, '2023-10-01')).toEqual([]);
	});

	it('is empty for a grid with no simulated day', () => {
		expect(recentMonths(grid(2021, 1, () => 0, () => false))).toEqual([]);
		expect(stripSpan([])).toBe('');
	});
});

describe('monthText', () => {
	it('says the month, its year and the count in words', () => {
		const [jan] = recentMonths(grid(2023, 1, (_r, m) => (m === 3 ? 12 : 0), (_r, m) => m === 3));
		expect(monthText(jan!)).toBe('Jan 2024: below the EWR on 12 of 31 days');
		const [oct] = recentMonths(grid(2023, 1, () => 0, (_r, m) => m === 0));
		expect(monthText(oct!)).toBe('Oct 2023: EWR met every day (31 days)');
	});
});
