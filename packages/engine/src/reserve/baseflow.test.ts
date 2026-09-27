// The Lyne–Hollick base-flow filter (engine ≥ 1.3.0, issue #64, docs/model.md §2.9d).
import { describe, expect, it } from 'vitest';
import { Rng } from '../random';
import { BASEFLOW_ALPHA, BASEFLOW_HISTORY_DAYS, BASEFLOW_PASSES, BASEFLOW_REFLECT_DAYS, lyneHollickBaseflow, monthBaseflowSum } from './baseflow';

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
