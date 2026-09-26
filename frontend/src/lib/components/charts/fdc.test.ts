import { describe, expect, it } from 'vitest';
import { exceedanceGrid, finiteCount, flowAtExceedance, flowDurationCurves, onDaysOf, percentileFlows, sortedDescending } from './fdc';

describe('sortedDescending', () => {
	it('drops gaps and sorts high → low', () => {
		expect([...sortedDescending([3, null, 1, Number.NaN, 2])]).toEqual([3, 2, 1]);
	});
});

describe('flowAtExceedance', () => {
	// 1..99 descending: Weibull position of rank r is r %, so Q(p) = 100 − p.
	const s = sortedDescending(Array.from({ length: 99 }, (_, i) => i + 1));

	it('uses Weibull plotting positions', () => {
		expect(flowAtExceedance(s, 1)).toBe(99);
		expect(flowAtExceedance(s, 50)).toBe(50);
		expect(flowAtExceedance(s, 90)).toBe(10);
	});

	it('interpolates between ranks', () => {
		expect(flowAtExceedance(s, 50.5)).toBeCloseTo(49.5, 10);
	});

	it('clamps at the ends', () => {
		expect(flowAtExceedance(s, 0)).toBe(99);
		expect(flowAtExceedance(s, 100)).toBe(1);
	});

	it('handles empty and single-value records', () => {
		expect(flowAtExceedance(new Float64Array(), 50)).toBeNull();
		expect(flowAtExceedance(Float64Array.of(7), 50)).toBe(7);
	});
});

describe('flowDurationCurves', () => {
	it('puts every curve on the shared grid, non-increasing', () => {
		const a = Array.from({ length: 500 }, (_, i) => Math.sin(i) * 10 + 20);
		const b = [...a.map((v) => v / 2), null, null];
		const { x, ys } = flowDurationCurves([a, b]);
		expect(ys).toHaveLength(2);
		for (const y of ys) {
			expect(y).toHaveLength(x.length);
			for (let i = 1; i < y.length; i++) expect(y[i]!).toBeLessThanOrEqual(y[i - 1]!);
		}
	});

	it('grid spans 0–100 % and is strictly increasing', () => {
		const g = exceedanceGrid();
		expect(g[0]).toBe(0);
		expect(g[g.length - 1]).toBe(100);
		for (let i = 1; i < g.length; i++) expect(g[i]!).toBeGreaterThan(g[i - 1]!);
	});
});

describe('percentileFlows', () => {
	it('reports Q10/Q50/Q90/Q95', () => {
		const q = percentileFlows(Array.from({ length: 99 }, (_, i) => i + 1));
		expect(q).toEqual({ q10: 90, q50: 50, q90: 10, q95: 5, n: 99 });
	});
});

describe('onDaysOf', () => {
	it('keeps a series only on the days the mask has a reading, so both curves rank the same days', () => {
		const sim = [10, 20, 30, 40, 50, 60];
		const obs = [NaN, null, 3, 4, null, 6];
		expect(onDaysOf(sim, obs)).toEqual([null, null, 30, 40, null, 60]);
		expect(finiteCount(onDaysOf(sim, obs))).toBe(finiteCount(obs));
		// The hydrologist's case: a gauge over the dry half only moves the median a long way.
		const wet = Array.from({ length: 100 }, (_, i) => (i < 50 ? 10 : 1));
		const gauge = wet.map((_, i) => (i < 50 ? null : 1));
		expect(percentileFlows(wet).q50).toBeCloseTo(5.5);
		expect(percentileFlows(onDaysOf(wet, gauge)).q50).toBe(1);
	});

	it('treats days past the end of the mask as gaps', () => {
		expect(onDaysOf([1, 2, 3], [1])).toEqual([1, null, null]);
	});
});
