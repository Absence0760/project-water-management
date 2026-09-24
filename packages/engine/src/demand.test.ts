import { describe, expect, it } from 'vitest';
import type { Monthly } from './calendar';
import { farmDailyDemand, grossCropMm, grossFarmDemandM3PerDay, netDailyDemandM3, rainOffsetM3 } from './demand';
import { Rng } from './random';

const flat = (v: number) => new Array(12).fill(v) as unknown as Monthly;

describe('grossFarmDemandM3PerDay', () => {
	it('sums crop area × A-pan × crop factor and spreads over the month', () => {
		const crops = [
			{ id: 'a', name: 'Citrus', cropFactor: flat(0.5) },
			{ id: 'b', name: 'Pears', cropFactor: flat(1) }
		];
		const areas = new Map([
			['a', 10_000],
			['b', 20_000]
		]);
		const out = grossFarmDemandM3PerDay(flat(100), crops, areas);
		// Oct (31 days): (10000·50 + 20000·100)/1000 = 2500 m³ → /31
		expect(out[0]).toBeCloseTo(2500 / 31, 10);
		// Feb uses 28.25 days
		expect(out[4]).toBeCloseTo(2500 / 28.25, 10);
	});

	it('ignores crops with no planted area', () => {
		const out = grossFarmDemandM3PerDay(flat(100), [{ id: 'x', name: 'X', cropFactor: flat(1) }], new Map());
		expect(out.every((v) => v === 0)).toBe(true);
	});
});

describe('netDailyDemandM3', () => {
	it('subtracts effective rainfall on the cropped area and floors at zero', () => {
		expect(netDailyDemandM3(1000, 100_000, 5, 0.65)).toBeCloseTo(1000 - 325, 10);
		expect(netDailyDemandM3(100, 100_000, 50, 0.65)).toBe(0);
	});
});

describe('full precision (audit R1)', () => {
	it('does not round crop mm, farm m³/day or the net demand like the workbook does', () => {
		// The workbook would give 90.12 mm → 1134.6 m³/day → ROUND(373.515) = 374.
		const apan = flat(128.73636363636365);
		const crops = [
			{ id: 'o', name: 'Crop A', cropFactor: flat(0.7) },
			{ id: 'p', name: 'Crop B', cropFactor: flat(0.7) }
		];
		const areas = new Map([
			['o', 207_000],
			['p', 183_300]
		]);
		const mm = 128.73636363636365 * 0.7;
		expect(grossCropMm(apan, crops[0]!)[0]).toBe(mm);
		const gross = grossFarmDemandM3PerDay(apan, crops, areas)[0]!;
		expect(gross).toBeCloseTo((390_300 * mm) / 1000 / 31, 9);
		expect(netDailyDemandM3(gross, 390_300, 3, 0.65)).toBeCloseTo(gross - 761.085, 9);
	});
});

describe('farmDailyDemand: effective rain carried over through the soil-water store (N3)', () => {
	// 10 000 m²: 1 mm over the cropped area is 10 m³. Fraction 0.5, so 1 mm of rain is 5 m³ effective.
	const A = 10_000;
	const run = (gross: number[], rain: number[], storeMm: number) => farmDailyDemand(Float64Array.from(gross), A, Float64Array.from(rain), 0.5, storeMm);

	it('with no store (0 mm) is bit for bit the workbook rule MAX(0, gross − Pe), whatever the inputs', () => {
		const rng = new Rng(42);
		for (let k = 0; k < 200; k++) {
			const days = rng.int(1, 60);
			const area = rng.pick([0, 1, 1234.5, 1e5, 3.7e7]);
			const fraction = rng.pick([0, 0.65, 1, rng.next()]);
			const gross = Array.from({ length: days }, () => (rng.bool(0.1) ? 0 : rng.logFloat(1e-3, 1e5)));
			const rain = Array.from({ length: days }, () => (rng.bool(0.5) ? 0 : rng.logFloat(0.01, 300)));
			const f = farmDailyDemand(Float64Array.from(gross), area, Float64Array.from(rain), fraction, 0);
			for (let t = 0; t < days; t++) {
				expect(Object.is(f.net[t], netDailyDemandM3(gross[t]!, area, rain[t]!, fraction)), `case ${k} day ${t}`).toBe(true);
				expect(f.storeMm[t]).toBe(0);
			}
		}
	});

	it('keeps the rain the crop could not use today and uses it on the following days', () => {
		// Day 0: 20 mm → Pe 100 m³ against 30 m³: 30 used, 70 m³ = 7 mm kept.
		// Day 1: dry, 30 m³ from the store → 4 mm left. Day 2: 40 m³ wanted, 40 m³ (4 mm) in store.
		const f = run([30, 30, 50, 30], [20, 0, 0, 0], 25);
		expect(Array.from(f.used)).toEqual([30, 30, 40, 0]);
		expect(Array.from(f.net)).toEqual([0, 0, 10, 30]);
		expect(Array.from(f.storeMm)).toEqual([7, 4, 0, 0]);
	});

	it('covers the day of a big rain first and loses what overflows the store', () => {
		// 60 mm → 300 m³: today's 30 m³ first (even with a 1 mm store), then 1 mm kept, the rest lost.
		const f = run([30, 30, 30], [60, 0, 0], 1);
		expect(Array.from(f.used)).toEqual([30, 10, 0]);
		expect(Array.from(f.net)).toEqual([0, 20, 30]);
		expect(Array.from(f.storeMm)).toEqual([1, 0, 0]);
	});

	it('starts empty, never needs water for a negative gross, and hands out no more than fell', () => {
		const f = run([-5, 30, 30], [0, 2, 0], 25);
		expect(f.net[0]).toBe(0);
		expect(f.used[0]).toBe(0);
		expect(f.storeMm[0]).toBe(0);
		const rng = new Rng(7);
		for (let k = 0; k < 50; k++) {
			const days = 100;
			const gross = Array.from({ length: days }, () => rng.float(0, 80));
			const rain = Array.from({ length: days }, () => (rng.bool(0.7) ? 0 : rng.logFloat(1, 120)));
			const size = rng.pick([0, 5, 25, 100, 1e9]);
			const g = run(gross, rain, size);
			let used = 0;
			let pe = 0;
			for (let t = 0; t < days; t++) {
				expect(g.storeMm[t]).toBeGreaterThanOrEqual(0);
				expect(g.storeMm[t]).toBeLessThanOrEqual(size);
				expect(g.net[t]).toBeGreaterThanOrEqual(0);
				expect(g.net[t]! + g.used[t]!).toBeCloseTo(gross[t]!, 9);
				used += g.used[t]!;
				pe += rainOffsetM3(A, rain[t]!, 0.5);
			}
			expect(used).toBeLessThanOrEqual(pe + 1e-9);
			// Rain in, rain used, rain in the store at the end: whatever is left over overflowed.
			expect(pe - used - (g.storeMm[days - 1]! * A) / 1000).toBeGreaterThanOrEqual(-1e-9);
		}
	});

	it('an unlimited store uses every drop of effective rain eventually (none lost)', () => {
		const f = run([10, 10, 10, 10], [10, 0, 0, 0], 1e9);
		// 50 m³ in, 10 m³ a day out: 40 used, 10 m³ = 1 mm left at the end.
		expect(Array.from(f.used)).toEqual([10, 10, 10, 10]);
		expect(f.storeMm[3]).toBeCloseTo(1, 12);
	});
});
