import { seriesRowFlags } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { anomalousPushedDays, HELD_EXAMPLES, limitWithout } from './hold.js';

// Rain every 5th day at 10 mm: 150 days give 30 wet days, too few for the
// outlier rule (100); 600 days give 120.
const series = (days: number) => ({ startDate: '2021-01-01', values: Array.from({ length: days }, (_, i) => (i % 5 === 0 ? 10 : 0)) as (number | null)[] });

describe('anomalousPushedDays', () => {
	it('is null for a clean push', () => {
		expect(anomalousPushedDays('rain_catchment_mm', series(600), { startDate: '2021-01-11', values: [3, 0] })).toBeNull();
	});

	it('counts a negative pushed day, with its date, even on a new series', () => {
		const held = { negative: 1, outlier: 0, examples: [{ date: '2021-02-10', value: -2 }] };
		expect(anomalousPushedDays('rain_catchment_mm', series(150), { startDate: '2021-02-10', values: [-2] })).toEqual(held);
		expect(anomalousPushedDays('rain_catchment_mm', null, { startDate: '2021-02-10', values: [-2] })).toEqual(held);
	});

	it('counts a pushed day above the outlier limit once the series has enough wet days', () => {
		expect(anomalousPushedDays('rain_catchment_mm', series(600), { startDate: '2022-02-06', values: [5000] })).toMatchObject({ negative: 0, outlier: 1 });
		// Too few wet days: the outlier rule doesn't apply (engine OUTLIER_MIN_POSITIVE).
		expect(anomalousPushedDays('rain_catchment_mm', series(150), { startDate: '2021-02-11', values: [5000] })).toBeNull();
	});

	it('judges a push by the series without it, so a batch of huge values can’t lift the limit over itself', () => {
		const before = series(600);
		const pushed = { startDate: '2021-05-01', values: Array.from({ length: 20 }, () => 5000) };
		expect(anomalousPushedDays('rain_catchment_mm', before, pushed)).toMatchObject({ outlier: 20 });
		// The engine's rule on the merged series would pass them all: 20 of 140 wet days are over the 99th percentile.
		const merged = { ...before, values: [...before.values] };
		pushed.values.forEach((v, i) => (merged.values[120 + i] = v));
		expect(seriesRowFlags('rain_catchment_mm', merged).outlier.filter(Boolean)).toHaveLength(0);
	});

	it('leaves out the days a push overwrites when it takes the limit', () => {
		// 600 days, the last 100 all at 1000 mm: with them the limit is 5 000 mm, without them 50 mm.
		const before = series(600);
		for (let i = 500; i < 600; i++) before.values[i] = 1000;
		expect(limitWithout('rain_catchment_mm', before, { startDate: '2022-05-16', values: new Array(100).fill(1) })).toBe(50);
		expect(limitWithout('rain_catchment_mm', before, { startDate: '2030-01-01', values: [1] })).toBe(5000);
	});

	it('uses the flow factor for flow', () => {
		const flow = { startDate: '2021-01-01', values: Array.from({ length: 200 }, () => 2) as (number | null)[] };
		expect(limitWithout('flow_logger_m3s', flow, { startDate: '2030-01-01', values: [1] })).toBe(20);
	});

	it('ignores blanks in the push', () => {
		expect(anomalousPushedDays('rain_catchment_mm', series(600), { startDate: '2021-02-10', values: [null, 1] })).toBeNull();
	});

	it(`lists at most ${HELD_EXAMPLES} examples but counts every day`, () => {
		const bad = Array.from({ length: 8 }, () => -1);
		const held = anomalousPushedDays('flow_logger_m3s', series(150), { startDate: '2021-01-21', values: bad })!;
		expect(held.negative).toBe(8);
		expect(held.examples).toHaveLength(HELD_EXAMPLES);
		expect(held.examples[0]).toEqual({ date: '2021-01-21', value: -1 });
	});
});
