// get_series's downsampling (issue #610): monthly and water-year means, a
// capped window of days, missing days, and an answer that stays small.
import { describe, expect, it } from 'vitest';
import { downsample, MAX_DAYS, MAX_MONTHS, seriesTool } from './series.js';
import type { ToolContext } from '../types.js';

describe('downsample', () => {
	// 2021-01-01 … 2021-03-31: January all 1, February 2 with one missing day, March 3.
	const values = [...Array(31).fill(1), ...Array(27).fill(2), Number.NaN, ...Array(31).fill(3)];

	it('monthly means skip missing days, and count them', () => {
		expect(downsample('2021-01-01', values, 'monthly')).toEqual({
			from: '2021-01-01',
			to: '2021-03-31',
			mean: expect.closeTo((31 + 54 + 93) / 89, 3),
			min: 1,
			max: 3,
			missingDays: 1,
			points: [
				['2021-01', 1],
				['2021-02', 2],
				['2021-03', 3]
			]
		});
	});

	it('water-year means group October to September', () => {
		const v = Array.from({ length: 365 + 31 }, (_, i) => (i < 273 ? 1 : 5)); // 2021-01-01 + 272 days = 2021-09-30
		expect(downsample('2021-01-01', v, 'water_year').points).toEqual([
			['2020/21', 1],
			['2021/22', 5]
		]);
	});

	it('a window of days, cut at the cap with a note saying where to go on', () => {
		const long = Array.from({ length: 400 }, (_, i) => i);
		const w = downsample('2021-01-01', long, 'daily', '2021-01-10', '2021-12-31');
		expect(w.points).toHaveLength(MAX_DAYS);
		expect(w.points[0]).toEqual(['2021-01-10', 9]);
		expect(w.note).toMatch(/ask again from 2021-04-12/);
		// No window: the run's last days.
		const tail = downsample('2021-01-01', long, 'daily');
		expect(tail.points.at(-1)).toEqual(['2022-02-04', 399]);
		expect(tail.points).toHaveLength(MAX_DAYS);
		expect(downsample('2021-01-01', [1, Number.NaN, null], 'daily').points).toEqual([
			['2021-01-01', 1],
			['2021-01-02', null],
			['2021-01-03', null]
		]);
	});

	it('keeps the latest months of a long run, and stays small', () => {
		const forty = Array.from({ length: 40 * 365 }, (_, i) => 1000 + Math.sin(i / 30) * 999.123456);
		const m = downsample('1980-10-01', forty, 'monthly');
		expect(m.points).toHaveLength(MAX_MONTHS);
		expect(m.note).toMatch(/latest 120/);
		expect(JSON.stringify(m).length).toBeLessThan(4_000);
	});

	it('a window outside the run says so', () => {
		expect(downsample('2021-01-01', [1, 2], 'monthly', '2030-01-01').points).toEqual([]);
	});
});

describe('get_series arguments', () => {
	const ctx = { db: { query: () => Promise.reject(new Error('no database in a unit test')) } } as unknown as ToolContext;
	it('refuses a missing key, a bad date, a bad resolution and from after to before reading anything', async () => {
		for (const args of [{}, { key: 'outflow', from: '2021-02-30' }, { key: 'outflow', resolution: 'hourly' }, { key: 'outflow', from: '2021-02-01', to: '2021-01-01' }])
			expect((await seriesTool.run(ctx, args)).ok, JSON.stringify(args)).toBe(false);
	});
});
