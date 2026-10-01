import { describe, expect, it } from 'vitest';
import type { Monthly } from './calendar';
import { farmDailyDemand, farmIrrigationEfficiency, grossCropMm, grossFarmDemandM3PerDay, modelFarmEfficiency, netDailyDemandM3, rainOffsetM3 } from './demand';
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
		// Rounding like the workbook would give 77.09 mm → 870.4 m³/day → ROUND(187.9) = 188;
		// full precision keeps 77.0864192 mm → 870.3305… m³/day → 187.8305… m³/day.
		const apan = flat(110.123456);
		const crops = [
			{ id: 'o', name: 'Crop A', cropFactor: flat(0.7) },
			{ id: 'p', name: 'Crop B', cropFactor: flat(0.7) }
		];
		const areas = new Map([
			['o', 200_000],
			['p', 150_000]
		]);
		const mm = 110.123456 * 0.7;
		expect(grossCropMm(apan, crops[0]!)[0]).toBe(mm);
		const gross = grossFarmDemandM3PerDay(apan, crops, areas)[0]!;
		expect(gross).toBeCloseTo((350_000 * mm) / 1000 / 31, 9);
		// Effective rain: 350 000 m² × 0.65 / 1000 × 3 mm = 682.5 m³.
		expect(netDailyDemandM3(gross, 350_000, 3, 0.65)).toBeCloseTo(gross - 682.5, 9);
		expect(netDailyDemandM3(gross, 350_000, 3, 0.65)).not.toBe(188);
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

	it('rain an ulp short of the need covers it: no noise-level requirement (engine 1.57.0, verify random seed 1343)', () => {
		// Day 0: 0.3 m³ of effective rain (1000 m² × 1 ÷ 1000 × 0.3 mm) against 0.1 m³; the store keeps
		// 0.3 − 0.1 = 0.19999999999999998 m³, an ulp below 0.2. Day 1: dry, 0.2 m³ wanted. Before 1.57.0
		// that left a crop requirement of 2.8e-17 m³, which as a demand switched on a dam-filling
		// borehole (verify random seed 1343: 1.4e-14 m³ beside a 35 m³ need, 495 m³ pumped).
		const f = farmDailyDemand(Float64Array.from([0.1, 0.2]), 1000, Float64Array.from([0.3, 0]), 1, 1000);
		expect(0.3 - 0.1).toBeLessThan(0.2);
		expect(f.net[1]).toBe(0);
		expect(f.used[1]).toBe(0.2);
		expect(f.storeMm[1]).toBe(0);
		expect(netDailyDemandM3(0.2, 1000, 0.19999999999999998, 1)).toBe(0);
		// Positive control: a real shortfall (5 × 10⁻⁷ of the need) is still a requirement.
		const g = farmDailyDemand(Float64Array.from([0.1, 0.2000001]), 1000, Float64Array.from([0.3, 0]), 1, 1000);
		expect(g.net[1]).toBeCloseTo(1e-7, 15);
		expect(g.used[1]).toBe(0.3 - 0.1);
		expect(netDailyDemandM3(0.2000001, 1000, 0.19999999999999998, 1)).toBeCloseTo(1e-7, 15);
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

describe('farmIrrigationEfficiency: crops under their own irrigation system (engine 0.43.0, issue #54)', () => {
	const areas = new Map([
		['a', 10_000],
		['b', 30_000]
	]);

	it('returns the farm efficiency untouched, bit for bit, when no cropped crop has its own', () => {
		const crops = [
			{ id: 'a', cropFactor: flat(0.5) },
			{ id: 'b', cropFactor: flat(1), irrigationEfficiency: null },
			// Its own efficiency but no area on this farm: it doesn't count.
			{ id: 'c', cropFactor: flat(1), irrigationEfficiency: 0.9 }
		];
		for (const e of [0.8, 0.7123456789, 1]) expect(farmIrrigationEfficiency(e, crops, areas, flat(100))).toBe(e);
	});

	it('weights each crop by its annual gross requirement: e = Σ w ÷ Σ (w ÷ e_c) (hand-computed)', () => {
		// a: 10 000 m² × 0.5 × 100 mm × 12 = 6e6 (drip, 0.9); b: 30 000 m² × 1 × 100 × 12 = 3.6e7 (the farm's 0.75).
		const crops = [
			{ id: 'a', cropFactor: flat(0.5), irrigationEfficiency: 0.9 },
			{ id: 'b', cropFactor: flat(1) }
		];
		const e = farmIrrigationEfficiency(0.75, crops, areas, flat(100));
		expect(e).toBeCloseTo((6e6 + 3.6e7) / (6e6 / 0.9 + 3.6e7 / 0.75), 12);
		expect(e).toBeCloseTo(63 / 82, 12); // 42 ÷ (20/3 + 48)
		// So a requirement F split by gross share (6 : 36) is abstracted as Σ F_c ÷ e_c.
		const F = 420;
		expect(F / e).toBeCloseTo(60 / 0.9 + 360 / 0.75, 9);
	});

	it('weights a month by its A-pan: a crop factor in the high-evaporation months counts for more', () => {
		// A-pan 200 mm Oct–Mar, 50 mm Apr–Sep; crop a grows Oct–Mar only, crop b Apr–Sep only, same area.
		const apan = [200, 200, 200, 200, 200, 200, 50, 50, 50, 50, 50, 50];
		const crops = [
			{ id: 'a', cropFactor: [1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0], irrigationEfficiency: 0.9 },
			{ id: 'b', cropFactor: [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1], irrigationEfficiency: 0.6 }
		];
		const same = new Map([
			['a', 1000],
			['b', 1000]
		]);
		// w_a = 1000 × 1200 = 1.2e6, w_b = 1000 × 300 = 3e5.
		expect(farmIrrigationEfficiency(0.8, crops, same, apan)).toBeCloseTo(1.5e6 / (1.2e6 / 0.9 + 3e5 / 0.6), 12);
	});

	it('falls back to area × crop factor with no A-pan, and to the farm with no requirement at all', () => {
		const crops = [
			{ id: 'a', cropFactor: flat(0.5), irrigationEfficiency: 0.9 },
			{ id: 'b', cropFactor: flat(1) }
		];
		// k_a = 10 000 × 6 = 6e4, k_b = 30 000 × 12 = 3.6e5.
		expect(farmIrrigationEfficiency(0.75, crops, areas, flat(0))).toBeCloseTo(4.2e5 / (6e4 / 0.9 + 3.6e5 / 0.75), 12);
		expect(farmIrrigationEfficiency(0.75, crops.map((c) => ({ ...c, cropFactor: flat(0) })), areas, flat(100))).toBe(0.75);
	});

	it('ignores an efficiency outside (0, 1] and negative crop factors', () => {
		const bad = [
			{ id: 'a', cropFactor: flat(1), irrigationEfficiency: 0 },
			{ id: 'b', cropFactor: flat(1), irrigationEfficiency: 1.2 }
		];
		expect(farmIrrigationEfficiency(0.8, bad, areas, flat(100))).toBe(0.8);
		const neg = [
			{ id: 'a', cropFactor: flat(-1), irrigationEfficiency: 0.5 },
			{ id: 'b', cropFactor: flat(1), irrigationEfficiency: 0.9 }
		];
		expect(farmIrrigationEfficiency(0.8, neg, areas, flat(100))).toBeCloseTo(0.9, 12);
	});

	it('stays between the efficiencies it combines, and lowering any one never raises it (invariant)', () => {
		const rng = new Rng(54);
		for (let i = 0; i < 500; i++) {
			const n = rng.int(1, 5);
			const crops = Array.from({ length: n }, (_, c) => ({
				id: `c${c}`,
				cropFactor: Array.from({ length: 12 }, () => rng.float(0, 1.3)),
				...(rng.bool(0.6) ? { irrigationEfficiency: rng.float(0.05, 1) } : {})
			}));
			const a = new Map(crops.map((c) => [c.id, rng.float(1, 1e6)] as [string, number]));
			const apan = Array.from({ length: 12 }, () => rng.float(0, 300));
			const farm = rng.float(0.05, 1);
			const e = farmIrrigationEfficiency(farm, crops, a, apan);
			const all = crops.map((c) => c.irrigationEfficiency ?? farm);
			expect(e).toBeGreaterThanOrEqual(Math.min(...all) * (1 - 1e-12));
			expect(e).toBeLessThanOrEqual(Math.max(...all) * (1 + 1e-12));
			// So the abstraction F ÷ e never falls when a crop's system gets worse.
			const k = rng.int(0, n - 1);
			const lower = crops.map((c, j) => (j === k ? { ...c, irrigationEfficiency: (c.irrigationEfficiency ?? farm) * 0.9 } : c));
			expect(farmIrrigationEfficiency(farm, lower, a, apan)).toBeLessThanOrEqual(e * (1 + 1e-12));
		}
	});

	it('gives the same bits in any crop order (summed in id order)', () => {
		const crops = [
			{ id: 'b', cropFactor: flat(0.37), irrigationEfficiency: 0.71 },
			{ id: 'a', cropFactor: flat(0.93), irrigationEfficiency: 0.87 },
			{ id: 'c', cropFactor: flat(0.11) }
		];
		const a = new Map([
			['a', 12_345.678],
			['b', 98_765.4321],
			['c', 555.5]
		]);
		const e = farmIrrigationEfficiency(0.66, crops, a, flat(123.4));
		expect(farmIrrigationEfficiency(0.66, [...crops].reverse(), a, flat(123.4))).toBe(e);
		expect(farmIrrigationEfficiency(0.66, [crops[1]!, crops[2]!, crops[0]!], a, flat(123.4))).toBe(e);
	});

	it('modelFarmEfficiency reads the same from a model document: the farm’s rows, known crops only, split rows summed', () => {
		const crops = [
			{ id: 'a', cropFactor: flat(0.5), irrigationEfficiency: 0.9 },
			{ id: 'b', cropFactor: flat(1) }
		];
		const rows = [
			{ nodeId: 'F', cropId: 'b', areaM2: 20_000 },
			{ nodeId: 'F', cropId: 'a', areaM2: 10_000 },
			{ nodeId: 'F', cropId: 'b', areaM2: 10_000 },
			{ nodeId: 'G', cropId: 'a', areaM2: 1e9 },
			{ nodeId: 'F', cropId: 'unknown', areaM2: 1e9 }
		];
		expect(modelFarmEfficiency(0.75, 'F', crops, rows, flat(100))).toBe(farmIrrigationEfficiency(0.75, crops, areas, flat(100)));
		expect(modelFarmEfficiency(0.75, 'H', crops, rows, flat(100))).toBe(0.75);
	});
});

describe('farmDailyDemand: a fraction per day (monthly effective rain, engine 0.43.0, issue #54)', () => {
	it('uses each day its own fraction (hand-computed, no store)', () => {
		// 1000 m², 10 mm of rain a day, gross 20 m³/day. Fractions 0.5, 0 and 1: Pe = 5, 0 and 10 m³.
		const f = farmDailyDemand([20, 20, 20], 1000, [10, 10, 10], [0.5, 0, 1], 0);
		expect(Array.from(f.used)).toEqual([5, 0, 10]);
		expect(Array.from(f.net)).toEqual([15, 20, 10]);
	});

	it('the same fraction every day is the one-number call, bit for bit, store included', () => {
		const rng = new Rng(7);
		const days = 400;
		const gross = Array.from({ length: days }, () => rng.float(0, 50));
		const rain = Array.from({ length: days }, () => (rng.bool(0.3) ? rng.float(0, 80) : 0));
		const one = farmDailyDemand(gross, 12_345, rain, 0.65, 25);
		const per = farmDailyDemand(gross, 12_345, rain, new Float64Array(days).fill(0.65), 25);
		expect(Array.from(per.net)).toEqual(Array.from(one.net));
		expect(Array.from(per.used)).toEqual(Array.from(one.used));
		expect(Array.from(per.storeMm)).toEqual(Array.from(one.storeMm));
	});

	it('a higher fraction on any day never raises net demand on any day, with or without the store (invariant)', () => {
		const rng = new Rng(11);
		for (let i = 0; i < 50; i++) {
			const days = 120;
			const gross = Array.from({ length: days }, () => rng.float(0, 50));
			const rain = Array.from({ length: days }, () => (rng.bool(0.4) ? rng.float(0, 60) : 0));
			const lo = Array.from({ length: days }, () => rng.float(0, 1));
			const hi = lo.map((x) => Math.min(1, x + rng.float(0, 0.5)));
			const store = rng.pick([0, 25, 200]);
			const a = farmDailyDemand(gross, 5000, rain, lo, store);
			const b = farmDailyDemand(gross, 5000, rain, hi, store);
			for (let t = 0; t < days; t++) {
				expect(b.net[t]!).toBeLessThanOrEqual(a.net[t]! + 1e-9);
				expect(a.net[t]!).toBeGreaterThanOrEqual(0);
				expect(a.net[t]!).toBeLessThanOrEqual(gross[t]!);
			}
		}
	});
});
