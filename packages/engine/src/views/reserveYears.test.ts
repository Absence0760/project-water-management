import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import { runModel } from '../run';
import { randomInput } from '../testing/fuzz';
import { reserveDaysByWaterYear } from './reserveYears';

describe('reserveDaysByWaterYear', () => {
	it('counts shortfall days per October–September water year, part years flagged', () => {
		// 2020-09-29 … 2021-10-02: two days of WY 2019, all of WY 2020 (365 days), two of WY 2021.
		const start = '2020-09-29';
		const n = toEpochDay('2021-10-03') - toEpochDay(start);
		const values = Array.from({ length: n }, (_, t) => (t % 10 === 0 ? -5 : 0));
		const years = reserveDaysByWaterYear(start, values);
		expect(years.map((y) => [y.waterYear, y.days, y.complete])).toEqual([
			[2019, 2, false],
			[2020, 365, true],
			[2021, 2, false]
		]);
		expect(years.reduce((s, y) => s + y.below, 0)).toBe(values.filter((v) => v < 0).length);
		expect(years[0]!.below).toBe(1); // t = 0
	});

	it('treats a leap water year as 366 days and a missing day as missing, not met', () => {
		const start = '2023-10-01';
		const n = toEpochDay('2024-10-01') - toEpochDay(start);
		expect(n).toBe(366);
		const values: (number | null)[] = Array.from({ length: n }, () => 0);
		values[3] = null;
		values[4] = Number.NaN;
		values[5] = -0.1;
		const [y] = reserveDaysByWaterYear(start, values);
		expect(y).toEqual({ waterYear: 2023, days: 366, below: 1, missing: 2, complete: true });
	});

	it("adds up to the run summary's EWR days not met", () => {
		for (const seed of [3, 17, 41]) {
			const run = runModel(randomInput(seed, { maxDays: 2000, maxNodes: 5 }));
			const s = run.series.find((x) => x.nodeId === null && x.key === 'ewr_shortfall')!;
			const years = reserveDaysByWaterYear(run.startDate, s.values);
			expect(years.reduce((n, y) => n + y.below, 0)).toBe(run.summary.catchment.ewrDaysNotMet);
			expect(years.reduce((n, y) => n + y.days, 0)).toBe(s.values.length);
		}
	});

	it('an empty series has no years', () => {
		expect(reserveDaysByWaterYear('2020-01-01', [])).toEqual([]);
	});
});
