// The Lyne–Hollick base-flow filter (engine ≥ 1.3.0, issue #64, docs/model.md §2.9d).
import { describe, expect, it } from 'vitest';
import { Rng } from '../random';
import { BASEFLOW_ALPHA, BASEFLOW_HISTORY_DAYS, BASEFLOW_PASSES, BASEFLOW_REFLECT_DAYS, ECKHARDT_FILTER, filterBaseflow, HUGHES_FILTER, lyneHollickBaseflow, monthBaseflowSum } from './baseflow';

describe('lyneHollickBaseflow', () => {
	it('uses the South African daily parameter, three passes and a 30-day reflection', () => {
		expect([BASEFLOW_ALPHA, BASEFLOW_PASSES, BASEFLOW_REFLECT_DAYS]).toEqual([0.995, 3, 30]);
	});

	it('is all base flow for a steady river, and empty for an empty series', () => {
		expect(Array.from(lyneHollickBaseflow(new Array(100).fill(7)))).toEqual(new Array(100).fill(7));
		expect(lyneHollickBaseflow([])).toHaveLength(0);
		expect(Array.from(lyneHollickBaseflow([4]))).toEqual([4]);
	});

	it('leaves most of a flood out of the base flow', () => {
		const q = new Array(120).fill(1);
		for (let t = 60; t < 63; t++) q[t] = 100;
		const b = lyneHollickBaseflow(q);
		for (let t = 60; t < 63; t++) expect(b[t]).toBeLessThan(5);
		// Away from the flood the river is base flow again.
		expect(b[10]).toBeCloseTo(1, 6);
		expect(b[110]).toBeGreaterThan(0.9);
	});

	it('counts a missing or negative day as no flow', () => {
		const b = lyneHollickBaseflow([2, NaN, -3, 2, Infinity, 2]);
		expect(b[1]).toBe(0);
		expect(b[2]).toBe(0);
		expect(b[4]).toBe(0);
	});

	it('on random series: 0 ≤ base flow ≤ flow every day, with any α and passes', () => {
		const rng = new Rng(64);
		for (let k = 0; k < 200; k++) {
			const n = rng.int(1, 400);
			const q = Array.from({ length: n }, () => (rng.bool(0.05) ? 0 : rng.bool(0.05) ? rng.logFloat(1, 1e7) : rng.logFloat(1e-3, 100)));
			const alpha = rng.pick([BASEFLOW_ALPHA, 0.925, rng.float(0, 0.999)]);
			const b = lyneHollickBaseflow(q, alpha, rng.int(1, 4), rng.int(0, 60));
			for (let t = 0; t < n; t++) {
				expect(b[t]).toBeGreaterThanOrEqual(0);
				expect(b[t]).toBeLessThanOrEqual(q[t]!);
			}
		}
	});

	it('a month’s base flow is the filter over its window, summed over its last days (engine ≥ 1.6.0)', () => {
		expect(BASEFLOW_HISTORY_DAYS).toBe(730);
		const rng = new Rng(1606);
		const w = Array.from({ length: 400 }, () => (rng.bool(0.05) ? rng.logFloat(100, 1e5) : rng.logFloat(1, 50)));
		const b = lyneHollickBaseflow(w);
		let sum = 0;
		for (let t = 370; t < 400; t++) sum += b[t]!;
		expect(monthBaseflowSum(w, 30)).toBe(sum);
		expect(monthBaseflowSum(new Array(40).fill(3), 31)).toBe(93);
		expect(monthBaseflowSum(w, 0)).toBe(0);
		expect(() => monthBaseflowSum(w, 401)).toThrow(RangeError);
	});
});

// The validation signatures' filters (engine ≥ 1.50.0, docs/model.md §2.10d, CR-16), on the same plumbing.
describe('filterBaseflow', () => {
	it('Lyne–Hollick is the β = 0.5 case, bit for bit', () => {
		const rng = new Rng(1500);
		for (let k = 0; k < 50; k++) {
			const q = Array.from({ length: rng.int(1, 300) }, () => (rng.bool(0.05) ? rng.logFloat(10, 1e5) : rng.logFloat(1e-3, 10)));
			const alpha = rng.pick([0.925, 0.995, rng.float(0, 0.999)]);
			const passes = rng.int(1, 4);
			const reflect = rng.int(0, 40);
			expect(Array.from(filterBaseflow(q, { kind: 'quickflow', alpha, beta: 0.5, passes }, reflect))).toEqual(Array.from(lyneHollickBaseflow(q, alpha, passes, reflect)));
		}
	});

	it('Hughes, Hannart & Watkins (2003) eq. 1 by hand: q_t = α q_{t−1} + β(1 + α)(Q_t − Q_{t−1}), QB = Q − q', () => {
		// α 0.5, β 0.5 → β(1 + α) = 0.75: q = 0, 1.5, 0.75 → QB = 1, 1.5, 2.25.
		expect(Array.from(filterBaseflow([1, 3, 3], { kind: 'quickflow', alpha: 0.5, beta: 0.5, passes: 1 }, 0))).toEqual([1, 1.5, 2.25]);
		// β 0.25 → 0.375: q = 0, 0.75, 0.375 → QB = 1, 2.25, 2.625.
		expect(Array.from(filterBaseflow([1, 3, 3], { kind: 'quickflow', alpha: 0.5, beta: 0.25, passes: 1 }, 0))).toEqual([1, 2.25, 2.625]);
		// A fall drives q below 0: clamped, so the day is all base flow.
		expect(Array.from(filterBaseflow([1, 3, 1], { kind: 'quickflow', alpha: 0.5, beta: 0.5, passes: 1 }, 0))).toEqual([1, 1.5, 1]);
	});

	it('Hughes as South African practice applies it: α 0.995, β 0.5, one forward pass', () => {
		expect(HUGHES_FILTER).toEqual({ kind: 'quickflow', alpha: 0.995, beta: 0.5, passes: 1 });
		// One forward pass is causal: a flood tomorrow doesn't move today's base flow.
		const q = Array.from({ length: 60 }, (_, t) => 1 + (t % 7));
		const flood = [...q];
		flood[50] = 500;
		const a = filterBaseflow(q, HUGHES_FILTER, 0);
		const b = filterBaseflow(flood, HUGHES_FILTER, 0);
		expect(Array.from(b.slice(0, 50))).toEqual(Array.from(a.slice(0, 50)));
	});

	it('Eckhardt (2005) by hand: b_t = ((1 − B)·a·b_{t−1} + (1 − a)·B·Q_t) ÷ (1 − a·B), b_0 = B·Q_0, b ≤ Q', () => {
		// a 0.9, B 0.5: 1 − aB = 0.55. b0 = 1; b1 = (0.45 + 0.5) ÷ 0.55 = 19/11; b2 = (0.45·19/11 + 0.2) ÷ 0.55.
		const b = filterBaseflow([2, 10, 4], { kind: 'eckhardt', a: 0.9, bfiMax: 0.5 }, 0);
		expect(b[0]).toBe(1);
		expect(b[1]).toBeCloseTo(19 / 11, 14);
		expect(b[2]).toBeCloseTo((0.45 * (19 / 11) + 0.2) / 0.55, 14);
		// (0.45 + 0.025) ÷ 0.55 = 0.864 > 0.5: capped at the flow.
		expect(Array.from(filterBaseflow([2, 0.5], { kind: 'eckhardt', a: 0.9, bfiMax: 0.5 }, 0))).toEqual([1, 0.5]);
		// A steady river is its steady state: BFImax of it.
		for (const v of filterBaseflow(new Array(50).fill(4), ECKHARDT_FILTER)) expect(v).toBeCloseTo(4 * ECKHARDT_FILTER.bfiMax, 12);
		expect(ECKHARDT_FILTER).toEqual({ kind: 'eckhardt', a: 0.98, bfiMax: 0.25 });
	});

	it('on random series: 0 ≤ base flow ≤ flow every day, both filters, any parameters', () => {
		const rng = new Rng(1501);
		for (let k = 0; k < 200; k++) {
			const n = rng.int(1, 400);
			const q = Array.from({ length: n }, () => (rng.bool(0.05) ? 0 : rng.bool(0.05) ? rng.logFloat(1, 1e7) : rng.logFloat(1e-3, 100)));
			const filter = rng.bool(0.5)
				? { kind: 'quickflow' as const, alpha: rng.float(0, 0.999), beta: rng.float(0.01, 0.5), passes: rng.int(1, 4) }
				: { kind: 'eckhardt' as const, a: rng.float(0.5, 0.999), bfiMax: rng.float(0.01, 0.99) };
			const b = filterBaseflow(q, filter, rng.int(0, 60));
			for (let t = 0; t < n; t++) {
				expect(b[t]).toBeGreaterThanOrEqual(0);
				expect(b[t]).toBeLessThanOrEqual(q[t]!);
			}
		}
	});
});
