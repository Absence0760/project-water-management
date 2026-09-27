// Resizing a dam along its own area–volume relation (engine 1.10.0,
// docs/model.md §2.13, hydrologist persona review of issue #46 item 11).
import { describe, expect, it } from 'vitest';
import type { DamCurvePoint } from '../project';
import { resizeDamCurve, resizedFullArea, topExponent } from './damResize';

describe('resizedFullArea (power-law dam)', () => {
	// The review's worked numbers: a 100 000 m³ dam, 3 m mean depth (A_full = 33 333 m²), b = 0.7.
	const A = 100_000 / 3;

	it('a doubled dam has A_full × 2^b, not twice the area', () => {
		expect(resizedFullArea(A, 100_000, 200_000, 0.7)).toBeCloseTo(54_150, -1);
		expect(resizedFullArea(A, 100_000, 200_000, 0.7)).toBeLessThan(2 * A);
		// Halved: 20 520 m², more than the uniform 16 667.
		expect(resizedFullArea(A, 100_000, 50_000, 0.7)).toBeCloseTo(20_520, -1);
		// b = 1 is uniform scaling (constant mean depth).
		expect(resizedFullArea(A, 100_000, 200_000, 1)).toBeCloseTo(2 * A, 9);
	});

	it('an unchanged dam keeps its area to the bit; no dam on either side has none', () => {
		expect(resizedFullArea(A, 100_000, 100_000, 0.7)).toBe(A);
		expect(resizedFullArea(A, 100_000, 0, 0.7)).toBe(0);
		expect(resizedFullArea(A, 0, 100_000, 0.7)).toBe(0);
	});

	it('is non-decreasing in capacity, and mean depth rises with it for b < 1', () => {
		let prevA = 0;
		let prevDepth = 0;
		for (let c = 10_000; c <= 400_000; c += 10_000) {
			const a = resizedFullArea(A, 100_000, c, 0.7);
			expect(a).toBeGreaterThanOrEqual(prevA);
			expect(c / a).toBeGreaterThan(prevDepth);
			prevA = a;
			prevDepth = c / a;
		}
	});
});

describe('resizeDamCurve (survey-curve dam)', () => {
	// A basin with A ∝ V^0.6 surveyed at four levels.
	const rows: DamCurvePoint[] = [
		{ levelM: 0, areaM2: 0, volumeM3: 0 },
		{ levelM: 2, areaM2: 10_000, volumeM3: 10_000 },
		{ levelM: 4, areaM2: 15_157, volumeM3: 20_000 },
		{ levelM: 6, areaM2: 23_000, volumeM3: 40_000 }
	];
	const areaAt = (r: DamCurvePoint[]) => r.at(-1)!.areaM2;

	it('at its own top the curve is unchanged', () => {
		const r = resizeDamCurve(rows, 40_000, 0.7);
		expect(r.extrapolated).toBe(false);
		expect(r.rows).toEqual(rows);
	});

	it('a smaller dam is the curve cut at the new top, interpolated as the run interpolates it (exact)', () => {
		const r = resizeDamCurve(rows, 30_000, 0.7);
		expect(r.extrapolated).toBe(false);
		expect(r.rows.slice(0, 3)).toEqual(rows.slice(0, 3));
		expect(r.rows.at(-1)).toEqual({ volumeM3: 30_000, areaM2: 15_157 + 0.5 * (23_000 - 15_157), levelM: 5 });
		// Below the first surveyed row: the anchor at an empty dam.
		const small = resizeDamCurve(rows.slice(1), 5_000, 0.7);
		expect(small.rows).toEqual([{ volumeM3: 5_000, areaM2: 5_000, levelM: NaN }]);
	});

	it('a larger dam carries the curve beyond its top with the power law through its top two rows, and says so', () => {
		const r = resizeDamCurve(rows, 80_000, 0.7);
		expect(r.extrapolated).toBe(true);
		const b = Math.log(23_000 / 15_157) / Math.log(2);
		expect(r.exponent).toBeCloseTo(b, 12);
		expect(r.rows.slice(0, 4)).toEqual(rows);
		expect(areaAt(r.rows)).toBeCloseTo(23_000 * 2 ** b, 6);
		// Level: 6 m + ∫ dV / A along the power law; about ΔV ÷ the mean area.
		const top = r.rows.at(-1)!;
		expect(top.levelM).toBeGreaterThan(6 + 40_000 / areaAt(r.rows));
		expect(top.levelM).toBeLessThan(6 + 40_000 / 23_000);
		// A curve with one row that has a surface takes the dam's own exponent.
		expect(resizeDamCurve(rows.slice(0, 2), 20_000, 0.7).exponent).toBe(0.7);
		// A flat top stops growing (b = 0).
		expect(topExponent([10, 20], [5, 5], 0.7)).toBe(0);
	});

	it('the full-supply area is non-decreasing in capacity, through the survey top and beyond', () => {
		let prev = 0;
		for (let c = 1_000; c <= 160_000; c += 1_000) {
			const a = areaAt(resizeDamCurve(rows, c, 0.7).rows);
			expect(a).toBeGreaterThanOrEqual(prev);
			prev = a;
		}
	});
});
