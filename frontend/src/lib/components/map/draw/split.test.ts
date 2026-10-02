// Splitting a polygon along a line (split.ts; issue #326 C2).
import { describe, expect, it } from 'vitest';
import type { MapPosition } from '$lib/api/types';
import { insideRing, splitPolygon } from './split';

/** A 0.1° square, corners anticlockwise from the south-west. */
const square: MapPosition[] = [
	[21.3, -33.7],
	[21.4, -33.7],
	[21.4, -33.6],
	[21.3, -33.6]
];

/** Twice the planar area, unsigned. */
const area = (c: readonly MapPosition[]) => Math.abs(c.reduce((s, a, i) => s + a[0] * c[(i + 1) % c.length]![1] - c[(i + 1) % c.length]![0] * a[1], 0)) / 2;

function parts(r: ReturnType<typeof splitPolygon>) {
	if ('problem' in r) throw new Error(r.problem);
	return r.parts;
}

describe('splitPolygon', () => {
	it('cuts a square in two along a straight line drawn across it, the parts adding up to the whole', () => {
		const [a, b] = parts(
			splitPolygon(square, [
				[21.35, -33.75],
				[21.35, -33.55]
			])
		);
		expect(area(a) + area(b)).toBeCloseTo(area(square), 12);
		expect(area(a)).toBeCloseTo(area(square) / 2, 12);
		// Both parts hold the cut's two ends, exactly.
		for (const p of [a, b]) {
			expect(p).toContainEqual([21.35, -33.7]);
			expect(p).toContainEqual([21.35, -33.6]);
		}
	});

	it('keeps a bent cut’s inner points in both parts, so they share the whole cut', () => {
		const [a, b] = parts(
			splitPolygon(square, [
				[21.25, -33.65],
				[21.35, -33.65],
				[21.36, -33.62],
				[21.45, -33.62]
			])
		);
		expect(a).toContainEqual([21.36, -33.62]);
		expect(b).toContainEqual([21.36, -33.62]);
		expect(area(a) + area(b)).toBeCloseTo(area(square), 12);
	});

	it('takes a line whose ends sit on the edge (snapped there), a hair short of it after rounding', () => {
		const [a, b] = parts(
			splitPolygon(square, [
				[21.3000001, -33.65],
				[21.4, -33.6500001]
			])
		);
		expect(area(a) + area(b)).toBeCloseTo(area(square), 9);
		expect(Math.min(area(a), area(b)) / area(square)).toBeGreaterThan(0.49);
	});

	it('cuts through a corner: that corner is in both parts once', () => {
		const [a, b] = parts(
			splitPolygon(square, [
				[21.25, -33.75],
				[21.45, -33.55]
			])
		);
		expect(a).toHaveLength(3);
		expect(b).toHaveLength(3);
		expect(area(a)).toBeCloseTo(area(b), 12);
	});

	it('cuts a concave shape across its waist', () => {
		// An L: the cut crosses the narrow arm.
		const l: MapPosition[] = [
			[0, 0],
			[3, 0],
			[3, 1],
			[1, 1],
			[1, 3],
			[0, 3]
		];
		const [a, b] = parts(
			splitPolygon(l, [
				[-1, 2],
				[2, 2]
			])
		);
		expect(area(a) + area(b)).toBeCloseTo(area(l), 12);
		expect([area(a), area(b)].sort()).toEqual([1, 4]);
	});

	it('refuses a line that doesn’t cross the shape, that only goes in, or that crosses more than twice', () => {
		expect(splitPolygon(square, [[21.31, -33.65], [21.32, -33.65]])).toEqual({ problem: expect.stringContaining('right across the shape') });
		expect(splitPolygon(square, [[21.25, -33.65], [21.35, -33.65]])).toEqual({ problem: expect.stringContaining('right across the shape') });
		expect(
			splitPolygon(square, [
				[21.25, -33.65],
				[21.45, -33.65],
				[21.45, -33.62],
				[21.25, -33.62]
			])
		).toEqual({ problem: 'The line crosses the shape’s edge 4 times. Split it one cut at a time: a line that goes in once and comes out once.' });
	});

	it('refuses two ends on the edge joined outside the shape', () => {
		expect(
			splitPolygon(square, [
				[21.3, -33.65],
				[21.25, -33.65],
				[21.25, -33.75],
				[21.35, -33.75],
				[21.35, -33.7]
			])
		).toEqual({ problem: expect.stringContaining('runs outside the shape') });
	});

	it('refuses a cut along an edge: it meets the edge but leaves no area on one side', () => {
		const r = splitPolygon(square, [
			[21.3, -33.75],
			[21.3, -33.55]
		]);
		expect('problem' in r).toBe(true);
	});
});

describe('insideRing', () => {
	it('says inside and outside', () => {
		expect(insideRing([21.35, -33.65], square)).toBe(true);
		expect(insideRing([21.45, -33.65], square)).toBe(false);
	});
});
