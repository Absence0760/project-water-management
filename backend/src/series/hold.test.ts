import { seriesRowFlags } from '@water-management/engine';
import { toEpochDay } from '@water-management/engine/calendar';
import { describe, expect, it } from 'vitest';
import { anomalousPushedDays, HELD_EXAMPLES, limitWithout, othersSuffice, outlierLimit } from './hold.js';

// Rain every 5th day at 10 mm: 150 days give 30 wet days, too few for the
// outlier rule (100); 600 days give 120.
const series = (days: number) => ({ startDate: '2021-01-01', values: Array.from({ length: days }, (_, i) => (i % 5 === 0 ? 10 : 0)) as (number | null)[] });

describe('anomalousPushedDays', () => {
	it('is null for a clean push', () => {
		expect(anomalousPushedDays('rain_catchment_mm', series(600), { startDate: '2021-01-11', values: [3, 0] })).toBeNull();
	});

	it('counts a negative pushed day, with its date, even on a new series', () => {
		const held = { negative: 1, outlier: 0, examples: [{ date: '2021-02-10', value: -2 }], limitFrom: null };
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

	it('leaves out the pushing key’s earlier days too, so batches under the limit can’t lift it (053)', () => {
		// 600 days, then 20 days of 45 mm the key pushed earlier, each batch under the 50 mm limit of the rest.
		const before = series(600);
		before.values.push(...new Array(20).fill(45));
		const keyDays: [number, number][] = [[toEpochDay('2021-01-01') + 600, toEpochDay('2021-01-01') + 620]];
		const pushed = { startDate: '2023-01-01', values: [200] };
		// Counted, they lift the 99th percentile to 45: a limit of 225 mm the 200 mm day passes.
		expect(limitWithout('rain_catchment_mm', before, pushed)).toBe(225);
		expect(limitWithout('rain_catchment_mm', before, pushed, keyDays)).toBe(50);
		expect(anomalousPushedDays('rain_catchment_mm', before, pushed, keyDays)).toMatchObject({ outlier: 1 });
		// A key's days outside the series change nothing.
		expect(limitWithout('rain_catchment_mm', series(600), pushed, [[toEpochDay('2030-01-01'), toEpochDay('2030-02-01')]])).toBe(50);
	});

	it('says which values the limit came from: the series without the key’s days first', () => {
		expect(outlierLimit('rain_catchment_mm', series(600), { startDate: '2030-01-01', values: [1] })).toEqual({ value: 50, from: 'others' });
		expect(othersSuffice(series(600), { startDate: '2030-01-01', values: [1] }, [])).toBe(true);
		expect(othersSuffice(null, { startDate: '2030-01-01', values: [1] }, [])).toBe(false);
	});

	describe('a series the key alone fills (056)', () => {
		const d0 = toEpochDay('2021-01-01');
		// 600 days the key wrote: 10 mm every 5th day, then 20 days of 45 mm it slipped in, batch by batch.
		const poisoned = () => {
			const s = series(600);
			s.values.push(...new Array(20).fill(45));
			return s;
		};
		const everything: [number, number][] = [[d0, d0 + 620]];
		const pushed = { startDate: '2023-01-01', values: [200] };

		it('takes the limit from what a person last accepted, so the key’s slow poisoning doesn’t count', () => {
			expect(othersSuffice(poisoned(), pushed, everything)).toBe(false);
			// The latest manual run read the first 600 days, before the 45s.
			expect(outlierLimit('rain_catchment_mm', poisoned(), pushed, everything, series(600))).toEqual({ value: 50, from: 'accepted' });
			expect(anomalousPushedDays('rain_catchment_mm', poisoned(), pushed, everything, series(600))).toMatchObject({ outlier: 1, limitFrom: 'accepted' });
			// Positive control: a genuine value inside what the person accepted passes.
			expect(anomalousPushedDays('rain_catchment_mm', poisoned(), { startDate: '2023-01-01', values: [40] }, everything, series(600))).toBeNull();
		});

		it('keeps a person’s own later days beside the accepted ones', () => {
			// A person wrote days 600–619 after the run (not the key's any more): their values count, the accepted ones fill the key's days.
			const mixed = poisoned();
			for (let i = 600; i < 620; i++) mixed.values[i] = 200;
			const keyOnly: [number, number][] = [[d0, d0 + 600]];
			expect(outlierLimit('rain_catchment_mm', mixed, pushed, keyOnly, series(600))).toEqual({ value: 1000, from: 'accepted' });
		});

		it('accepted values the person read with bigger numbers than today’s still count as accepted', () => {
			const accepted = series(600);
			for (let i = 500; i < 600; i++) accepted.values[i] = 1000;
			expect(outlierLimit('rain_catchment_mm', poisoned(), pushed, everything, accepted)).toEqual({ value: 5000, from: 'accepted' });
		});

		it('falls back to the series without the push (`own`) only while nobody has accepted enough of it', () => {
			// No manual run has read it: the key-shaped bar, said as such.
			expect(outlierLimit('rain_catchment_mm', poisoned(), pushed, everything, null)).toEqual({ value: 225, from: 'own' });
			expect(anomalousPushedDays('rain_catchment_mm', poisoned(), { startDate: '2023-01-01', values: [5000] }, everything)).toMatchObject({
				outlier: 1,
				limitFrom: 'own'
			});
			// A manual run that read too little of it (30 wet days) is no reference either.
			expect(outlierLimit('rain_catchment_mm', poisoned(), pushed, everything, series(150))).toEqual({ value: 225, from: 'own' });
			// Still without the pushed days themselves.
			const before = series(600);
			for (let i = 500; i < 600; i++) before.values[i] = 1000;
			expect(limitWithout('rain_catchment_mm', before, { startDate: '2022-05-16', values: new Array(100).fill(1) }, [[d0, d0 + 600]])).toBe(50);
		});
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
