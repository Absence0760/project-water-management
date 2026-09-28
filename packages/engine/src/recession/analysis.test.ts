import { describe, expect, it } from 'vitest';
import { fitRecession, recessionPoints, recessionRateAt, type RecessionPoint } from './analysis';
import { recessionSegments, type RecessionDqdtMethod } from './segments';
import { exponential, quadratic, syntheticRecord } from './testSeries';

const PEAKS = [2, 4, 7, 12, 20, 35, 60, 100];
const METHODS: RecessionDqdtMethod[] = ['ETS', 'BN', 'backwards'];

function fitOf(curve: (q0: number, t: number) => number, method: RecessionDqdtMethod, dryDays = 14) {
	const r = syntheticRecord(
		PEAKS.map((p) => ({ peakM3s: p, dryDays })),
		curve
	);
	const segments = recessionSegments(r);
	expect(segments).toHaveLength(PEAKS.length);
	return fitRecession(recessionPoints(r.flowM3s, segments, method))!;
}

describe('recessionPoints + fitRecession (TOSSH util_dQdt, util_FitPowerLaw linear)', () => {
	it.each(METHODS)('%s recovers b = 1 and a ≈ k from exponential recessions', (method) => {
		const k = 0.05;
		const f = fitOf(exponential(k), method);
		expect(f.b).toBeCloseTo(1, 6);
		expect(f.a).toBeCloseTo(k, 2);
		expect(f.segments).toBe(PEAKS.length);
	});

	it('BN on an exponential recession gives exactly 2·tanh(k/2) (the pair-mean bias)', () => {
		const k = 0.2;
		expect(fitOf(exponential(k), 'BN').a).toBeCloseTo(2 * Math.tanh(k / 2), 10);
	});

	it.each(METHODS)('%s recovers b ≈ 2 and a from −dQ/dt = a·Q² recessions', (method) => {
		const a = 0.002;
		const f = fitOf(quadratic(a), method);
		expect(f.b).toBeGreaterThan(1.9);
		expect(f.b).toBeLessThan(2.1);
		expect(Math.abs(f.a / a - 1)).toBeLessThan(0.15);
	});

	it('ETS on a long segment widens its window past 3 days and still gives b ≈ 1', () => {
		// 40 dry days: L = 39, 0.1·L = 3.9, so m reaches 1 + ⌈3.9·e^(−1/(γk))⌉ > 2 late in the segment.
		const f = fitOf(exponential(0.1), 'ETS', 40);
		expect(f.b).toBeCloseTo(1, 3);
		expect(f.a).toBeGreaterThan(0.09);
		expect(f.a).toBeLessThan(0.11);
	});

	it('ETS points follow TOSSH: window start i while i + m(i) ≤ end, weighted by R²', () => {
		const q = [10, 9, 8.1, 7.29, 6.561, 5.9049];
		const pts = recessionPoints(q, [[0, 5]], 'ETS');
		// L = 6, γ > 0 → m = 1 + ⌈0.6·e^(−1/(γk))⌉ = 2 on every day; starts 0 … 3.
		expect(pts).toHaveLength(4);
		expect(pts[0]!.qM3s).toBeCloseTo((10 + 9 + 8.1) / 3, 12);
		expect(pts[0]!.rate).toBeCloseTo((10 - 8.1) / 2, 12);
		expect(pts[0]!.weight).toBeGreaterThan(0.99);
		expect(pts[0]!.weight).toBeLessThanOrEqual(1);
	});

	it('BN and backwards take the pair’s mean and the later day’s flow', () => {
		const q = [10, 8, 7];
		expect(recessionPoints(q, [[0, 2]], 'BN')).toEqual([
			{ segment: 0, qM3s: 9, rate: 2, weight: 1 },
			{ segment: 0, qM3s: 7.5, rate: 1, weight: 1 }
		]);
		expect(recessionPoints(q, [[0, 2]], 'backwards').map((p) => p.qM3s)).toEqual([8, 7]);
	});

	it('drops points whose −dQ/dt is not positive, and a segment with a missing or zero day', () => {
		expect(recessionPoints([10, 10, 9], [[0, 2]], 'BN').map((p) => p.rate)).toEqual([1]);
		expect(recessionPoints([10, null, 9, 8], [[0, 3]], 'BN')).toEqual([]);
		expect(recessionPoints([10, 0, 9, 8], [[0, 3]], 'BN')).toEqual([]);
		expect(recessionPoints([10, 9, 8, 7], [[0, 3], [1, 3]], 'BN').map((p) => p.segment)).toEqual([0, 0, 0, 1, 1]);
	});

	it('fits nothing from fewer than 3 points, or flows spanning less than a factor of 1.2 (b not identifiable)', () => {
		const p = (qM3s: number, rate: number): RecessionPoint => ({ segment: 0, qM3s, rate, weight: 1 });
		expect(fitRecession([p(1, 0.1), p(2, 0.2)])).toBeNull();
		expect(fitRecession([p(1, 0.1), p(1, 0.2), p(1, 0.3)])).toBeNull();
		// A simulated flow that barely moves (from an engine fuzz seed): the slope would come out at b ≈ 127.
		expect(fitRecession([p(0.0053093, 2.909e-6), p(0.0053065, 2.635e-6), p(0.0053027, 2.423e-6), p(0.0053003, 2.344e-6)])).toBeNull();
		expect(fitRecession([p(1, 0.1), p(1.1, 0.11), p(1.19, 0.119)])).toBeNull();
		expect(fitRecession([p(1, 0.1), p(1.1, 0.11), p(1.2, 0.12)])!.b).toBeCloseTo(1, 9);
		const f = fitRecession([p(1, 0.1), p(2, 0.4), p(4, 1.6)])!;
		expect(f.b).toBeCloseTo(2, 12);
		expect(f.a).toBeCloseTo(0.1, 12);
		expect([f.minQM3s, f.maxQM3s, f.points, f.segments]).toEqual([1, 4, 3, 1]);
	});

	it('weights each row (TOSSH multiplies rows by the weight): a near-zero weight barely moves the fit', () => {
		const p = (qM3s: number, rate: number, weight = 1): RecessionPoint => ({ segment: 0, qM3s, rate, weight });
		const clean = [p(1, 0.1), p(2, 0.2), p(4, 0.4)];
		const f = fitRecession([...clean, p(3, 10, 1e-6)])!;
		expect(f.b).toBeCloseTo(1, 6);
	});

	it('recessionRateAt is −dQ/dt ÷ Q on the curve', () => {
		expect(recessionRateAt({ a: 0.1, b: 2 }, 3)).toBeCloseTo(0.3, 12);
		expect(recessionRateAt({ a: 0.05, b: 1 }, 42)).toBeCloseTo(0.05, 12);
	});
});
