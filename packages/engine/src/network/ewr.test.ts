import { describe, expect, it } from 'vitest';
import { ewrCompliance } from './ewr';

// 2020-09-29 … 2020-10-03: two September days (water year 2019, column 11)
// and three October days (water year 2020, column 0).
const start = '2020-09-29';
const outlet = { nodeId: null, name: 'Gauge', shortfallM3Day: [0, -5, -3, 0, 0] };
const farm = { nodeId: 'f1', name: 'Farm 1', shortfallM3Day: [-2, 0, 0, -1, -1] };

describe('ewrCompliance', () => {
	const g = ewrCompliance(start, 5, outlet, [farm]);

	it('lays out water-year rows × Oct…Sep columns with the days simulated', () => {
		expect(g.waterYears).toEqual([2019, 2020]);
		expect(g.days).toHaveLength(2);
		expect(g.days[0]![11]).toBe(2);
		expect(g.days[1]![0]).toBe(3);
		expect(g.days.flat().reduce((a, b) => a + b)).toBe(5);
	});

	it('counts a day as not met when that day is short, and sums the shortfall volume', () => {
		expect(g.outlet.name).toBe('Gauge');
		expect(g.outlet.nodeId).toBeNull();
		expect(g.outlet.daysNotMet[0]![11]).toBe(1);
		expect(g.outlet.shortfallM3[0]![11]).toBe(5);
		expect(g.outlet.daysNotMet[1]![0]).toBe(1);
		expect(g.outlet.shortfallM3[1]![0]).toBe(3);
		expect(g.outlet.daysNotMet.flat().reduce((a, b) => a + b)).toBe(2);
	});

	it('grids every farm the same way', () => {
		expect(g.farms).toHaveLength(1);
		const f = g.farms[0]!;
		expect(f.nodeId).toBe('f1');
		expect(f.daysNotMet[0]![11]).toBe(1);
		expect(f.shortfallM3[0]![11]).toBe(2);
		expect(f.daysNotMet[1]![0]).toBe(2);
		expect(f.shortfallM3[1]![0]).toBe(2);
	});

	it('reproduces the workbook pivot running-total count on request', () => {
		const w = ewrCompliance(start, 5, outlet, [farm], 'runningTotal');
		// Sep: running sum 0, −5 → 1 day. Oct: −3, −3, −3 → all 3 days count.
		expect(w.outlet.daysNotMet[0]![11]).toBe(1);
		expect(w.outlet.daysNotMet[1]![0]).toBe(3);
		// Farm Sep: −2, −2 → 2 days (the second day was met). Volumes are unchanged.
		expect(w.farms[0]!.daysNotMet[0]![11]).toBe(2);
		expect(w.farms[0]!.shortfallM3).toEqual(g.farms[0]!.shortfallM3);
	});

	it('resets the running total at each month even within a water year', () => {
		const w = ewrCompliance('2021-01-31', 2, { nodeId: null, name: 'G', shortfallM3Day: [-1, 0] }, [], 'runningTotal');
		expect(w.waterYears).toEqual([2020]);
		expect(w.outlet.daysNotMet[0]![3]).toBe(1); // Jan
		expect(w.outlet.daysNotMet[0]![4]).toBe(0); // Feb
	});

	it('ignores positive or non-finite values and handles an empty run', () => {
		const w = ewrCompliance(start, 2, { nodeId: null, name: 'G', shortfallM3Day: [4, NaN] }, []);
		expect(w.outlet.daysNotMet.flat().every((v) => v === 0)).toBe(true);
		expect(w.outlet.shortfallM3.flat().every((v) => v === 0)).toBe(true);
		const e = ewrCompliance(start, 0, outlet, [farm]);
		expect(e.waterYears).toEqual([]);
		expect(e.farms[0]!.daysNotMet).toEqual([]);
	});
});
