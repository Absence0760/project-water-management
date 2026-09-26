import { describe, expect, it } from 'vitest';
import { anomalousPushedDays, HELD_EXAMPLES } from './hold.js';

// 150 days with rain every 5th: 30 wet days, too few for the outlier rule (100); 600 days gives 120.
const series = (days: number) => ({ startDate: '2021-01-01', values: Array.from({ length: days }, (_, i) => (i % 5 === 0 ? 10 : 0)) as (number | null)[] });
const withDays = (s: ReturnType<typeof series>, at: number, values: (number | null)[]) => {
	const v = [...s.values];
	values.forEach((x, i) => (v[at + i] = x));
	return { startDate: s.startDate, values: v };
};

describe('anomalousPushedDays', () => {
	it('is null for a clean push', () => {
		const base = series(600);
		expect(anomalousPushedDays('rain_catchment_mm', withDays(base, 10, [3, 0]), { startDate: '2021-01-11', values: [3, 0] })).toBeNull();
	});

	it('counts a negative pushed day, with its date', () => {
		const merged = withDays(series(150), 40, [-2]);
		expect(anomalousPushedDays('rain_catchment_mm', merged, { startDate: '2021-02-10', values: [-2] })).toEqual({
			negative: 1,
			outlier: 0,
			examples: [{ date: '2021-02-10', value: -2 }]
		});
	});

	it('counts a pushed day above the outlier limit once the series has enough wet days', () => {
		const merged = withDays(series(600), 401, [5000]);
		expect(anomalousPushedDays('rain_catchment_mm', merged, { startDate: '2022-02-06', values: [5000] })).toMatchObject({ negative: 0, outlier: 1 });
		// Too few wet days: the outlier rule doesn't apply (engine OUTLIER_MIN_POSITIVE).
		expect(anomalousPushedDays('rain_catchment_mm', withDays(series(150), 41, [5000]), { startDate: '2021-02-11', values: [5000] })).toBeNull();
	});

	it('ignores flagged days the push didn’t carry: a blank in the push, or a day outside it', () => {
		// Day 40 was already negative before the push; the push leaves it blank and writes day 41 (then day 42).
		const merged = withDays(series(150), 40, [-2, 1, 1]);
		expect(anomalousPushedDays('rain_catchment_mm', merged, { startDate: '2021-02-10', values: [null, 1] })).toBeNull();
		expect(anomalousPushedDays('rain_catchment_mm', merged, { startDate: '2021-02-12', values: [1] })).toBeNull();
	});

	it(`lists at most ${HELD_EXAMPLES} examples but counts every day`, () => {
		const bad = Array.from({ length: 8 }, () => -1);
		const merged = withDays(series(150), 20, bad);
		const held = anomalousPushedDays('flow_logger_m3s', merged, { startDate: '2021-01-21', values: bad })!;
		expect(held.negative).toBe(8);
		expect(held.examples).toHaveLength(HELD_EXAMPLES);
		expect(held.examples[0]).toEqual({ date: '2021-01-21', value: -1 });
	});
});
